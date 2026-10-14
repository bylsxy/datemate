import test from 'node:test';
import assert from 'node:assert/strict';
import { planDate, canonical } from '../engine.mjs';

const departures = [
  { id: 'hotel', title: '酒店', minutes: 15, costByCityTier: { tier1: [200, 400], tier2: [150, 300], tier3: [100, 250] }, requiresExplicitChoice: true, onlyOvernight: true, parameterStatus: 'designed_not_measured' },
  { id: 'separate', title: '各自回去', minutes: 10, cost: [0, 0] },
  { id: 'walk_together', title: '一起走一段', minutes: 20, cost: [0, 0], requiresExplicitChoice: true },
];
const scene = (id = 'walk', extra = {}) => ({ id, minutes: 30, cost: [0, 0], load: 0, area: 'campus', kind: 'ordinary', indoor: true, quiet: true, fit: 70, activities: [], ...extra });
const fixture = (extra = {}) => ({ version: 'departure-test', scenes: [scene()], departures, transfers: { campus: { campus: 0 } }, ...extra });
// 夜间普通场景至少停留60分钟，提前预约以保持原有分别与缓冲边界。
const input = { periodIds: ['night'], reserve: 0, robust: false, fatigueA: 0, fatigueB: 0, anchors: [{ choice: { sceneId: 'walk', activityIds: [] }, startMinute: 1485, index: 0 }] };
const one = { maxStages: 1 };

function assertAccounting(result) {
  assert.equal(result.ok, true, result.errors.join(';'));
  const departure = result.departure;
  assert.equal(departure.startMinute, result.stages.at(-1).end);
  assert.equal(departure.endMinute - departure.startMinute, departure.minutes);
  assert.ok(departure.endMinute <= result.context.windows.at(-1).endMinute);
  assert.ok(departure.reservedMinutes >= 15);
  assert.equal(result.metrics.totalMinutes, result.stages.reduce((n, s) => n + s.minutes + s.transfer + s.wait, 0) + departure.minutes);
  const total = [0, 1].map(i => result.stages.reduce((n, s) => n + s.costCents[i], 0) + departure.costCents[i]);
  assert.deepEqual(result.totalCostCents, total);
  assert.deepEqual(result.metrics.totalCostCents, total);
  assert.deepEqual(result.totalCost, total.map(n => n / 100));
  assert.equal(result.metrics.endingBuffer, result.context.windows.at(-1).endMinute - departure.endMinute);
  assert.equal(result.metrics.reserveSatisfied, true);
  assert.ok(result.stages.every(s => !['hotel', 'separate', 'walk_together'].includes(s.sceneId)));
}

test('默认各自回去独立于地点，保留15分钟预留而不伪增目录时长', () => {
  const result = planDate(input, fixture(), one);
  assertAccounting(result);
  assert.equal(result.departure.id, 'separate');
  assert.equal(result.departure.minutes, 10);
  assert.equal(result.departure.reservedMinutes, 15);
  assert.equal(result.stages[0].minutes, 60);
  assert.equal(result.departure.endMinute, 1555);
  assert.equal(result.context.cityTier, 'tier1');
  assert.deepEqual(result.departure.costCents, [0, 0]);
});

test('酒店只可手动选择且跨度跨午夜，探索度和目录顺序不能自动选酒店', () => {
  for (const exploration of [0, 100]) {
    const result = planDate({ ...input, exploration }, fixture(), one);
    assert.equal(result.departure.id, 'separate');
    assert.ok(result.departure.candidates.some(c => c.id === 'hotel'));
  }
  const early = planDate({ periodIds: ['afternoon'], departureChoice: 'hotel' }, fixture());
  assert.equal(early.status, 'invalid_input');
  assert.match(early.errors.join(), /H_DEPARTURE_OVERNIGHT/);
  const defaultDay = planDate({ periodIds: ['afternoon'], reserve: 0, robust: false }, fixture());
  assert.equal(defaultDay.ok, true);
  assert.ok(defaultDay.departure.candidates.every(c => c.id !== 'hotel'));
  for (const bad of [{ departureChoice: 'other' }, { cityTier: 'tier4' }]) assert.equal(planDate({ ...input, ...bad }, fixture()).status, 'invalid_input');
});

test('一二三线设计房费来自目录，总费用及剩余预算包含房费', () => {
  const expected = { tier1: [20000, 40000], tier2: [15000, 30000], tier3: [10000, 25000] };
  for (const cityTier of Object.keys(expected)) {
    const result = planDate({ ...input, departureChoice: 'hotel', cityTier, budget: expected[cityTier][1] / 100 }, fixture(), one);
    assertAccounting(result);
    assert.deepEqual(result.departure.costCents, expected[cityTier]);
    assert.deepEqual(result.totalCostCents, expected[cityTier]);
    assert.equal(result.metrics.remainingBudgetCents, 0);
    assert.ok(result.assumptions.some(s => /设计区间.*并非实际房价/.test(s)));
    assert.ok(result.paretoPlans.every(p => p.departure.id === 'hotel' && p.metrics.totalCostCents[1] === expected[cityTier][1]));
  }
});

test('房费上界先参与搜索，不能先花光预算再附加酒店；失败仍能换免费分别', () => {
  const c = fixture({ scenes: [scene('walk', { cost: [50, 50] })] });
  const enough = planDate({ ...input, departureChoice: 'hotel', budget: 450 }, c, one);
  assertAccounting(enough);
  assert.deepEqual(enough.totalCostCents, [25000, 45000]);
  assert.equal(enough.stages[0].before.remainingBudgetCents, 5000);
  const rejected = planDate({ ...input, departureChoice: 'hotel', budget: 449.99 }, c, one);
  assert.equal(rejected.status, 'no_plan_found');
  assert.ok(rejected.search.constraintRejections.H_BUDGET > 0);
  assert.equal(rejected.departure.id, 'hotel');
  assert.equal(rejected.departure.planned, false);
  assert.equal(rejected.departure.startMinute, null);
  assert.ok(rejected.departure.candidates.some(c => c.id === 'separate' && c.available));
  const recovered = planDate({ ...input, departureChoice: 'separate', budget: 50 }, c, one);
  assertAccounting(recovered);
  assert.deepEqual(recovered.totalCostCents, [5000, 5000]);
});

test('固定尾段和鲁棒缓冲必须给分别时间留位置；不能落在跨度以外', () => {
  const request = { ...input, departureChoice: 'hotel' };
  assertAccounting(planDate(request, fixture(), one));
  const noRoom = planDate({ ...request, reserve: 1 }, fixture(), one);
  assert.equal(noRoom.status, 'no_plan_found');
  assert.ok(noRoom.search.constraintRejections.H_TIME_WINDOW > 0);
  const walkTooLong = planDate({ ...input, departureChoice: 'walk_together' }, fixture(), one);
  assert.equal(walkTooLong.status, 'no_plan_found');
  const earlier = { ...input, departureChoice: 'walk_together', anchors: [{ ...input.anchors[0], startMinute: 1480 }] };
  const walked = planDate(earlier, fixture(), one);
  assertAccounting(walked);
  assert.equal(walked.departure.endMinute, 1560);
});

test('饭点菜单同样预留房费，不能展示已被酒店耗尽预算的付费用餐为合法', () => {
  const c = fixture({ scenes: [scene(), scene('food', { kind: 'meal', cost: [50, 50], mealRoles: ['supper'], activities: [{ id: 'eat', provides: ['meal_completed'], mealRoles: ['supper'], cost: [0, 0], load: 0 }] })] });
  const result = planDate({ periodIds: ['evening', 'night'], reserve: 0, robust: false, departureChoice: 'hotel', budget: 400, mealChoices: { supper: { mode: 'skip' } } }, c);
  assertAccounting(result);
  assert.deepEqual(result.mealRequirements[0].candidates, []);
  const needsFood = planDate({ periodIds: ['evening', 'night'], reserve: 0, robust: false, departureChoice: 'hotel', budget: 400 }, c);
  assert.equal(needsFood.status, 'no_plan_found');
  assert.ok(needsFood.search.constraintRejections.H_BUDGET > 0);
});

test('房费与活动费用使用整数分，0.1+0.2预算边界精确', () => {
  const c = fixture({ scenes: [scene('walk', { cost: [0.1, 0.1] })], departures: departures.map(d => d.id === 'hotel' ? { ...d, costByCityTier: { tier1: [0.2, 0.2], tier2: [0.2, 0.2], tier3: [0.2, 0.2] } } : d) });
  const result = planDate({ ...input, departureChoice: 'hotel', budget: 0.3 }, c, one);
  assertAccounting(result);
  assert.deepEqual(result.totalCostCents, [30, 30]);
  assert.equal(planDate({ ...input, departureChoice: 'hotel', budget: 0.29 }, c, one).status, 'no_plan_found');
});

test('切换分别方式可还原，输入及目录不变，房费修订使复盘失效', () => {
  const c = fixture();
  const savedCatalog = canonical(c), savedInput = canonical(input);
  const initial = planDate(input, c, one);
  const hotel = planDate({ ...input, departureChoice: 'hotel' }, c, one);
  const restored = planDate(input, c, one);
  assertAccounting(hotel);
  assert.equal(initial.outputFingerprint, restored.outputFingerprint);
  assert.equal(canonical(initial), canonical(restored));
  assert.equal(canonical(c), savedCatalog);
  assert.equal(canonical(input), savedInput);
  const revised = structuredClone(c);
  revised.departures[0].costByCityTier.tier1[1]++;
  const stale = planDate({ ...input, expectedVersions: initial.versions }, revised, one);
  assert.equal(stale.status, 'invalid_input');
  assert.match(stale.errors.join(), /H_VERSION/);
});

test('旧windows不需要分别目录，不产生分别对象或新增费用时间', () => {
  const c = fixture();
  delete c.departures;
  const result = planDate({ windows: [{ startMinute: 1380, endMinute: 1560 }], reserve: 0, robust: false }, c, one);
  assert.equal(result.ok, true);
  assert.equal(result.departure, undefined);
  assert.equal(result.metrics.departureMinutes, 0);
  assert.equal(result.metrics.totalMinutes, result.stages[0].minutes + result.stages[0].transfer);
});

test('时段模式缺失目录、负房费或无效时长明确作为数据错误', () => {
  for (const bad of [undefined, departures.map(d => d.id === 'hotel' ? { ...d, costByCityTier: { tier1: [-1, 1] } } : d), departures.map(d => d.id === 'separate' ? { ...d, minutes: 0 } : d)]) {
    const result = planDate(input, fixture({ departures: bad }), one);
    assert.equal(result.status, 'invalid_data');
    assert.match(result.errors.join(), /H_DEPARTURE_DATA/);
  }
});
