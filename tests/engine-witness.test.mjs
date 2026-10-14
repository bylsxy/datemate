import test from 'node:test';
import assert from 'node:assert/strict';
import { planDate, createContinuationSearch, verifyPlanWitness, VERSION } from '../engine.mjs';

const scene = (id, extra = {}) => ({ id, minutes: 20, cost: [0, 0], load: 0, kind: id, area: 'campus', indoor: true, quiet: true, fit: 70, activities: [], ...extra });
const action = (id, extra = {}) => ({ id, cost: [0, 0], load: 0, ...extra });
const fixture = scenes => ({ version: 'witness-fixture', scenes, transfers: { campus: { campus: 0 } }, departures: [{ id: 'separate', minutes: 15, cost: [0, 0] }, { id: 'walk_together', minutes: 20, cost: [1, 2] }] });
const context = { duration: 180, reserve: 0, robust: false, fatigueA: 0, fatigueB: 0, explorationSeed: 'witness-seed' };
const opts = { maxStages: 3, beamWidth: 24, maxExpandedNodes: 3000, maxCandidateExpandedNodes: 1000 };
const finish = iterator => { let step; do { step = iterator.next(); } while (!step.done); return step.value; };
const choice = stage => ({ sceneId: stage.sceneId, activityIds: stage.activityIds, ...(stage.mealRole ? { mealRole: stage.mealRole } : {}), ...(Number.isFinite(stage.fixedStartMinute) ? { startMinute: stage.fixedStartMinute } : {}), ...(stage.anchorId !== undefined ? { anchorId: stage.anchorId } : {}) });

test('每个已评候选有产生其真实q的完整compact见证，快捷验证不展开搜索且不修改输入', () => {
  const data = fixture([scene('prepare', { provides: ['kit'] }), scene('play', { requires: ['kit'], activities: [action('actual', { tags: ['play'], cost: [1, 2], load: 1 })] }), scene('walk')]);
  const input = { ...context, preferencesA: ['play'], preferencesB: ['play'] };
  const result = planDate(input, data, { ...opts, exploration: 61 });
  assert.equal(result.ok, true, result.errors?.join(';'));
  assert.equal(VERSION, 'datemate-engine-4.0.0');
  assert.deepEqual(result.continuationWitness, result.stages.map(choice));
  let checked = 0;
  for (const stage of result.stages) for (const candidate of stage.candidates) {
    if (!candidate.continuationFound) { assert.equal(candidate.continuationWitness, undefined); continue; }
    const fixedPrefix = [...result.stages.slice(0, stage.index).map(choice), choice({ ...candidate, fixedStartMinute: candidate.fixedStartMinute })];
    const options = { ...opts, fixedPrefix, knownPlan: candidate.continuationWitness, exploration: 61 };
    const before = JSON.stringify({ input, data, options });
    const verified = verifyPlanWitness(input, data, options);
    assert.equal(verified.ok, true, verified.errors?.join(';'));
    assert.equal(verified.q, candidate.q);
    assert.equal(verified.prefixUtility, stage.scoreReference.prefixUtility);
    assert.equal(verified.referenceUtility, stage.scoreReference.referenceUtility);
    assert.equal(verified.search.expandedNodes, 0);
    assert.equal(verified.explorationNoiseEnabled, false);
    assert.equal(JSON.stringify({ input, data, options }), before);
    for (const part of verified.continuationWitness) assert.ok(Object.keys(part).every(key => ['sceneId', 'activityIds', 'mealRole', 'startMinute', 'anchorId'].includes(key)));
    assert.ok(verified.continuationWitness.every((part, i) => Object.hasOwn(part, 'startMinute') === Number.isFinite(verified.stages[i].fixedStartMinute)));
    checked++;
  }
  assert.ok(checked > 3);
});

test('有效见证兜底极小搜索预算，保留新搜索，并可从replay重放所有fingerprint', () => {
  const data = fixture([scene('a-decoy'), scene('seed', { provides: ['kit'] }), scene('target', { requires: ['kit'] })]);
  const input = { ...context, requiredSceneIds: ['target'] };
  const knownPlan = [{ sceneId: 'seed', activityIds: [] }, { sceneId: 'target', activityIds: [] }];
  const limited = { ...opts, maxExpandedNodes: 1, maxCandidateExpandedNodes: 0, exploration: 49 };
  assert.equal(planDate(input, data, limited).ok, false);
  const result = planDate(input, data, { ...limited, knownPlan });
  assert.equal(result.ok, true, result.errors?.join(';'));
  assert.equal(result.search.expandedNodes, 1);
  assert.equal(result.search.knownPlan.status, 'verified');
  assert.deepEqual(result.replay.knownPlan, knownPlan);
  const replay = result.replay;
  const repeated = planDate({ ...replay.context, anchors: replay.anchors }, data, { ...replay.search, fixedPrefix: replay.prefix, knownPlan: replay.knownPlan, exploration: replay.exploration, explorationSeed: replay.explorationSeed, expectedVersions: replay.versions });
  for (const field of ['fingerprint', 'inputDigest', 'outputFingerprint', 'outputDigest']) assert.equal(repeated[field], result[field], field);
  const continuation = finish(createContinuationSearch(input, data, { ...limited, fixedPrefix: [knownPlan[0]], knownPlan }));
  const verified = verifyPlanWitness(input, data, { ...limited, fixedPrefix: [knownPlan[0]], knownPlan });
  assert.equal(continuation.ok, true);
  assert.equal(continuation.q, verified.q);
  assert.deepEqual(continuation.continuationWitness, knownPlan);
});

test('同地点普通到访与无index预约身份不混淆，固定prefix和预约时间必须重验', () => {
  const data = fixture([scene('place')]);
  const input = { ...context, anchors: [{ id: 'booking', sceneId: 'place', activityIds: [], startMinute: 100 }] };
  const knownPlan = [{ sceneId: 'place', activityIds: [] }, { sceneId: 'place', activityIds: [], startMinute: 100, anchorId: 'booking' }];
  const options = { ...opts, maxStages: 2, maxExpandedNodes: 1, fixedPrefix: [knownPlan[0]], knownPlan };
  const result = planDate(input, data, options);
  assert.equal(result.ok, true, result.errors?.join(';'));
  assert.deepEqual(result.stages.map(s => [s.start, s.anchorId]), [[0, undefined], [100, 'booking']]);
  const verified = verifyPlanWitness(input, data, options);
  assert.equal(verified.ok, true);
  assert.equal(verified.prefixUtility, 0);
  assert.deepEqual(verified.continuationWitness, knownPlan);
  const replay = result.replay;
  const again = planDate({ ...replay.context, anchors: replay.anchors }, data, { ...replay.search, fixedPrefix: replay.prefix, knownPlan: replay.knownPlan, exploration: replay.exploration });
  assert.equal(again.outputDigest, result.outputDigest);
  assert.equal(again.fingerprint, result.fingerprint);
  for (const [changed, changedOptions, code] of [
    [{ ...input, anchors: [{ ...input.anchors[0], startMinute: 110 }] }, options, 'H_ANCHOR_TIME'],
    [input, { ...options, knownPlan: knownPlan.map(p => ({ ...p, anchorId: undefined })) }, 'H_ANCHOR'],
    [input, { ...options, knownPlan: [knownPlan[0], { ...knownPlan[1], anchorId: 'fake' }] }, 'H_ANCHOR_PREFIX'],
    [input, { ...options, fixedPrefix: [{ ...knownPlan[0], startMinute: 5 }] }, 'H_KNOWN_PREFIX'],
    [input, { ...options, fixedPrefix: [{ ...knownPlan[0], anchorId: 'booking' }] }, 'H_KNOWN_PREFIX'],
  ]) {
    const invalid = verifyPlanWitness(changed, data, changedOptions);
    assert.equal(invalid.ok, false);
    assert.match(invalid.errors.join(';'), new RegExp(code));
  }
});

test('预算、疲劳、资源消耗、依赖、同意、饮食与开放时间按当前context和catalog重验', () => {
  const data = fixture([
    scene('buy', { provides: { kit: 1 } }),
    scene('use', { cost: [1, 2], load: 2, requires: { kit: 1 }, activities: [action('touch', { requiresExplicitConsent: true, consumes: { kit: 1 }, dietaryTags: ['nuts'] })] }),
    scene('required'),
  ]);
  const input = { ...context, budget: 5, explicitConsentIds: ['touch'], requiredSceneIds: ['required'] };
  const knownPlan = [{ sceneId: 'buy', activityIds: [] }, { sceneId: 'use', activityIds: ['touch'] }, { sceneId: 'required', activityIds: [] }];
  const options = { ...opts, knownPlan };
  const accepted = verifyPlanWitness(input, data, options);
  assert.equal(accepted.ok, true, accepted.errors?.join(';'));
  assert.equal(accepted.stages[1].after.resources.kit, 0);
  for (const [changed, code] of [[{ budget: 1.99 }, 'H_BUDGET'], [{ maxLoad: 1 }, 'H_LOAD'], [{ explicitConsentIds: [] }, 'H_CONSENT'], [{ dietaryRestrictions: ['nuts'] }, 'H_DIET'], [{ availability: { use: 'unavailable' } }, 'H_AVAILABILITY'], [{ duration: 39 }, 'H_TIME_WINDOW']]) {
    const bad = verifyPlanWitness({ ...input, ...changed }, data, options);
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join(';'), new RegExp(code));
  }
  for (const [changed, code] of [
    [{ ...data, scenes: data.scenes.map(s => s.id === 'buy' ? { ...s, provides: {} } : s) }, 'H_PREPARATION'],
    [{ ...data, scenes: data.scenes.map(s => s.id === 'required' ? { ...s, requires: { kit: 1 } } : s) }, 'H_PREPARATION'],
    [{ ...data, scenes: data.scenes.map(s => s.id === 'use' ? { ...s, windows: [{ startMinute: 100, endMinute: 110 }] } : s) }, 'H_TIME_WINDOW'],
    [{ ...data, scenes: data.scenes.map(s => s.id === 'use' ? { ...s, activities: [action('touch', { predecessorIds: ['absent'] })] } : s) }, 'H_PREDECESSOR'],
  ]) {
    const bad = verifyPlanWitness(input, changed, options);
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join(';'), new RegExp(code));
  }
  const incomplete = verifyPlanWitness(input, data, { ...options, knownPlan: knownPlan.slice(0, 2) });
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.errors.join(';'), /H_REQUIRED_SCENE/);
});

test('无效见证被ignored且不写入replay，不替代正常搜索；同seed普通结果保持确定', () => {
  const data = fixture([scene('a'), scene('b', { cost: [1, 2] })]);
  const input = { ...context, budget: 0 };
  const options = { ...opts, exploration: 72 };
  const ordinary = planDate(input, data, options);
  const invalid = planDate(input, data, { ...options, knownPlan: [{ sceneId: 'b', activityIds: [], q: 999999 }] });
  assert.equal(invalid.ok, true);
  assert.equal(invalid.search.knownPlan.status, 'ignored');
  assert.equal(Object.hasOwn(invalid.replay, 'knownPlan'), false);
  assert.deepEqual(invalid.continuationWitness, ordinary.continuationWitness);
  assert.equal(invalid.outputDigest, ordinary.outputDigest);
  assert.equal(invalid.fingerprint, ordinary.fingerprint);
  assert.equal(planDate(input, data, options).outputDigest, ordinary.outputDigest);
  assert.equal(verifyPlanWitness(input, data, options).ok, false);
  assert.equal(verifyPlanWitness(input, data, { ...options, knownPlan: {} }).ok, false);
  assert.equal(verifyPlanWitness(input, data, { ...options, knownPlan: [{ sceneId: 'a', activityIds: [], startMinute: -1 }] }).ok, false);
  const genuine = verifyPlanWitness(input, data, { ...options, knownPlan: ordinary.continuationWitness });
  const forgedMetadata = verifyPlanWitness(input, data, { ...options, knownPlan: ordinary.continuationWitness.map(part => ({ ...part, q: 999999, costCents: [0, 0], after: { resources: { kit: 9999 }, fatigue: [0, 0] } })) });
  assert.equal(forgedMetadata.q, genuine.q);
  assert.deepEqual(forgedMetadata.stages, genuine.stages);
});

test('饭点角色、固定餐馆、时段覆盖、分别费用和缓冲在完整见证重验中生效', () => {
  const eat = action('eat-breakfast', { provides: ['meal_completed'], mealRoles: ['breakfast'], exclusiveKey: 'main_meal' });
  const data = fixture([scene('food', { kind: 'meal', mealRoles: ['breakfast'], activities: [eat] }), scene('walk', { minutes: 40 }), scene('other-food', { kind: 'meal', mealRoles: ['breakfast'], activities: [eat] })]);
  const input = { ...context, periodIds: ['morning'], mealChoices: { breakfast: { sceneId: 'food', activityIds: ['eat-breakfast'] } } };
  const result = planDate(input, data, { ...opts, maxStages: 8, maxExpandedNodes: 18000 });
  assert.equal(result.ok, true, result.errors?.join(';'));
  const options = { maxStages: 8, knownPlan: result.continuationWitness };
  assert.equal(verifyPlanWitness(input, data, options).ok, true);
  for (const stage of result.stages) for (const candidate of stage.candidates.filter(c => c.continuationFound)) {
    const fixedPrefix = [...result.stages.slice(0, stage.index).map(choice), choice({ ...candidate, fixedStartMinute: candidate.fixedStartMinute })];
    const verified = verifyPlanWitness(input, data, { ...options, knownPlan: candidate.continuationWitness, fixedPrefix });
    assert.equal(verified.ok, true, verified.errors?.join(';'));
    assert.equal(verified.q, candidate.q);
    assert.equal(verified.prefixUtility, stage.scoreReference.prefixUtility);
  }
  const wrongRole = result.continuationWitness.map(p => p.mealRole ? { ...p, mealRole: 'dinner' } : p);
  assert.match(verifyPlanWitness(input, data, { ...options, knownPlan: wrongRole }).errors.join(';'), /H_MEAL_ROLE/);
  assert.match(verifyPlanWitness({ ...input, mealChoices: { breakfast: { sceneId: 'other-food', activityIds: ['eat-breakfast'] } } }, data, options).errors.join(';'), /H_MEAL_CHOICE/);
  const short = verifyPlanWitness(input, data, { ...options, knownPlan: result.continuationWitness.slice(0, 1) });
  assert.equal(short.ok, false);
  assert.match(short.errors.join(';'), /H_END_COVERAGE/);
  const expensive = verifyPlanWitness({ ...input, departureChoice: 'walk_together', budget: 1 }, data, options);
  assert.equal(expensive.ok, false);
  assert.match(expensive.errors.join(';'), /H_BUDGET/);
  const noBuffer = verifyPlanWitness({ ...input, reserve: 180 }, data, options);
  assert.equal(noBuffer.ok, false);
  assert.match(noBuffer.errors.join(';'), /H_TIME_WINDOW/);
  const tooShort = verifyPlanWitness({ ...input, endAfterStage: 0 }, data, options);
  assert.equal(tooShort.ok, false);
  assert.match(tooShort.errors.join(';'), /H_KNOWN_PLAN/);
});

test('人工前缀反事实候选的q绑定各自终态；已知低效见证仍允许新搜索找到更好方案', () => {
  const data = fixture([scene('manual', { fit: 1 }), scene('best', { fit: 99 }), scene('middle', { fit: 50 })]);
  const knownPlan = [{ sceneId: 'manual', activityIds: [] }];
  const verified = verifyPlanWitness(context, data, { ...opts, knownPlan });
  const improved = finish(createContinuationSearch(context, data, { ...opts, knownPlan }));
  assert.equal(improved.ok, true);
  assert.ok(improved.q > verified.q);
  assert.ok(improved.search.expandedNodes > 0);
  const result = planDate(context, data, { ...opts, fixedPrefix: knownPlan });
  assert.equal(result.ok, true);
  assert.ok(result.stages[0].candidates.some(c => c.sceneId !== 'manual' && c.continuationFound));
  for (const candidate of result.stages[0].candidates.filter(c => c.continuationFound)) {
    const checked = verifyPlanWitness(context, data, { ...opts, knownPlan: candidate.continuationWitness, fixedPrefix: [choice({ ...candidate, fixedStartMinute: candidate.fixedStartMinute })] });
    assert.equal(checked.ok, true, checked.errors?.join(';'));
    assert.equal(checked.q, candidate.q);
  }
});
