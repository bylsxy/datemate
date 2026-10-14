import test from 'node:test';
import assert from 'node:assert/strict';
import { planDate, CONFIG, VERSION } from '../engine.mjs';
import { catalog } from '../data/catalog.mjs';

const scene = (id, extra = {}) => ({ id, title: id, minutes: 20, cost: [0, 0], load: 0, kind: id, area: 'campus', indoor: true, quiet: true, fit: 70, novelty: 30, tags: [], activities: [], ...extra });
const activity = (id, extra = {}) => ({ id, minutes: 5, cost: [0, 0], load: 0, group: 'optional', mode: 'multiple', tags: [], ...extra });
const data = scenes => ({ version: 'recommendation-test-v1', scenes });
const context = { duration: 150, reserve: 0, robust: false, fatigueA: 0, fatigueB: 0 };

function checkScores(result) {
  assert.equal(result.ok, true);
  for (const stage of result.stages) {
    const evaluated = stage.candidates.filter(c => c.scoreStatus === 'evaluated');
    assert.ok(evaluated.every(c => c.evaluationStatus === 'complete_continuation_found' && c.continuationFound));
    for (const c of evaluated) {
      assert.ok(Number.isFinite(c.fitScore) && c.fitScore >= 0 && c.fitScore <= 100);
      const gain = c.q - stage.scoreReference.prefixUtility;
      assert.equal(c.fitScore, +(50 + 50 * gain / (Math.abs(gain) + stage.scoreReference.referenceUtility)).toFixed(2));
      assert.equal(c.fitScore, c.score);
      assert.equal(c.fitScore, c.recommendationIndex);
      assert.equal(c.scoreVersion, result.versions.score);
    }
    for (let i = 1; i < evaluated.length; i++) {
      assert.ok(evaluated[i - 1].q >= evaluated[i].q);
      assert.ok(evaluated[i - 1].fitScore >= evaluated[i].fitScore);
    }
    if (!stage.manual) assert.ok(evaluated.every(c => stage.fitScore >= c.fitScore), '自动选择必须是同口径最高分或并列');
    for (const c of stage.candidates.filter(c => c.scoreStatus === 'pending')) {
      assert.equal(c.fitScore, null);
      assert.equal(c.score, null);
      assert.equal(c.q, null);
      assert.equal(c.continuationFound, false);
    }
  }
}

test('完整后续效用统一比较，较长方案不能因候选自己的分母变成低分', () => {
  const c = data([scene('tempting', { minutes: 55, fit: 100 }), scene('prepare', { minutes: 15, fit: 50, provides: ['kit'] }), scene('valuable', { minutes: 25, fit: 120, requires: ['kit'] })]);
  const result = planDate({ ...context, duration: 65 }, c, { maxStages: 2, method: 'exact' });
  assert.deepEqual(result.stages.map(s => s.sceneId), ['prepare', 'valuable']);
  checkScores(result);
  const candidates = result.stages[0].candidates;
  assert.ok(candidates.find(c => c.sceneId === 'prepare').fitScore > candidates.find(c => c.sceneId === 'tempting').fitScore);
});

test('人工锁定允许较低分，反事实候选释放当前锁定并保留此前阶段和未来锚点', () => {
  const c = data([scene('first', { fit: 60, provides: ['kit'] }), scene('weak', { fit: 25 }), scene('strong', { fit: 125, requires: ['kit'] }), scene('booking', { fit: 60, requires: ['kit'] })]);
  const input = { ...context, fixedPrefix: [{ sceneId: 'first', activityIds: [] }, { sceneId: 'weak', activityIds: [] }], anchors: [{ id: 'reserved', choice: { sceneId: 'booking', activityIds: [] }, index: 2, startMinute: 90 }] };
  const result = planDate(input, c, { maxStages: 3, method: 'exact' });
  checkScores(result);
  const stage = result.stages[1], strong = stage.candidates.find(c => c.sceneId === 'strong');
  assert.ok(strong.fitScore > stage.fitScore);
  const replacement = planDate({ ...input, fixedPrefix: [{ sceneId: 'first', activityIds: [] }, { sceneId: 'strong', activityIds: [] }] }, c, { maxStages: 3, method: 'exact' });
  assert.equal(strong.q, replacement.stages[1].rawUtility);
  assert.equal(result.stages[2].anchorId, 'reserved');
  assert.equal(result.stages[2].startMinute, 90);
  assert.ok(result.stages[2].candidates.every(c => c.sceneId === 'booking'));
});

test('仅局部可行、预算截断且未完成正餐目标的候选明确待评估', () => {
  const c = data([scene('a_local', { minutes: 60, fit: 200 }), scene('z_meal', { minutes: 30, kind: 'meal', fit: 60 })]);
  const result = planDate({ ...context, duration: 75, mealNeed: true }, c, { maxStages: 3, beamWidth: 1, maxExpandedNodes: 2 });
  checkScores(result);
  assert.equal(result.search.nodeBudgetReached, true);
  const pending = result.stages[0].candidates.find(c => c.sceneId === 'a_local');
  assert.equal(pending.scoreStatus, 'pending');
  assert.equal(pending.evaluationStatus, 'continuation_not_evaluated');
  assert.ok(pending.localUtility > result.stages[0].localUtility);
});

test('可提前结束的一阶段裸候选未探索后续时也不能拿局部分伪装规划分', () => {
  const result = planDate(context, data([scene('a', { fit: 100 }), scene('b', { fit: 80 })]), { maxStages: 3, maxExpandedNodes: 2 });
  checkScores(result);
  assert.equal(result.stages[0].candidates.find(c => c.sceneId === 'b').fitScore, null);
});

test('人工活动精确计分，不借同地点更优活动组合的分数', () => {
  const c = data([scene('s', { activities: [activity('costly', { cost: [10, 20], load: 3 })] }), scene('better', { fit: 100 })]);
  const result = planDate({ ...context, fixedPrefix: [{ sceneId: 's', activityIds: ['costly'] }] }, c, { maxStages: 1 });
  checkScores(result);
  const own = result.stages[0].candidates.find(c => c.sceneId === 's');
  assert.deepEqual(own.activityIds, ['costly']);
  assert.ok(Math.abs(own.q - result.metrics.objective) < 0.0005);
  assert.ok(result.stages[0].candidates.find(c => c.sceneId === 'better').fitScore > own.fitScore);
});

test('固定参考尺不做批内min-max，不因新加低分地点改变已知分数，也不饱和成一批99', () => {
  const scenes = [scene('a', { fit: 70 }), scene('b', { fit: 80 }), scene('c', { fit: 90 })];
  const first = planDate(context, data(scenes), { maxStages: 1 });
  const added = planDate(context, data([...scenes, scene('unrelated', { fit: 1 })]), { maxStages: 1 });
  checkScores(first); checkScores(added);
  for (const candidate of first.stages[0].candidates) assert.equal(candidate.fitScore, added.stages[0].candidates.find(c => c.sceneId === candidate.sceneId).fitScore);
  assert.equal(new Set(first.stages[0].candidates.map(c => c.fitScore)).size, 3);
  assert.ok(first.stages[0].fitScore < 100);
  assert.equal(added.stages[0].candidates.find(c => c.sceneId === 'unrelated').fitScore < 50, true);
});

test('整轮人工候选后续求解共用固定计算预算，复盘显式校验评分版本', () => {
  const c = data(Array.from({ length: 12 }, (_, i) => scene(`s-${i}`, { fit: 60 + i })));
  const input = { ...context, fixedPrefix: [{ sceneId: 's-0', activityIds: [] }, { sceneId: 's-1', activityIds: [] }] };
  const options = { maxStages: 3, maxExpandedNodes: 100, maxCandidateExpandedNodes: 11 };
  const result = planDate(input, c, options);
  checkScores(result);
  assert.ok(result.search.candidateExpandedNodes <= 11);
  assert.equal(result.search.candidateNodeBudgetReached, true);
  assert.equal(result.versions.engine, VERSION);
  assert.equal(result.versions.score, CONFIG.scoreVersion);
  assert.equal(planDate({ ...input, expectedVersions: result.versions }, c, options).ok, true);
  const stale = planDate({ ...input, expectedVersions: { ...result.versions, score: 'utility-3.0.1' } }, c, options);
  assert.equal(stale.status, 'invalid_input');
  assert.match(stale.errors[0], /^H_VERSION:/);
});

test('零探索仍联合择优地点与活动：双方play兴趣可选商场电玩，无兴趣保留空组合', () => {
  const input = { ...context, duration: 90, area: 'near' };
  const plain = planDate(input, catalog, { maxStages: 1 });
  const shared = planDate({ ...input, preferencesA: ['play'], preferencesB: ['play'] }, catalog, { maxStages: 1 });
  checkScores(plain); checkScores(shared);
  assert.equal(plain.stages[0].sceneId, 'mall');
  assert.deepEqual(plain.stages[0].activityIds, []);
  assert.equal(shared.stages[0].sceneId, 'mall');
  assert.ok(shared.stages[0].activityIds.some(id => /^arcade_/.test(id)));
  assert.ok(shared.stages[0].activityIds.length < catalog.scenes.find(s => s.id === 'mall').activities.length);
  assert.ok(shared.stages[0].featureContributions.activityExperienceA > 0);
  assert.ok(shared.stages[0].featureContributions.activityExperienceB > 0);
});

test('默认活动列表不强制自动选择，不改变相同组合的真实效用', () => {
  const s = scene('place', { activities: [activity('play', { tags: ['play'] }), activity('unrelated', { cost: [50, 100] })] });
  const input = { ...context, preferencesA: ['play'], preferencesB: ['play'] };
  const plain = planDate(input, data([s]), { maxStages: 1 });
  const defaults = planDate(input, data([{ ...s, default: ['unrelated'], defaultActivityIds: ['unrelated'] }]), { maxStages: 1 });
  assert.deepEqual(plain.stages[0].activityIds, ['play']);
  assert.deepEqual(defaults.stages[0].activityIds, ['play']);
  assert.equal(defaults.metrics.objective, plain.metrics.objective);
});

test('活动耗时字段完全不参与阶段时间或候选评分，场景分钟才影响时间窗', () => {
  const s = scene('place', { minutes: 30, activities: [activity('play', { tags: ['play'], minutes: 0 })] });
  const input = { ...context, duration: 40, preferencesA: ['play'], preferencesB: ['play'] };
  const zero = planDate(input, data([s]), { maxStages: 1 });
  const huge = planDate(input, data([{ ...s, activities: [{ ...s.activities[0], minutes: 900, duration: 1000, baseline: { duration: 1200 } }] }]), { maxStages: 1 });
  checkScores(zero); checkScores(huge);
  assert.deepEqual(huge.stages[0].activityIds, ['play']);
  assert.equal(huge.stages[0].minutes, 30);
  assert.equal(huge.stages[0].start, zero.stages[0].start);
  assert.equal(huge.stages[0].end, zero.stages[0].end);
  assert.equal(huge.metrics.objective, zero.metrics.objective);
  assert.equal(huge.stages[0].fitScore, zero.stages[0].fitScore);
  const tooLong = planDate(input, data([{ ...s, minutes: 31 }]), { maxStages: 1 });
  assert.equal(tooLong.ok, false);
});

test('多用途地点只有所选meal_completed活动才完成正餐，并正确登记当前用餐窗口', () => {
  const c = data([scene('multi', { kind: 'explore', activities: [activity('meal', { provides: ['meal_completed'], compositionMode: 'included', minutes: 0 })] })]);
  const empty = planDate({ ...context, mealNeed: true, fixedPrefix: [{ sceneId: 'multi', activityIds: [] }] }, c, { maxStages: 1 });
  assert.equal(empty.ok, false);
  const result = planDate({ ...context, mealNeed: true }, c, { maxStages: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.stages[0].activityIds, ['meal']);
  assert.equal(result.metrics.mealSatisfied, true);
  assert.equal(result.stages[0].after.meal, true);
  const glass = planDate({ ...context, area: 'near', school: 'scau', campusArea: 'taishan', mealNeed: true, fixedPrefix: [{ sceneId: 'taishan_glass', activityIds: ['glass_noodle'] }] }, catalog, { maxStages: 1 });
  assert.equal(glass.ok, true);
  assert.equal(glass.metrics.mealSatisfied, true);
});
