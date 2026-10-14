import test from 'node:test';
import assert from 'node:assert/strict';
import { planDate, verifyPlanWitness } from '../engine.mjs';

const scene = (id, extra = {}) => ({ id, minutes: 20, cost: [0, 0], load: 0, kind: id, area: 'campus', indoor: true, quiet: true, fit: 80, novelty: 40, activities: [], ...extra });
const fixture = scenes => ({ version: 'selection-mode-test', scenes });
const context = { duration: 150, reserve: 0, robust: false, fatigueA: 0, fatigueB: 0 };
const coverageCatalog = fixture(Array.from({ length: 48 }, (_, i) => scene(`s-${String(i).padStart(2, '0')}`, { fit: 90 - i * 0.3, kind: `kind-${i % 6}` })));
const coverageInput = { ...context, fixedPrefix: [{ sceneId: 's-00', activityIds: [] }] };
const coverageOptions = { maxStages: 4, beamWidth: 8, maxExpandedNodes: 1800, maxCandidateExpandedNodes: 200, exploration: 100 };
const route = result => result.stages.map(s => `${s.sceneId}[${s.activityIds.join(',')}]`).join('/');
const rounded = value => +value.toFixed(3);

function assertBest(result, input, catalog, options) {
  assert.equal(result.ok, true, result.errors?.join(';'));
  assert.equal(result.decisionMode, 'utility_best');
  // metrics 使用公开的三位小数；见证重验则核对未舍入的真实目标函数。
  assert.equal(result.metrics.objective, rounded(result.explorationSelection.bestDiscoveredObjective));
  assert.equal(result.explorationSelection.objective, result.explorationSelection.bestDiscoveredObjective);
  for (const field of ['utilityGap', 'maxUtilityGap', 'searchNoise']) assert.equal(result.explorationSelection[field], 0, field);
  const verified = verifyPlanWitness(input, catalog, { ...options, knownPlan: result.continuationWitness });
  assert.equal(verified.ok, true, verified.errors?.join(';'));
  assert.equal(verified.q, result.explorationSelection.bestDiscoveredObjective);
}

function replay(result, catalog) {
  const saved = result.replay;
  return planDate({ ...saved.context, anchors: saved.anchors }, catalog, {
    ...saved.search, fixedPrefix: saved.prefix, knownPlan: saved.knownPlan,
    exploration: saved.exploration, explorationSeed: saved.explorationSeed, expectedVersions: saved.versions,
  });
}

test('固定seed默认探索选次优，utility_best在同一高探索搜索中选择已发现最高真实效用', () => {
  const input = { ...coverageInput, explorationSeed: 'seed-0' };
  const ordinary = planDate(input, coverageCatalog, coverageOptions);
  const options = { ...coverageOptions, selectionMode: 'utility_best' };
  const best = planDate(input, coverageCatalog, options);
  assert.equal(ordinary.ok, true);
  assert.equal(ordinary.decisionMode, 'seeded_exploration');
  assert.ok(ordinary.explorationSelection.objective < ordinary.explorationSelection.bestDiscoveredObjective, '固定seed必须实际选出次优路线');
  assertBest(best, input, coverageCatalog, options);
  assert.equal(best.explorationSelection.bestDiscoveredObjective, ordinary.explorationSelection.bestDiscoveredObjective);
  assert.ok(best.metrics.objective > ordinary.metrics.objective);
  assert.notEqual(route(best), route(ordinary));
  for (const field of ['expandedNodes', 'terminalPlans', 'beamWidth', 'candidateLimit', 'explorationStrength']) assert.equal(best.search[field], ordinary.search[field], field);
  assert.equal(best.search.candidateLimit, 32, '择优不能关闭高探索候选拓宽');
  assert.equal(best.displayMode, 'seeded_exploration');
  assert.equal(best.stages[0].decisionMode, 'manual');
  assert.equal(best.stages[0].displayMode, 'utility_best');
  assert.deepEqual(best.stages[0].activityIds, input.fixedPrefix[0].activityIds);
  assert.equal(best.stages[0].sceneId, 's-00');
  for (const stage of best.stages.slice(1)) {
    assert.equal(stage.decisionMode, 'utility_best');
    assert.equal(stage.displayMode, 'seeded_exploration');
  }
  assert.deepEqual(planDate(input, coverageCatalog, options), best, '显式择优仍由seed确定复现');
});

test('多个固定seed保留默认探索路线变化，显式择优逐次取本轮发现最高效用', () => {
  const routes = new Set();
  for (const explorationSeed of ['seed-0', 'seed-1', 'seed-2', 'seed-3']) {
    const input = { ...coverageInput, explorationSeed };
    const ordinary = planDate(input, coverageCatalog, coverageOptions);
    const options = { ...coverageOptions, selectionMode: 'utility_best' };
    const best = planDate(input, coverageCatalog, options);
    assert.equal(ordinary.ok, true);
    routes.add(route(ordinary));
    assertBest(best, input, coverageCatalog, options);
    assert.equal(best.explorationSelection.bestDiscoveredObjective, ordinary.explorationSelection.bestDiscoveredObjective);
    assert.deepEqual(best.prefix, ordinary.prefix);
  }
  assert.ok(routes.size > 1, '默认模式不能被本次择优需求改成所有seed同一路线');
});

test('择优对全部完整终态取最大值，包括早于maxStages结束的最优方案', () => {
  const catalog = fixture([scene('a', { fit: 10, novelty: 0 }), scene('b', { fit: 9, novelty: 0 }), scene('c', { fit: 8, novelty: 0 })]);
  const input = { ...context, explorationSeed: 'short-terminal' };
  const options = { method: 'exact', maxStages: 3, maxExpandedNodes: 1000, maxCandidateExpandedNodes: 0, exploration: 100, selectionMode: 'utility_best' };
  // 枚举小fixture的所有1～3阶段完整见证，用独立重验API作为最大真实q的oracle。
  const terminals = [];
  function enumerate(prefix = []) {
    if (prefix.length) {
      const result = verifyPlanWitness(input, catalog, { ...options, knownPlan: prefix });
      if (result.ok) terminals.push(result);
    }
    if (prefix.length < options.maxStages) for (const s of catalog.scenes) enumerate([...prefix, { sceneId: s.id, activityIds: [] }]);
  }
  enumerate();
  assert.ok(terminals.length > 3);
  const oracle = Math.max(...terminals.map(result => result.q));
  const result = planDate(input, catalog, options);
  assertBest(result, input, catalog, options);
  assert.equal(result.explorationSelection.bestDiscoveredObjective, oracle);
  assert.ok(result.stages.length < options.maxStages, '不得只从最后一层beam挑方案');
});

test('高探索真实目标仍奖励新颖性，utility_best不等价于把exploration清零', () => {
  const catalog = fixture([scene('familiar', { fit: 100, novelty: 0 }), scene('novel', { fit: 60, novelty: 100 })]);
  const input = { ...context, explorationSeed: 'novel-objective' };
  const common = { maxStages: 1, maxCandidateExpandedNodes: 0, selectionMode: 'utility_best' };
  const low = planDate(input, catalog, { ...common, exploration: 0 });
  const highOptions = { ...common, exploration: 100 };
  const high = planDate(input, catalog, highOptions);
  assert.equal(low.ok, true);
  assert.equal(low.stages[0].sceneId, 'familiar');
  assertBest(high, input, catalog, highOptions);
  assert.equal(high.stages[0].sceneId, 'novel');
  const highPlanAtZero = verifyPlanWitness(input, catalog, { ...common, exploration: 0, knownPlan: high.continuationWitness });
  assert.notEqual(highPlanAtZero.q, high.explorationSelection.objective);
});

test('资源前序、必去和预约仍固定，knownPlan在最小预算下兜底并完整复盘', () => {
  const catalog = fixture([
    scene('a-decoy'), scene('prepare', { provides: ['kit'] }),
    scene('use', { requires: ['kit', 'purchase'], consumes: ['kit'], cost: [2, 3] }), scene('booking'),
  ].map(s => s.id === 'prepare' ? { ...s, activities: [{ id: 'purchase', provides: ['purchase'], cost: [1, 1], load: 0 }] } : s));
  const prefix = [{ sceneId: 'prepare', activityIds: ['purchase'] }];
  const input = { ...context, budget: 4, fixedPrefix: prefix, requiredSceneIds: ['use'], explorationSeed: 'minimum-budget', anchors: [{ id: 'reserved', choice: { sceneId: 'booking', activityIds: [] }, index: 2, startMinute: 90 }] };
  const knownPlan = [...prefix, { sceneId: 'use', activityIds: [] }, { sceneId: 'booking', activityIds: [], startMinute: 90, anchorId: 'reserved' }];
  const options = { maxStages: 3, maxExpandedNodes: 1, maxCandidateExpandedNodes: 0, exploration: 100, selectionMode: 'utility_best' };
  assert.equal(planDate(input, catalog, options).ok, false, '预算不足时确实需要完整见证兜底');
  const result = planDate(input, catalog, { ...options, knownPlan });
  assertBest(result, input, catalog, options);
  assert.equal(result.search.knownPlan.status, 'verified');
  assert.equal(result.search.expandedNodes, 1);
  assert.deepEqual(result.continuationWitness, knownPlan);
  assert.equal(result.stages[0].decisionMode, 'manual');
  assert.equal(result.stages[1].decisionMode, 'utility_best');
  assert.equal(result.stages[2].decisionMode, 'manual');
  assert.equal(result.stages[0].after.resources.kit, 1);
  assert.equal(result.stages[1].after.resources.kit, 0);
  assert.equal(result.stages[2].start, 90);
  assert.equal(result.metrics.anchorsSatisfied, true);
  assert.deepEqual(result.totalCostCents, [300, 400]);
  assert.equal(result.replay.search.selectionMode, 'utility_best');
  const repeated = replay(result, catalog);
  assert.equal(repeated.ok, true);
  for (const field of ['fingerprint', 'inputDigest', 'outputFingerprint', 'outputDigest']) assert.equal(repeated[field], result[field], field);
  assert.deepEqual(repeated.stages, result.stages);
});

test('高探索择优复盘保存selectionMode且全部fingerprint保持一致', () => {
  const input = { ...coverageInput, explorationSeed: 'seed-0' };
  const result = planDate(input, coverageCatalog, { ...coverageOptions, selectionMode: 'utility_best' });
  assert.equal(result.replay.search.selectionMode, 'utility_best');
  const repeated = replay(result, coverageCatalog);
  assert.equal(repeated.decisionMode, 'utility_best');
  assert.equal(repeated.displayMode, 'seeded_exploration');
  for (const field of ['fingerprint', 'inputDigest', 'outputFingerprint', 'outputDigest']) assert.equal(repeated[field], result[field], field);
  assert.deepEqual(repeated.stages, result.stages);
});

test('零探索旧调用自动归一为utility_best且不受seed影响，无效mode等价于省略', () => {
  const zeroOptions = { ...coverageOptions, exploration: 0 };
  const input = { ...coverageInput, explorationSeed: 'zero-a' };
  const zero = planDate(input, coverageCatalog, zeroOptions);
  const explicit = planDate(input, coverageCatalog, { ...zeroOptions, selectionMode: 'utility_best' });
  assertBest(zero, input, coverageCatalog, zeroOptions);
  assert.deepEqual(explicit, zero);
  assert.equal(zero.replay.search.selectionMode, 'utility_best');
  assert.equal(zero.displayMode, 'utility_best');
  assert.ok(zero.stages.every(stage => stage.displayMode === 'utility_best'));
  const otherSeed = planDate({ ...input, explorationSeed: 'zero-b' }, coverageCatalog, zeroOptions);
  assert.equal(otherSeed.outputFingerprint, zero.outputFingerprint);
  assert.deepEqual(otherSeed.stages, zero.stages);
  for (const exploration of [0, 100]) {
    const options = { ...coverageOptions, exploration };
    const ordinary = planDate(input, coverageCatalog, options);
    for (const selectionMode of ['invalid-mode', '', null, 100, {}]) {
      assert.deepEqual(planDate(input, coverageCatalog, { ...options, selectionMode }), ordinary, `invalid ${JSON.stringify(selectionMode)} at exploration ${exploration}`);
    }
  }
});
