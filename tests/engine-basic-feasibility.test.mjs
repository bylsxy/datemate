import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planDate, verifyPlanWitness } from '../engine.mjs';
import { DEFAULT_RULES, forwardChain } from '../reasoning.mjs';
import { isSceneOpenDuring } from '../scene-time.mjs';

const rules = JSON.parse(readFileSync(new URL('../knowledge/rules.json', import.meta.url))).rules;
const allDay = [{ startMinute: 0, endMinute: 1440 }];
const scene = (id, extra = {}) => ({ id, kind: 'ordinary', area: 'campus', minutes: 60, cost: [0, 0], load: 0, indoor: false, sheltered: true, quiet: true, crowdRisk: 'low', mental: 0, dailyWindows: allDay, activities: [], ...extra });
const fixture = (scenes, extra = {}) => ({ scenes, rules, departures: [{ id: 'separate', minutes: 15, cost: [0, 0] }], transfers: { campus: { campus: 10 } }, ...extra });
const ctx = { periodIds: ['night'], reserve: 15, robust: true, fatigueA: 8, fatigueB: 8, weather: 'rain', quietRequired: true, crowdAvoidance: true, mentalLow: true, budget: 0 };
const choice = (sceneId, startMinute) => ({ sceneId, activityIds: [], ...(startMinute !== undefined ? { startMinute } : {}) });

test('内置和手工雨天规则均仅排除无遮蔽室外，缺省遮蔽等价false', () => {
  for (const ruleSet of [DEFAULT_RULES, rules]) {
    for (const environment of [{ indoor: true }, { indoor: false, sheltered: true }]) {
      assert.deepEqual(forwardChain({ context: { weather: 'rain' }, scene: { id: 's', ...environment } }, ruleSet).excludedSceneIds, []);
    }
    for (const environment of [{ indoor: false }, { indoor: false, sheltered: false }]) {
      assert.deepEqual(forwardChain({ context: { weather: 'rain' }, scene: { id: 's', ...environment } }, ruleSet).excludedSceneIds, ['s']);
      assert.deepEqual(forwardChain({ context: { weather: 'unknown' }, scene: { id: 's', ...environment } }, ruleSet).excludedSceneIds, []);
    }
  }
});

test('有遮蔽户外支持雨夜零预算安静疲劳组合，候选及见证统一评估', () => {
  const source = scene('dorm');
  const data = fixture([source, scene('open-air', { sheltered: false })]);
  const result = planDate(ctx, data);
  assert.equal(result.ok, true, result.errors.join(';'));
  assert.ok(result.stages.every(s => s.sceneId === 'dorm' && s.minutes >= 60));
  assert.ok(result.stages.flatMap(s => s.candidates).every(c => c.sceneId === 'dorm'));
  assert.equal(result.totalCostCents[1], 0);
  assert.equal(result.metrics.reserveSatisfied, true);
  assert.equal(verifyPlanWitness(ctx, data, { knownPlan: result.continuationWitness }).ok, true);
  assert.equal(source.indoor, false);
});

test('显式非空天气限制在已知天气下为硬条件，unknown与空数组不假定天气', () => {
  const data = fixture([scene('clear-only', { weather: ['clear'] }), scene('rain-only', { weather: ['rain'] })]);
  for (const weather of ['clear', 'rain']) {
    const result = planDate({ ...ctx, weather }, data);
    assert.equal(result.ok, true, result.errors.join(';'));
    assert.ok(result.stages.every(s => s.sceneId === `${weather}-only`));
    const banned = weather === 'rain' ? 'clear-only' : 'rain-only';
    for (const checked of [planDate({ ...ctx, weather, fixedPrefix: [choice(banned)] }, data), verifyPlanWitness({ ...ctx, weather }, data, { knownPlan: [choice(banned, 1450)] })]) {
      assert.equal(checked.ok, false);
      assert.ok(checked.errors.some(e => e.startsWith('H_WEATHER:')));
    }
  }
  assert.equal(planDate({ ...ctx, weather: 'unknown', fixedPrefix: [choice('clear-only', 1450)] }, data, { maxStages: 1 }).ok, true);
  for (const weather of [undefined, []]) assert.equal(planDate(ctx, fixture([scene('s', { weather })])).ok, true);
  assert.equal(planDate(ctx, fixture([scene('exposed', { sheltered: false, weather: ['rain'] })])).ok, false);
});

test('避人流直接校验crowdRisk high，不依赖知识规则是否载入', () => {
  const result = planDate({ ...ctx, fixedPrefix: [choice('busy')] }, fixture([scene('busy', { crowdRisk: 'high' })], { rules: [] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith('H_CROWD:')));
});

test('同一地点连续停留及休息后继续停留不产生虚假转场，重复仍有软罚', () => {
  const data = fixture([scene('dorm'), scene('rest', { kind: 'rest', area: 'current', indoor: true, load: -6, minutes: 15 })]);
  const fixedPrefix = [choice('dorm'), choice('rest'), choice('rest'), choice('dorm')];
  const result = planDate({ ...ctx, reserve: 0, fixedPrefix }, data, { maxStages: 4 });
  assert.equal(result.ok, true, result.errors.join(';'));
  assert.deepEqual(result.stages.map(s => s.transfer), [10, 0, 0, 0]);
  assert.ok(result.stages[2].featureContributions.repeatScenePenalty < 0);
  assert.ok(result.stages[3].featureContributions.repeatScenePenalty < 0);
  assert.equal(verifyPlanWitness({ ...ctx, reserve: 0 }, data, { knownPlan: result.continuationWitness, maxStages: 4 }).ok, true);
});

test('连续休息始终继承实际地点关门边界，不能第二次休息丢失地点', () => {
  const data = fixture([scene('room', { indoor: true, dailyWindows: [{ startMinute: 1380, endMinute: 40 }] }), scene('rest', { kind: 'rest', area: 'current', indoor: true, minutes: 20, load: -6 })], { transfers: { campus: { campus: 0 } } });
  const result = planDate({ ...ctx, reserve: 0, fixedPrefix: [choice('room', 1380), choice('rest'), choice('rest'), choice('rest')] }, data);
  assert.equal(result.ok, false);
  assert.equal(result.failedStage, 3);
  assert.ok(result.errors.some(e => e.startsWith('H_SCENE_HOURS:')));
  assert.equal(planDate(ctx, fixture([scene('rest', { kind: 'rest', area: 'current', indoor: true, load: -6 })])).ok, false);
});

test('非period模式的真实绝对开放窗仍约束连续休息，旧引擎复盘拒绝', () => {
  const data = fixture([scene('room', { minutes: 20, indoor: true, windows: [{ startMinute: 0, endMinute: 60 }] }), scene('rest', { kind: 'rest', area: 'current', indoor: true, minutes: 20, load: -6 })]);
  const input = { duration: 150, reserve: 0, robust: false, fatigueA: 0, fatigueB: 0, fixedPrefix: [choice('room'), choice('rest'), choice('rest')] };
  const result = planDate(input, data);
  assert.equal(result.ok, false);
  assert.equal(result.failedStage, 2);
  assert.ok(result.errors.some(e => e.startsWith('H_TIME_WINDOW:')));
  const old = planDate({ ...ctx, expectedVersions: { engine: 'datemate-engine-3.3.3' } }, fixture([scene('dorm')]));
  assert.equal(old.ok, false);
  assert.ok(old.errors.some(e => e.startsWith('H_VERSION:')));
});

test('低疲劳连续原地休息可补足真实停留，但仍受统一天气、安静及开放窗约束', () => {
  const data = fixture([scene('room', { indoor: true, dailyWindows: [{ startMinute: 1380, endMinute: 1440 }] }), scene('rest', { kind: 'rest', area: 'current', minutes: 20, load: -6, indoor: true })]);
  const input = { ...ctx, fatigueA: 0, fatigueB: 0, reserve: 0, fixedPrefix: [choice('room', 1380)] };
  // 窗口晚于房间关门时，休息绝不能补到所选跨度尾部。
  assert.equal(planDate(input, data).ok, false);
  const alwaysOpen = fixture([scene('room', { minutes: 90, indoor: true }), scene('rest', { kind: 'rest', area: 'current', minutes: 20, load: -6, indoor: true })]);
  const result = planDate({ ...input, fixedPrefix: [choice('room')] }, alwaysOpen, { maxStages: 3 });
  assert.equal(result.ok, true, result.errors.join(';'));
  assert.ok(result.stages.some(s => s.sceneId === 'rest'));
  for (const extra of [{ quiet: false }, { indoor: false, sheltered: false }, { weather: ['clear'] }, { place: { universityId: 'scau' } }]) {
    const restricted = fixture([scene('room', extra), scene('rest', { kind: 'rest', area: 'current', indoor: true, minutes: 20, load: -6 })]);
    assert.equal(planDate({ ...ctx, fixedPrefix: [choice('room'), choice('rest')] }, restricted).ok, false);
  }
});

test('长跨度多餐仍履行硬用餐要求，重复住宿基础地点不会挤出饭点', () => {
  const roles = ['breakfast', 'lunch', 'dinner', 'supper'];
  const food = scene('food', { indoor: true, kind: 'meal', minutes: 30, mealRoles: roles, activities: roles.map(role => ({ id: `eat-${role}`, cost: [0, 0], load: 0, provides: ['meal_completed'], mealRoles: [role], mode: 'single', group: 'meal' })) });
  const data = fixture([scene('dorm'), food]);
  const input = { ...ctx, periodIds: ['morning', 'afternoon', 'evening', 'night'] };
  const result = planDate(input, data);
  assert.equal(result.ok, true, result.errors.join(';'));
  assert.deepEqual(result.stages.filter(s => s.mealRole).map(s => s.mealRole), roles);
  assert.equal(result.metrics.mealSatisfied, true);
  assert.equal(result.metrics.periodCoverageSatisfied, true);
  for (const s of result.stages) assert.equal(isSceneOpenDuring(data.scenes.find(item => item.id === s.sceneId), s.start, s.end), true);
  assert.equal(verifyPlanWitness(input, data, { knownPlan: result.continuationWitness }).ok, true);
});

test('基础候选不能吞预算、必去、否决、明确时间和负担硬限制', () => {
  const data = fixture([scene('dorm')]);
  for (const override of [
    { bans: ['dorm'] },
    { requiredSceneIds: ['missing'] },
    { availability: { dorm: 'unavailable' } },
    { fixedPrefix: [choice('dorm', 1530)] },
    { reserve: 180 },
    { fatigueA: 8, maxLoad: 7 },
  ]) assert.equal(planDate({ ...ctx, ...override }, data).ok, false);
  assert.equal(planDate(ctx, fixture([scene('paid', { cost: [1, 1] })])).ok, false);
});
