import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { planDate, createContinuationSearch, canonical } from '../engine.mjs';
import { createExploration } from '../exploration.mjs';
import { catalog } from '../data/catalog.mjs';

const scene = (id, extra = {}) => ({ id, minutes: 20, cost: [0, 0], load: 0, kind: id, area: 'campus', indoor: true, quiet: true, fit: 80, novelty: 40, activities: [], ...extra });
const data = scenes => ({ version: 'exploration-test', scenes });
const context = { duration: 150, reserve: 0, robust: false, fatigueA: 0, fatigueB: 0 };
const coverageCatalog = data(Array.from({ length: 48 }, (_, i) => scene(`s-${String(i).padStart(2, '0')}`, { fit: 90 - i * 0.3, kind: `kind-${i % 6}` })));
const coverageContext = { ...context, fixedPrefix: [{ sceneId: 's-00', activityIds: [] }] };
const coverageOptions = { maxStages: 4, beamWidth: 8, maxExpandedNodes: 1800, maxCandidateExpandedNodes: 200 };
const route = result => result.stages.map(s => `${s.sceneId}[${s.activityIds.join(',')}]`).join('/');
const finish = iterator => { let step; do { step = iterator.next(); } while (!step.done); return step.value; };

function checkRealScores(result) {
  assert.equal(result.ok, true, result.errors.join(';'));
  for (const stage of result.stages) {
    assert.ok(Math.abs(stage.rawUtility - result.metrics.objective) < 0.0005);
    assert.equal(stage.candidates.find(c => c.sceneId === stage.sceneId).q, stage.rawUtility);
    stage.candidates.forEach((candidate, rank) => {
      assert.equal(candidate.displayOrderIndex, rank);
      assert.equal(candidate.explorationRank, rank);
      if (!candidate.continuationFound) {
        assert.equal(candidate.q, null); assert.equal(candidate.fitScore, null);
        return;
      }
      const gain = candidate.q - stage.scoreReference.prefixUtility;
      assert.equal(candidate.fitScore, +(50 + 50 * gain / (Math.abs(gain) + stage.scoreReference.referenceUtility)).toFixed(2));
    });
  }
  assert.ok(result.search.expandedNodes <= result.search.maxExpandedNodes);
  assert.ok(result.search.candidateExpandedNodes <= result.search.maxCandidateExpandedNodes);
}

test('同seed和默认上下文hash确定复现；seed优先级、导出复盘与输入不变', () => {
  const input = { ...coverageContext, exploration: 100, explorationSeed: 'slider-1' };
  const snapshot = canonical(input), catalogSnapshot = canonical(coverageCatalog);
  const a = planDate(input, coverageCatalog, coverageOptions);
  assert.deepEqual(planDate(input, coverageCatalog, coverageOptions), a);
  const replayed = planDate({ context: a.replay.context, exploration: a.replay.exploration, fixedPrefix: a.replay.prefix, anchors: a.replay.anchors }, coverageCatalog, { ...a.replay.search, expectedVersions: a.replay.versions });
  assert.deepEqual(replayed, a);
  assert.equal(a.explorationSeed, 'slider-1');
  assert.equal(a.replay.explorationSeed, a.explorationSeed);
  assert.equal(a.decisionMode, 'seeded_exploration');
  assert.equal(a.choiceMode, a.decisionMode);
  const overridden = planDate({ context: { ...context, explorationSeed: 'nested' }, explorationSeed: 'input' }, coverageCatalog, { ...coverageOptions, exploration: 100, explorationSeed: 123 });
  assert.equal(overridden.explorationSeed, '123');
  const nested = planDate({ context: { ...context, exploration: 100, explorationSeed: 'nested' } }, coverageCatalog, coverageOptions);
  assert.equal(nested.explorationSeed, 'nested');
  assert.equal(nested.exploration, 100);
  const implicit = planDate({ ...coverageContext, exploration: 100 }, coverageCatalog, coverageOptions);
  assert.deepEqual(planDate({ ...coverageContext, exploration: 100 }, coverageCatalog, coverageOptions), implicit);
  assert.equal(typeof implicit.explorationSeed, 'string');
  assert.equal(canonical(input), snapshot); assert.equal(canonical(coverageCatalog), catalogSnapshot);
});

test('rootWorker携带recorded search复盘，默认及显式搜索设置输出hash一致', () => {
  for (const exploration of [0, 37, 80, 100]) for (const search of [{}, { ...coverageOptions, candidateLimit: 7 }]) {
    const input = { ...coverageContext, explorationSeed: `recorded-${exploration}` };
    const original = planDate(input, coverageCatalog, { ...search, exploration });
    const replayed = planDate(input, coverageCatalog, { ...original.replay.search, exploration, fixedPrefix: original.replay.prefix, expectedVersions: original.versions });
    assert.equal(replayed.outputFingerprint, original.outputFingerprint);
    assert.equal(replayed.inputDigest, original.inputDigest);
    assert.deepEqual(replayed.stages, original.stages);
  }
});

test('错误seed拒绝输入；零探索不受seed影响且仍取真实最高分', () => {
  for (const explorationSeed of [{}, [], Infinity, true]) {
    const result = planDate(context, coverageCatalog, { explorationSeed });
    assert.equal(result.status, 'invalid_input'); assert.match(result.errors[0], /^H_EXPLORATION_SEED:/);
  }
  const a = planDate({ ...coverageContext, explorationSeed: 'zero-a' }, coverageCatalog, coverageOptions);
  const b = planDate({ ...coverageContext, explorationSeed: 'zero-b' }, coverageCatalog, coverageOptions);
  assert.equal(a.outputFingerprint, b.outputFingerprint);
  assert.deepEqual(a.stages, b.stages);
  assert.equal(a.search.candidateLimit, 20);
  assert.equal(a.decisionMode, 'utility_best');
  assert.deepEqual(a.stages.map(s => s.sceneId), ['s-00', 's-01', 's-02', 's-03']);
  for (const stage of a.stages) {
    const evaluated = stage.candidates.filter(c => c.continuationFound);
    assert.ok(evaluated.every((c, i) => !i || evaluated[i - 1].q >= c.q));
    if (!stage.manual) assert.ok(evaluated.every(c => c.fitScore <= stage.fitScore));
  }
});

test('多seed提高后续顺序与20张之外的场景覆盖，搜索预算和束宽保持有界', t => {
  const low = planDate(coverageContext, coverageCatalog, coverageOptions);
  const lowCards = new Set(low.stages[1].candidates.map(c => c.sceneId));
  const highCards = new Set(), routes = new Set();
  let lowerScoreSelections = 0, nonUtilityOrders = 0;
  for (let i = 0; i < 12; i++) {
    const high = planDate({ ...coverageContext, explorationSeed: `seed-${i}` }, coverageCatalog, { ...coverageOptions, exploration: 100 });
    checkRealScores(high);
    assert.equal(high.search.candidateLimit, 32);
    assert.equal(high.search.beamWidth, low.search.beamWidth);
    assert.equal(high.search.expandedNodes, low.search.expandedNodes);
    assert.deepEqual(high.stages[0].activityIds, coverageContext.fixedPrefix[0].activityIds);
    assert.equal(high.stages[0].sceneId, 's-00');
    assert.equal(high.stages[0].decisionMode, 'manual');
    const lockedEvaluated = high.stages[0].candidates.filter(c => c.continuationFound);
    assert.ok(lockedEvaluated.every((c, j) => !j || lockedEvaluated[j - 1].q >= c.q));
    routes.add(route(high));
    high.stages.slice(1).forEach(stage => {
      assert.equal(stage.selectionLabel, '探索选择');
      stage.candidates.forEach(c => highCards.add(c.sceneId));
      if (stage.candidates.some(c => c.fitScore > stage.fitScore)) lowerScoreSelections++;
      if (stage.candidates.some((c, j) => j && c.continuationFound && stage.candidates[j - 1].continuationFound && c.q > stage.candidates[j - 1].q)) nonUtilityOrders++;
    });
    assert.ok(high.explorationSelection.utilityGap <= high.explorationSelection.maxUtilityGap);
  }
  assert.ok(routes.size >= 8);
  assert.ok([...highCards].filter(id => !lowCards.has(id)).length >= 20);
  assert.ok(lowerScoreSelections > 0); assert.ok(nonUtilityOrders > 0);
  t.diagnostic(`12 seeds: ${routes.size} routes; low cards=${lowCards.size}; high coverage=${highCards.size}; nodes=${low.search.expandedNodes}`);
});

test('探索确实穿透beam剪枝发现资源后续，非仅随机排列已有候选', () => {
  // 显式统一转场，避免同地点零转场改变资源路线与普通路线的相对评分。
  const c = { ...data([...Array.from({ length: 14 }, (_, i) => scene(`a-${i}`, { fit: 90 })), scene('z-prepare', { fit: 70, provides: ['kit'] }), scene('z-value', { fit: 240, requires: ['kit'] })]), transfers: { campus: { campus: 0 } } };
  const options = { maxStages: 2, beamWidth: 4 };
  const low = planDate(context, c, options);
  assert.equal(low.ok, true, low.errors.join(';'));
  assert.ok(!low.stages.some(s => s.sceneId === 'z-value'));
  assert.equal(low.stages[0].candidates.find(c => c.sceneId === 'z-prepare').fitScore, null);
  const high = Array.from({length:16},(_,i)=>planDate({ ...context, explorationSeed: `beam-${i}` }, c, { ...options, exploration: 100 })).find(r=>r.stages.some(s=>s.sceneId==='z-value'));
  assert.ok(high,'高探索应能在有限种子中发现基线剪掉的资源路线');
  assert.deepEqual(high.stages.map(s => s.sceneId), ['z-prepare', 'z-value']);
  assert.ok(high.stages[0].candidates.find(c => c.sceneId === 'z-prepare').continuationFound);
  checkRealScores(high);
});

test('已选探索方案评分只取实际后续；同步候选求解与分片求解取相同最高真实q', () => {
  const input = { ...coverageContext, explorationSeed: 'score-seed' };
  const result = planDate(input, coverageCatalog, { ...coverageOptions, exploration: 100 });
  checkRealScores(result);
  const actual = planDate({ ...input, fixedPrefix: result.stages.map(s => ({ sceneId: s.sceneId, activityIds: s.activityIds })) }, coverageCatalog, { ...coverageOptions, maxStages: result.stages.length, exploration: 100, maxCandidateExpandedNodes: 0 });
  assert.equal(actual.metrics.objective, result.metrics.objective);
  const sync = planDate(input, coverageCatalog, { ...coverageOptions, exploration: 100, continuationOnly: true });
  const sliced = finish(createContinuationSearch(input, coverageCatalog, { ...coverageOptions, exploration: 100 }));
  assert.deepEqual(sliced, sync);
  assert.equal(sync.explorationNoiseEnabled, false);
  assert.equal(sync.scoringMode, 'best_discovered_true_utility');
  assert.equal(sync.choiceMode, 'utility_best');
  const differentSeed = finish(createContinuationSearch({ ...input, explorationSeed: 'score-other' }, coverageCatalog, { ...coverageOptions, exploration: 100 }));
  assert.equal(differentSeed.q, sync.q); assert.deepEqual(differentSeed.stages, sync.stages);
  assert.ok(sync.q >= result.explorationSelection.objective);
});

test('高探索遵守预算、场地、前序消耗资源、必去、预约、同意及审核过滤', () => {
  const c = data([
    scene('start', { activities: [{ id: 'buy', provides: ['pack'], cost: [0, 0], load: 0 }] }),
    scene('consume', { cost: [5, 5], load: 1, requires: ['pack', 'buy'], consumes: ['pack'], activities: [{ id: 'consent', cost: [0, 0], load: 0, requiresExplicitConsent: true }] }),
    scene('booking', { cost: [3, 3] }), scene('over-budget', { cost: [11, 11] }),
    scene('offsite', { area: 'off' }), scene('missing', { requires: ['missing'] }),
    scene('unavailable'), scene('banned'), scene('unreviewed', { reviewStatus: 'draft' }),
    scene('noisy', { quiet: false }), scene('overload', { load: 3 }),
  ]);
  const input = { ...context, area: 'campus', budget: 10, maxLoad: 2, quietRequired: true, requiredSceneIds: ['consume'], availability: { unavailable: 'unavailable' }, bans: ['banned'], fixedPrefix: [{ sceneId: 'start', activityIds: ['buy'] }], anchors: [{ id: 'reserved', choice: { sceneId: 'booking', activityIds: [] }, index: 2, startMinute: 90 }] };
  const blocked = ['over-budget', 'offsite', 'missing', 'unavailable', 'banned', 'unreviewed', 'overload'];
  for (let i = 0; i < 8; i++) {
    const result = planDate({ ...input, explorationSeed: `hard-${i}` }, c, { exploration: 100, maxStages: 3 });
    checkRealScores(result);
    assert.deepEqual(result.stages.map(s => s.sceneId), ['start', 'consume', 'booking']);
    assert.deepEqual(result.stages[0].activityIds, ['buy']);
    assert.equal(result.stages[1].after.resources.pack, 0);
    assert.equal(result.stages[2].start, 90); assert.equal(result.stages[2].anchorId, 'reserved');
    assert.equal(result.totalCostCents[1], 800);
    assert.ok(result.stages.every(s => s.after.fatigue.every(f => f <= 2)));
    assert.ok(result.stages.flatMap(s => s.candidates).every(c => !blocked.includes(c.sceneId) && !c.activityIds.includes('consent')));
    const invalid = planDate({ ...input, fixedPrefix: [...input.fixedPrefix, { sceneId: 'consume', activityIds: ['consent'] }], explorationSeed: `hard-${i}` }, c, { exploration: 100, maxStages: 3 });
    assert.equal(invalid.status, 'invalid_input'); assert.match(invalid.errors.join(), /H_CONSENT/);
  }
});

test('高探索仍允许重复，人工前缀不因子集或探索被替换', () => {
  const c = data([scene('repeat', { activities: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })]);
  const prefix = [{ sceneId: 'repeat', activityIds: ['a', 'b', 'c'] }, { sceneId: 'repeat', activityIds: [] }];
  const result = planDate({ ...context, fixedPrefix: prefix, explorationSeed: 'repeat' }, c, { exploration: 100, maxStages: 2, activitySubsetLimit: 1 });
  assert.equal(result.ok, true); assert.deepEqual(result.stages.map(s => ({ sceneId: s.sceneId, activityIds: s.activityIds })), prefix);
  assert.ok(result.stages.every(s => s.manual && s.decisionMode === 'manual'));
});

test('多seed真实目录覆盖餐次、预约前缀和鲁棒结束缓冲，卡片分数与展露rank分离', { timeout: 60000 }, () => {
  for (let i = 0; i < 3; i++) {
    const result = planDate({ periodIds: ['morning', 'afternoon', 'evening', 'night'], area: 'near', school: 'scau', fatigueA: 0, fatigueB: 0, explorationSeed: `period-${i}` }, catalog, { exploration: 100 });
    checkRealScores(result);
    assert.equal(result.metrics.mealSatisfied, true);
    assert.equal(result.metrics.periodCoverageSatisfied, true);
    assert.equal(result.metrics.endingCoverageSatisfied, true);
    assert.equal(result.metrics.reserveSatisfied, true);
    for (const meal of result.mealRequirements) {
      assert.equal(meal.satisfied, true);
      const stage = result.stages[meal.stageIndex];
      assert.equal(stage.mealRole, meal.mealRole);
      assert.ok(stage.start >= meal.startMinute && stage.end <= meal.endMinute);
    }
  }
});

test('真实目录多seed覆盖和耗时对比（报告实测，不用易波动时钟作为通过门槛）', { timeout: 60000 }, t => {
  // 此项测量完整适配目录的探索覆盖；通用学校权限另由 school-scope 专测验证。
  const input = { periodIds: ['afternoon'], area: 'near', school: 'scau', campusArea: 'taishan', fatigueA: 2, fatigueB: 2 };
  planDate(input, catalog); planDate({ ...input, explorationSeed: 'warm' }, catalog, { exploration: 100 });
  const times = { low: [], high: [] }, nodes = { low: [], high: [] }, routes = new Set(), lowCards = new Set(), highCards = new Set();
  const lowTopFive = new Set(), highTopFive = new Set();
  let seedsWithProminentPending = 0;
  for (let i = 0; i < 8; i++) for (const mode of i % 2 ? ['high', 'low'] : ['low', 'high']) {
    const begin = performance.now();
    const result = planDate({ ...input, explorationSeed: `real-${i}` }, catalog, { exploration: mode === 'high' ? 100 : 0 });
    times[mode].push(performance.now() - begin); nodes[mode].push(result.search.expandedNodes);
    assert.equal(result.ok, true);
    const cards = mode === 'high' ? highCards : lowCards;
    result.stages[0].candidates.forEach(c => cards.add(c.sceneId));
    const front = result.stages[0].candidates.slice(0, 5);
    front.forEach(c => (mode === 'high' ? highTopFive : lowTopFive).add(c.sceneId));
    if (mode === 'high') {
      routes.add(route(result));
      checkRealScores(result);
      assert.equal(front[0].continuationFound, true, '保留一个已验证推荐位置');
      if (front.some(c => c.scoreStatus === 'pending')) seedsWithProminentPending++;
      if (i === 0 || i === 7) {
        const replayed = planDate(result.replay.context, catalog, { ...result.replay.search, exploration: 100, fixedPrefix: result.replay.prefix });
        assert.equal(replayed.outputFingerprint, result.outputFingerprint);
        assert.deepEqual(replayed.stages, result.stages);
      }
    }
  }
  const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
  assert.ok(routes.size >= 5);
  assert.ok([...highCards].some(id => !lowCards.has(id)), '真实目录首阶段展露原20张之外的场景');
  assert.equal(lowTopFive.size, 5);
  assert.ok(highTopFive.size >= lowTopFive.size * 3, '多seed真实目录前5覆盖至少扩大三倍');
  assert.ok(seedsWithProminentPending >= 6, '待评冷门场景应在多数seed进入前5，而非永远追加在尾部');
  t.diagnostic(JSON.stringify({ seeds: 8, routes: routes.size, lowCoverage: lowCards.size, highCoverage: highCards.size, topFiveCoverage: { low: lowTopFive.size, high: highTopFive.size }, seedsWithProminentPending, newScenes: [...highCards].filter(id => !lowCards.has(id)), medianMs: { low: +median(times.low).toFixed(2), high: +median(times.high).toFixed(2) }, medianNodes: { low: median(nodes.low), high: median(nodes.high) } }));
});

test('展示混排仅使用统一基础序位，q和localUtility尺度不进入展示噪声', () => {
  const explorer = createExploration(100, 'display-scale');
  const entries = Array.from({ length: 24 }, (_, i) => ({ id: `card-${i}`, continuationFound: i < 3, q: i < 3 ? 1000 - i : null, localUtility: 100 - i }));
  const options = { key: c => c.id, confirmed: c => c.continuationFound, scope: 'display' };
  const first = explorer.display(entries, 20, options);
  const scaled = explorer.display(entries.map(c => ({ ...c, q: c.q === null ? null : c.q * 100000, localUtility: c.localUtility * 0.00001 })), 20, options);
  assert.deepEqual(first.map(c => c.id), scaled.map(c => c.id));
  assert.equal(first[0].id, 'card-0');
  assert.ok(first.slice(1, 5).some(c => !c.continuationFound));
  assert.deepEqual(createExploration(0, 'display-scale').display(entries, 20, options), entries.slice(0, 20));
});

test('显式卡片上限仍生效，探索噪声独立于真实效用及调用顺序', () => {
  const input = { ...coverageContext, explorationSeed: 'limit' };
  const result = planDate(input, coverageCatalog, { ...coverageOptions, exploration: 100, candidateLimit: 7 });
  assert.ok(result.stages.every(s => s.candidates.length <= 7 && s.candidates.some(c => c.sceneId === s.sceneId)));
  const explorer = createExploration(100, 'noise');
  const first = explorer.noise('beam', 'path');
  explorer.noise('other', 'anything');
  assert.equal(explorer.noise('beam', 'path'), first);
  assert.ok(Math.abs(first) <= 1);
  assert.equal(createExploration(0, 'noise').noise('beam', 'path'), 0);
});
