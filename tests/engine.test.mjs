import test from 'node:test';
import assert from 'node:assert/strict';
import { planDate, createPlanner, canonical, normalize } from '../engine.mjs';
import { catalog, rules, graph } from '../data/catalog.mjs';

const scene = (id, extra = {}) => ({ id, title: id, minutes: 20, cost: [0, 0], load: 1, kind: id, area: 'campus', indoor: true, quiet: true, fit: 70, novelty: 30, tags: [], activities: [], ...extra });
const activity = (id, extra = {}) => ({ id, minutes: 5, cost: [0, 0], load: 1, group: 'optional', mode: 'multiple', novelty: 40, ...extra });
const data = scenes => ({ version: 'test-v1', scenes });
const context = { duration: 150, reserve: 0, robust: false, fatigueA: 0, fatigueB: 0 };
const fullCatalog = { ...catalog, rules, graph };
const realContext = { windows: [{ id: 'pm', startMinute: 840, endMinute: 1020 }], preparedIds: ['water', 'phone_camera', 'picnic_mat', 'racket', 'ball', 'opening_checked', 'craft_kit', 'closed_shoes', 'badminton_kit', 'court_checked'] };

test('同场景选0、1、3活动起止时间固定，费用、负担与资源仍逐项核算', () => {
  const c = data([scene('mall', { minutes: 25, cost: [1, 2], load: 1, activities: [activity('play', { minutes: 15, cost: [3, 5], load: 3 }), activity('buy', { minutes: 100, cost: [2, 4], load: 1, consumes: ['water'], provides: ['kit'] }), activity('craft', { minutes: 200, cost: [1, 3], load: 1, predecessorIds: ['buy'], consumes: ['kit'] })] })]);
  const input = { ...context, resources: { water: 1 } };
  const empty = planDate({ ...input, fixedPrefix: [{ sceneId: 'mall', activityIds: [] }] }, c, { maxStages: 1 });
  const selected = planDate({ ...input, fixedPrefix: [{ sceneId: 'mall', activityIds: ['play'] }] }, c, { maxStages: 1 });
  const three = planDate({ ...input, fixedPrefix: [{ sceneId: 'mall', activityIds: ['play', 'buy', 'craft'] }] }, c, { maxStages: 1 });
  assert.equal(three.ok, true);
  assert.equal(empty.stages[0].minutes, 25);
  assert.equal(selected.stages[0].minutes, 25);
  assert.equal(three.stages[0].minutes, 25);
  for (const result of [selected, three]) {
    assert.equal(result.stages[0].start, empty.stages[0].start);
    assert.equal(result.stages[0].end, empty.stages[0].end);
    assert.equal(result.metrics.totalMinutes, empty.metrics.totalMinutes);
    assert.ok(result.stages[0].schedule.every(s => s.compositionMode === 'within_scene' && s.startOffset === 0 && s.endOffset === 25));
  }
  assert.deepEqual(empty.totalCostCents, [100, 200]);
  assert.deepEqual(selected.totalCostCents, [400, 700]);
  assert.deepEqual(three.totalCostCents, [700, 1400]);
  assert.deepEqual(empty.stages[0].after.fatigue, [1, 1]);
  assert.deepEqual(selected.stages[0].after.fatigue, [4, 4]);
  assert.deepEqual(three.stages[0].after.fatigue, [6, 6]);
  assert.equal(empty.stages[0].after.resources.water, 1);
  assert.equal(three.stages[0].after.resources.water, 0);
  assert.equal(three.stages[0].after.resources.kit, 0);
  assert.equal(selected.stages[0].candidates.find(x => x.sceneId === 'mall').activityIds[0], 'play');
});

test('取消多活动重新计算，而非残留费用与负担', () => {
  const c = data([scene('mall', { activities: [activity('play', { load: 4, cost: [10, 20] }), activity('walk', { load: 3 })] }), scene('rest', { kind: 'rest', load: -6, area: 'current' }), scene('next')]);
  const planner = createPlanner(c);
  const withActivities = planner.plan(context, 0, [{ sceneId: 'mall', activityIds: ['play', 'walk'] }]);
  const cleared = planner.plan(context, 0, [{ sceneId: 'mall', activityIds: [] }]);
  assert.deepEqual(withActivities.stages[0].after.fatigue, [8, 8]);
  assert.deepEqual(cleared.stages[0].after.fatigue, [1, 1]);
  assert.deepEqual(cleared.stages[0].costCents, [0, 0]);
  assert.equal(withActivities.stages[1].sceneId, 'rest');
  assert.ok(withActivities.stages.slice(2).some(s => s.sceneId === 'next'));
  assert.ok(!withActivities.stages.some((s, i) => i && s.sceneId === 'rest' && withActivities.stages[i - 1].sceneId === 'rest'));
});

test('单选、互斥、依赖缺失和循环都被独立精确拒绝', () => {
  const c = data([scene('s', { activities: [activity('a', { mode: 'single', group: 'g' }), activity('b', { mode: 'single', group: 'g' }), activity('x', { predecessorIds: ['y'] }), activity('y', { predecessorIds: ['x'] }), activity('m1', { exclusiveKey: 'main_meal' }), activity('m2', { exclusiveKey: 'main_meal' })] })]);
  for (const ids of [['a', 'b'], ['x'], ['x', 'y'], ['m1', 'm2']]) assert.equal(planDate({ ...context, fixedPrefix: [{ sceneId: 's', activityIds: ids }] }, c).ok, false);
});

test('固定人工组合不在活动子集枚举中仍接受精确校验', () => {
  const c = data([scene('s', { activities: [activity('a'), activity('b'), activity('c')] })]);
  const result = planDate({ ...context, fixedPrefix: [{ sceneId: 's', activityIds: ['a', 'b', 'c'] }] }, c, { maxStages: 1, activitySubsetLimit: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.stages[0].activityIds, ['a', 'b', 'c']);
  assert.equal(result.search.activitySubsetsTruncated, true);
});

test('顺序、包含与并行活动均在固定场景内，保留依赖顺序而不增加时长', () => {
  const c = data([scene('s', { minutes: 30, activities: [activity('included', { compositionMode: 'included', minutes: 15, load: 0 }), activity('parallel', { compositionMode: 'parallel', minutes: 40, load: 0 }), activity('after', { predecessorIds: ['parallel'], minutes: 10, load: 0 })] })]);
  const result = planDate({ ...context, fixedPrefix: [{ sceneId: 's', activityIds: ['included', 'parallel', 'after'] }] }, c, { maxStages: 1 });
  assert.equal(result.ok, true);
  const stage = result.stages[0];
  assert.equal(stage.minutes, 30);
  assert.equal(stage.end - stage.start, 30);
  assert.ok(stage.schedule.every(s => s.compositionMode === 'within_scene' && s.startOffset === 0 && s.endOffset === 30));
  assert.ok(stage.schedule.find(s => s.activityId === 'after').order > stage.schedule.find(s => s.activityId === 'parallel').order);
});

test('采购→后续使用→消耗资源跨阶段生效，缺准备时不得假定已准备', () => {
  const c = data([scene('buy', { activities: [activity('purchase', { provides: ['pack'], load: 0 })] }), scene('picnic', { requires: ['pack'], activities: [activity('share', { consumes: ['pack'], load: 0 })] }), scene('again', { requires: ['pack'] })]);
  const prefix = [{ sceneId: 'buy', activityIds: ['purchase'] }, { sceneId: 'picnic', activityIds: ['share'] }];
  const result = planDate({ ...context, fixedPrefix: prefix }, c, { maxStages: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.stages[0].after.resources.pack, 1);
  assert.equal(result.stages[1].after.resources.pack, 0);
  assert.equal(planDate({ ...context, fixedPrefix: [...prefix, { sceneId: 'again', activityIds: [] }] }, c).ok, false);
  assert.equal(planDate({ ...context, fixedPrefix: [{ sceneId: 'picnic', activityIds: [] }] }, c).ok, false);
});

test('前序完成活动可满足另一个场景的前置活动', () => {
  const c = data([scene('photo', { activities: [activity('photo_pair', { load: 0 })] }), scene('print', { requires: ['photo_pair'], activities: [activity('photo_print', { predecessorIds: ['photo_pair'], load: 0 })] })]);
  const result = planDate({ ...context, fixedPrefix: [{ sceneId: 'photo', activityIds: ['photo_pair'] }, { sceneId: 'print', activityIds: ['photo_print'] }] }, c, { maxStages: 2 });
  assert.equal(result.ok, true);
});

test('整数分避免0.1+0.2浮点边界溢出，费用上界为硬约束', () => {
  const c = data([scene('s', { cost: [0.1, 0.1], activities: [activity('a', { cost: [0.2, 0.2] })] })]);
  const prefix = [{ sceneId: 's', activityIds: ['a'] }];
  assert.equal(planDate({ ...context, budget: 0.3, fixedPrefix: prefix }, c).ok, true);
  const bad = planDate({ ...context, budget: 0.29, fixedPrefix: prefix }, c);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /H_BUDGET/);
});

test('多窗口不在间隔中安排，窗口允许分别安排正餐', () => {
  const c = data([scene('mealA', { kind: 'meal', minutes: 30, load: 0 }), scene('mealB', { kind: 'meal', minutes: 30, load: 0 })]);
  const input = { ...context, duration: 120, windows: [{ id: 'lunch', startMinute: 660, endMinute: 720 }, { id: 'dinner', startMinute: 1080, endMinute: 1140 }], fixedPrefix: [{ sceneId: 'mealA', activityIds: [] }, { sceneId: 'mealB', activityIds: [] }] };
  const result = planDate(input, c, { maxStages: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.stages[1].windowId, 'dinner');
  assert.ok(result.stages.every(s => input.windows.some(w => s.start >= w.startMinute && s.end <= w.endMinute)));
  assert.equal(result.metrics.totalMinutes, 80);
});

test('后续锚点固定时间与序号，不能被前序活动挤占', () => {
  const c = data([scene('early', { minutes: 20 }), scene('appointment', { minutes: 30 })]);
  const result = planDate({ ...context, duration: 180, windows: [{ id: 'pm', startMinute: 840, endMinute: 1020 }], fixedPrefix: [{ sceneId: 'early', activityIds: [] }], anchors: [{ id: 'booking', choice: { sceneId: 'appointment', activityIds: [] }, startMinute: 930, windowId: 'pm', index: 1 }] }, c, { maxStages: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.stages[1].start, 930);
  assert.equal(result.stages[1].anchorId, 'booking');
  const conflict = planDate({ ...context, fixedPrefix: [{ sceneId: 'early', activityIds: [] }], anchors: [{ choice: { sceneId: 'appointment', activityIds: [] }, index: 0 }] }, c);
  assert.equal(conflict.ok, false);
});

test('锚点无index按指定未来顺序保留，不能默默丢弃', () => {
  const c = data([scene('a'), scene('b')]);
  const result = planDate({ ...context, anchors: [{ id: 'first', choice: { sceneId: 'b', activityIds: [] } }, { id: 'second', choice: { sceneId: 'a', activityIds: [] } }] }, c, { maxStages: 2 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.stages.map(s => s.sceneId), ['b', 'a']);
  assert.equal(result.metrics.anchorsSatisfied, true);
});

test('鲁棒预留只能收紧可行域，探索不能抵消硬约束', () => {
  const c = data([scene('outdoor', { indoor: false, minutes: 40, novelty: 100 }), scene('indoor', { minutes: 40 })]);
  const flexible = planDate({ ...context, duration: 50, robust: false }, c, { maxStages: 1 });
  const robust = planDate({ ...context, duration: 50, robust: true }, c, { maxStages: 1 });
  assert.ok(flexible.stages[0].candidates.some(s => s.sceneId === 'outdoor'));
  assert.ok(!robust.stages[0].candidates.some(s => s.sceneId === 'outdoor'));
  const rainy = planDate({ ...context, weather: 'rain', exploration: 100 }, c);
  assert.ok(rainy.stages.every(s => s.sceneId !== 'outdoor'));
});

test('图谱多跳实际进入双方偏好特征和排序，共享兴趣与公平性可解释', () => {
  const c = { ...data([scene('a', { fit: 70 }), scene('b', { fit: 70 })]), graph: { edges: [{ id: 'e1', subject: 'b', predicate: 'supports', object: 'mechanism', evidenceIds: ['E1'] }, { id: 'e2', subject: 'mechanism', predicate: 'matches', object: 'preference:music', evidenceIds: ['E2'] }] } };
  const result = planDate({ ...context, preferencesA: ['music'], preferencesB: ['music'] }, c, { maxStages: 1 });
  assert.equal(result.stages[0].sceneId, 'b');
  assert.equal(result.stages[0].featureContributions.sharedInterest, 8);
  assert.equal(result.metrics.fairness, 1);
  assert.ok(result.trace.some(t => t.ruleId === 'KG_PREFERENCE_PATH' && t.path.length === 3));
});

test('尚未选择的活动路径不会提前贡献图谱偏好', () => {
  const c = data([scene('s', { activities: [activity('music', { tags: ['music'] })] })]);
  const result = planDate({ ...context, preferencesA: ['music'], fixedPrefix: [{ sceneId: 's', activityIds: [] }] }, c, { maxStages: 1 });
  assert.equal(result.stages[0].featureContributions.preferenceA, 0);
  assert.ok(!result.trace.some(t => t.ruleId === 'KG_PREFERENCE_PATH'));
});

test('束搜索考虑后续资源价值，保留Pareto取舍并诚实披露非最优性', () => {
  const c = data([scene('tempting', { minutes: 60, fit: 100 }), scene('prepare', { minutes: 15, fit: 50, provides: ['kit'] }), scene('valuable', { minutes: 25, fit: 120, requires: ['kit'] })]);
  const result = planDate({ ...context, duration: 65 }, c, { maxStages: 2, beamWidth: 8 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.stages.map(s => s.sceneId), ['prepare', 'valuable']);
  assert.equal(result.search.provedOptimal, false);
  assert.equal(result.searchStatus, 'heuristic_feasible_not_proved_optimal');
  assert.ok(result.paretoPlans.length >= 1);
  assert.ok(result.paretoPlans.every(p => p.searchStatus === 'pareto_among_discovered_plans'));
});

test('主动结束限制真实求解阶段，未知预算不成为零预算', () => {
  const c = data([scene('a', { cost: [10, 20] }), scene('b')]);
  const result = planDate({ ...context, endAfterStage: 0, budget: null }, c);
  assert.equal(result.stages.length, 1);
  assert.equal(result.search.maxStages, 1);
  assert.equal(normalize({ budget: null }).budgetHighCents, null);
  assert.equal(planDate({ ...context, windows: [{ startMinute: 10, endMinute: 5 }] }, c).status, 'invalid_input');
});

test('新目录0→90→0可复现，前缀保持、输入不变，mall可浏览多选', () => {
  const planner = createPlanner(fullCatalog);
  const before = canonical(fullCatalog), snapshot = canonical(realContext);
  const original = planner.plan(realContext, 0, []);
  const explored = planner.plan(realContext, 90, []);
  const restored = planner.plan(realContext, 0, []);
  assert.equal(original.ok, true);
  assert.equal(explored.ok, true);
  assert.equal(original.outputFingerprint, restored.outputFingerprint);
  assert.equal(canonical(original), canonical(restored));
  assert.notEqual(original.outputFingerprint, explored.outputFingerprint);
  assert.equal(canonical(fullCatalog), before);
  assert.equal(canonical(realContext), snapshot);
  assert.ok(original.stages[0].candidates.length >= 8);
  assert.ok(original.stages[0].candidates.some(s => s.sceneId === 'mall'));
  const prefix = [{ sceneId: 'mall', activityIds: [] }];
  const actualIds = catalog.scenes.find(s => s.id === 'mall').activities.map(a => a.id);
  prefix[0].activityIds = actualIds.filter(id => /claw|stores|snack/.test(id));
  const selected = planner.plan(realContext, 90, prefix);
  assert.equal(selected.ok, true);
  assert.deepEqual(selected.stages[0].activityIds, prefix[0].activityIds.sort());
  assert.ok(selected.stages[0].candidates.length >= 8);
  assert.ok(selected.trace.some(t => /^R-/.test(t.ruleId)));
});

test('低探索无匹配兴趣时允许空组合，低负担不靠休息或无限填满', () => {
  const planner = createPlanner(fullCatalog);
  const input = { duration: 180, windows: [{ id: 'pm', startMinute: 840, endMinute: 1020 }], area: 'near', robust: true, fatigueA: 2, fatigueB: 2 };
  const initial = planner.plan(input, 0);
  assert.notEqual(catalog.scenes.find(sc => sc.id === initial.stages[0].sceneId).kind, 'rest');
  assert.deepEqual(initial.stages[0].activityIds, []);
  assert.ok(initial.stages.length < 5);
  assert.ok(initial.stages.every(s => catalog.scenes.find(sc => sc.id === s.sceneId).kind !== 'rest'));
  const three = ['arcade_basket', 'mall_stores', 'mall_snacks'];
  const loaded = planner.plan(input, 0, [{ sceneId: 'mall', activityIds: three }]);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.stages[0].after.fatigue[0], 10);
  assert.equal(loaded.stages[1].sceneId, 'rest');
  assert.ok(loaded.stages.length > 2);
  assert.ok(loaded.stages[1].trace.some(t => t.ruleId === 'R-fatigue-derive'));
  assert.ok(!loaded.stages[2].trace.some(t => t.ruleId === 'R-fatigue-derive'));
  const cleared = planner.plan(input, 0, [{ sceneId: 'mall', activityIds: [] }]);
  assert.deepEqual(cleared.stages[0].activityIds, []);
  assert.deepEqual(cleared.stages[0].after.fatigue, [3, 3]);
});

test('场景与功能重复是软偏好；显式跨窗口重复用餐仍可执行', () => {
  const c = data([scene('same', { minutes: 20 }), scene('meal', { kind: 'meal', minutes: 30, load: 0 })]);
  const repeated = planDate({ ...context, fixedPrefix: [{ sceneId: 'same', activityIds: [] }, { sceneId: 'same', activityIds: [] }] }, c, { maxStages: 2 });
  assert.equal(repeated.ok, true);
  assert.ok(repeated.stages[1].featureContributions.repeatScenePenalty < 0);
  assert.ok(repeated.stages[1].featureContributions.repeatFunctionPenalty < 0);
  const meals = planDate({ ...context, duration: 120, windows: [{ id: 'lunch', startMinute: 660, endMinute: 720 }, { id: 'dinner', startMinute: 1080, endMinute: 1140 }], fixedPrefix: [{ sceneId: 'meal', activityIds: [] }, { sceneId: 'meal', activityIds: [] }] }, c, { maxStages: 2 });
  assert.equal(meals.ok, true);
  assert.equal(meals.stages[1].windowId, 'dinner');
});

test('鲁棒时间不确定量跨阶段累加，等待可吸收前序偏差', () => {
  const c = data([scene('a', { uncertaintyMinutes: 10 }), scene('b', { uncertaintyMinutes: 10 })]);
  const prefix = [{ sceneId: 'a', activityIds: [] }, { sceneId: 'b', activityIds: [] }];
  assert.equal(planDate({ ...context, duration: 70, robust: false, fixedPrefix: prefix }, c, { maxStages: 2 }).ok, true);
  assert.equal(planDate({ ...context, duration: 70, robust: true, fixedPrefix: prefix }, c, { maxStages: 2 }).ok, false);
  const waited = planDate({ ...context, duration: 100, robust: true, fixedPrefix: [{ sceneId: 'a', activityIds: [] }], anchors: [{ choice: { sceneId: 'b', activityIds: [] }, startMinute: 60, index: 1 }] }, c, { maxStages: 2 });
  assert.equal(waited.ok, true);
  assert.equal(waited.metrics.totalUncertaintyMinutes, 10);
  assert.equal(waited.stages[1].wait, 20);
  const automatic = planDate({ ...context, duration: 100, robust: true }, c, { maxStages: 2 });
  assert.equal(automatic.ok, true);
  assert.equal(automatic.stages.length, 2);
  assert.equal(automatic.stages[1].fixedStartMinute, null);
  assert.equal(automatic.stages[1].reserve, 20);
});

test('明确未找到与输入无效分开，节点截断不伪称不可行证明', () => {
  const c = data([scene('a'), scene('b')]);
  const result = planDate({ ...context, mealNeed: true }, c, { maxExpandedNodes: 1 });
  assert.equal(result.status, 'no_plan_found');
  assert.equal(result.search.nodeBudgetReached, true);
  assert.equal(result.search.provedOptimal, false);
  const wrong = planDate({ ...context, fixedPrefix: [{ sceneId: 'missing', activityIds: [] }] }, c);
  assert.equal(wrong.status, 'invalid_input');
});
