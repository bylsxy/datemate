import test from 'node:test';
import assert from 'node:assert/strict';
import { planDate, verifyPlanWitness } from '../engine.mjs';
import { createExploration } from '../exploration.mjs';
import { catalog } from '../data/catalog.mjs';
import { defaultContext } from '../planner.mjs';
import { defaultPreparationResources } from '../preparation.mjs';
import { normalizePeriods } from '../time-periods.mjs';
import { selectDepartureIntent } from '../planning-intent.mjs';

const fast = { maxCandidateExpandedNodes: 0 };
const context = (change = {}) => ({ ...defaultContext(), ...defaultPreparationResources(catalog), ...change,
  ...normalizePeriods(change.periodIds ?? ['afternoon']), explorationSeed: 'diversity-baseline' });
const route = r => r.stages.map(s => s.sceneId).join('/');
const checked = (input, options = fast, data = catalog) => {
  const r = planDate(input, data, options);
  assert.equal(r.ok, true, r.errors.join(';'));
  assert.equal(r.metrics.periodCoverageSatisfied, true);
  assert.equal(r.metrics.reserveSatisfied, true);
  assert.ok(r.search.expandedNodes <= r.search.maxExpandedNodes);
  return r;
};

test('真实默认下午自动推荐包含体验；用户固定裸商场仍合法', () => {
  const input = context();
  const automatic = checked(input);
  assert.ok(automatic.stages.some(s => s.activityIds.length), '默认兴趣为空不应使所有玩法只有成本');
  const manual = checked({ ...input, fixedPrefix: [{ sceneId: 'mall', activityIds: [], durationMinutes: 175 }], endAfterStage: 0 });
  assert.deepEqual(manual.stages[0].activityIds, []);
  assert.equal(manual.stages[0].minutes, 175);
});

test('真实停留效用递减，不能把地点匹配按小时重复计分', () => {
  const base = { ...context(), endAfterStage: 0 };
  const short = checked({ ...base, fixedPrefix: [{ sceneId: 'mall', activityIds: ['arcade_claw'], durationMinutes: 60 }] });
  const long = checked({ ...base, fixedPrefix: [{ sceneId: 'mall', activityIds: ['arcade_claw'], durationMinutes: 180 }] });
  assert.ok(long.metrics.objective > short.metrics.objective);
  assert.ok(long.metrics.objective - short.metrics.objective < 90, '额外两小时只增加递减停留收益与覆盖，不翻倍地点契合');
});

test('真实全天100跨种子可探索不同路线且梦幻硬预算保持有效', () => {
  const base = context({ periodIds: ['morning', 'afternoon', 'evening'], area: 'all', season: 'holiday',
    relationship: 'longterm', occasion: 'birthday', weather: 'clear', budget: 6000, exploration: 100 });
  const results = ['diversity-baseline', 'alpha', 'beta', 'gamma'].map(explorationSeed => checked({ ...base, explorationSeed }));
  assert.ok(new Set(results.map(route)).size >= 3, '不应只是相同图书馆路线切换活动');
  assert.ok(results.some(r => r.stages.some(s => catalog.scenes.find(scene => scene.id === s.sceneId).dreamOnly)));
  for (const r of results) {
    assert.ok(r.totalCost[1] <= 6000);
    assert.ok(r.stages.some(s => s.activityIds.length));
  }
  const cheap = checked({ ...base, budget: 2000 });
  assert.ok(cheap.totalCost[1] <= 2000);
  assert.ok(!cheap.stages.some(s => catalog.scenes.find(scene => scene.id === s.sceneId).dreamOnly));
  const best = checked({ ...base, budget: null }, { ...fast, selectionMode: 'utility_best' });
  assert.ok(best.stages.some(s => catalog.scenes.find(scene => scene.id === s.sceneId).dreamOnly), '真实目标应支持梦幻体验，无需依赖选择噪声');
});

test('考试季单时段可提前结束，多时段和明确预约不放宽覆盖', () => {
  const exam = checked(context({ season: 'exam' }));
  assert.ok(exam.metrics.activeMinutes <= 30);
  assert.ok(exam.stages.at(-1).end < 900);
  const short = [{ sceneId: 'campus_exam_short_meet', activityIds: [], durationMinutes: 15 }];
  const ordinary = verifyPlanWitness(context(), catalog, { ...fast, knownPlan: short });
  assert.equal(ordinary.ok, false);
  assert.match(ordinary.errors.join(';'), /H_END_COVERAGE/);
  const anchored = verifyPlanWitness({ ...context({ season: 'exam' }), anchors: [{ id: 'fixed', choice: short[0], index: 0 }] }, catalog,
    { ...fast, knownPlan: [{ ...short[0], anchorId: 'fixed' }] });
  assert.equal(anchored.ok, false);
  assert.match(anchored.errors.join(';'), /H_END_COVERAGE/);
  const multi = verifyPlanWitness(context({ season: 'exam', periodIds: ['afternoon', 'evening'] }), catalog, { ...fast, knownPlan: short });
  assert.equal(multi.ok, false);
  assert.match(multi.errors.join(';'), /H_PERIOD_COVERAGE/);
});

test('真实夜间自动停留保留分别选择空间，切换露营和一起走不修改阶段', () => {
  const ctx = context({ periodIds: ['evening', 'night'], reunion: true, relationship: 'passionate', occasion: 'anniversary', budget: 500 });
  const state = { context: ctx, exploration: 100, prefix: [], anchors: [] };
  const result = checked({ ...ctx, exploration: 100 });
  for (const id of ['camping', 'walk_together']) {
    assert.equal(result.departure.candidates.find(d => d.id === id).available, true);
    const next = selectDepartureIntent(state, result, id, catalog);
    const switched = checked({ ...next.context, exploration: next.exploration, fixedPrefix: next.prefix, anchors: next.anchors });
    assert.deepEqual(switched.stages.map(s => [s.sceneId, s.activityIds, s.minutes]), result.stages.map(s => [s.sceneId, s.activityIds, s.minutes]));
    assert.equal(switched.departure.id, id);
  }
});

test('较长分别方式无空间时自动推荐退回所选方式；人工固定时长不被缩短', () => {
  const data = { ...catalog, scenes: [{ id: 'tight', kind: 'ordinary', area: 'current', minutes: 200,
    durationRange: [200, 200], cost: [0, 0], load: 0, fit: 80, activities: [] }] };
  const ctx = context({ reserve: 15, robust: false });
  const result = checked(ctx, fast, data);
  assert.equal(result.stages[0].minutes, 200);
  assert.equal(result.departure.candidates.find(d => d.id === 'walk_together').available, false);
  const manual = checked({ ...ctx, fixedPrefix: [{ sceneId: 'tight', activityIds: [], durationMinutes: 200 }] }, fast, data);
  assert.equal(manual.stages[0].minutes, 200);
});

test('重复允许但真实效用软减重复玩法；探索择优槽保留不同地点', () => {
  const prefix = [{ sceneId: 'mall', activityIds: ['arcade_claw'], durationMinutes: 60 },
    { sceneId: 'mall', activityIds: ['arcade_claw'], durationMinutes: 60 }];
  const result = checked({ ...context(), fixedPrefix: prefix, endAfterStage: 1 });
  assert.equal(result.stages[1].featureContributions.repeatedActivityPenalty, -10);
  assert.equal(result.stages[1].featureContributions.repeatScenePenalty, -36);
  const choices = [{ id: 'a-1', scene: 'a', utility: 100 }, { id: 'a-2', scene: 'a', utility: 99 },
    { id: 'b', scene: 'b', utility: 95 }, { id: 'c', scene: 'c', utility: 90 }];
  const select = createExploration(100, 'beam-diversity').select(choices, 2,
    { key: x => x.id, value: x => x.utility, bucket: x => x.scene, scope: 'test', elite: 1 });
  assert.equal(select[0], choices[0]);
  assert.equal(select[1].scene, 'b');
});

test('小子集上限也保留排序前部玩法及其前置', () => {
  const activities = [
    { id: 'a-interest', tags: ['creative'], predecessorIds: ['b-prep'], load: 0 },
    { id: 'b-prep', load: 0 }, { id: 'c-idle', load: 0 }, { id: 'd-idle', load: 0 },
  ];
  const data = { scenes: [{ id: 'workshop', kind: 'creative', area: 'campus', minutes: 60, cost: [0, 0], load: 0, fit: 80, activities }] };
  const r = planDate({ duration: 100, reserve: 0, robust: false, preferencesA: ['creative'], preferencesB: ['creative'] }, data,
    { ...fast, maxStages: 1, activitySubsetLimit: 4 });
  assert.equal(r.ok, true, r.errors.join(';'));
  assert.ok(r.stages[0].activityIds.includes('a-interest'));
  assert.ok(r.stages[0].activityIds.includes('b-prep'));
});

test('四时段普通模式回归：节点上限内找到并独立重演完整方案', () => {
  const cases = [
    { weather: 'clear', area: 'all', school: 'scau', campusArea: 'taishan' },
    { weather: 'rain', area: 'near', school: 'scau', campusArea: 'taishan' },
    { weather: 'rain', area: 'all' },
    { weather: 'unknown', area: 'all', school: 'scau' },
  ];
  for (const change of cases) {
    // 基本可行性调用没有UI默认准备资源，不能用补充资源掩盖搜索回归。
    const input = { fatigueA: 2, fatigueB: 2, robust: true,
      periodIds: ['morning', 'afternoon', 'evening', 'night'], ...change };
    const r = checked(input);
    assert.equal(r.search.maxExpandedNodes, 18000);
    assert.equal(r.metrics.mealSatisfied, true);
    assert.equal(r.metrics.endingCoverageSatisfied, true);
    const replay = verifyPlanWitness(input, catalog, { knownPlan: r.continuationWitness });
    assert.equal(replay.ok, true, replay.errors.join(';'));
  }
});

test('四时段100在不同预算下仍保持真实费用和完整见证', () => {
  for (const budget of [null, 2000, 6000]) {
    const input = context({ periodIds: ['morning', 'afternoon', 'evening', 'night'], area: 'all', exploration: 100, budget });
    const r = checked(input);
    assert.equal(r.search.maxExpandedNodes, 18000);
    if (budget !== null) assert.ok(r.totalCost[1] <= budget);
    assert.equal(r.metrics.mealSatisfied, true);
    assert.equal(r.metrics.endingCoverageSatisfied, true);
    const replay = verifyPlanWitness(input, catalog, { knownPlan: r.continuationWitness });
    assert.equal(replay.ok, true, replay.errors.join(';'));
  }
});
