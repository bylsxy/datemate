import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalize, planDate } from '../engine.mjs';
import { forwardChain, DEFAULT_RULES } from '../reasoning.mjs';
import { preferencePolicy } from '../preference-policy.mjs';
import { createExploration } from '../exploration.mjs';

const scene = (id, extra = {}) => ({ id, minutes: 30, cost: [0, 0], load: 0, kind: 'ordinary', indoor: true, area: 'campus', quiet: true, fit: 70, novelty: 30, tags: [], activities: [], ...extra });
const base = { duration: 120, reserve: 0, robust: false, fatigueA: 0, fatigueB: 0 };
const manualRules = JSON.parse(fs.readFileSync(new URL('../knowledge/rules.json', import.meta.url))).rules;
const data = scenes => ({ scenes, rules: manualRules, transfers: { campus: { campus: 0 } } });
const fixed = (input, scenes, ids = []) => planDate({ ...base, ...input, fixedPrefix: [{ sceneId: scenes[0].id, activityIds: ids }] }, data(scenes), { maxStages: 1 });

test('全部新枚举规范化，unknown兼容多云，默认值稳定且不推断周期或同意', () => {
  const ctx = normalize({ weather: 'unknown', weekPart: 'bad', relationship: 'bad', cyclePhase: 'bad', personalityA: 'infp', personalityB: 'wrong', themes: ['chinese', 'japanese', 'chinese', 'wrong'], mood: 'happy', energy: 'tense', season: 'exam', mentalDemand: 'high', occasion: 'confession', planStyle: 'steady', reunion: true });
  assert.equal(ctx.weather, 'cloudy'); assert.equal(ctx.weekPart, 'weekday'); assert.equal(ctx.relationship, 'any');
  assert.equal(ctx.cyclePhase, 'none'); assert.equal(ctx.personalityA, 'INFP'); assert.equal(ctx.personalityB, '');
  assert.deepEqual(ctx.themes, ['chinese', 'japanese']); assert.deepEqual(ctx.dietaryRestrictions, []); assert.deepEqual(ctx.explicitConsentIds, []);
  for (const [key, value] of Object.entries({ mood: 'happy', energy: 'tense', season: 'exam', mentalDemand: 'high', occasion: 'confession', planStyle: 'steady', reunion: true })) assert.equal(ctx[key], value);
});

test('雨天安静人少认知疲劳关系人格为软偏好，保留预算时间资源排除及明确忌口', () => {
  const s = scene('out', { indoor: false, quiet: false, crowded: true, crowdRisk: 'high', weather: ['clear'], mental: 5, load: 2 });
  const input = { weather: 'rain', quietRequired: true, crowdAvoidance: true, mentalLow: true, energy: 'tired', relationship: 'first', personalityA: 'INFP' };
  const result = fixed(input, [s]); assert.equal(result.ok, true, result.errors.join());
  assert.ok(result.stages[0].featureContributions.SOFT_RAIN < 0); assert.ok(result.trace.some(t => t.ruleId === 'CORE_WET_WARNING'));
  for (const [extra, patch, error] of [[{ budget: 9 }, { cost: [10, 10] }, 'H_BUDGET'], [{ duration: 20 }, {}, 'H_TIME_WINDOW'], [{ bans: ['out'] }, {}, 'H_EXCLUDED'], [{ dietaryRestrictions: ['spicy'] }, { dietaryTags: ['spicy'] }, 'H_DIET'], [{}, { requires: { tent: 1 } }, 'H_PREPARATION'], [{ maxLoad: 1 }, {}, 'H_LOAD']]) {
    const rejected = fixed({ ...input, ...extra }, [{ ...s, ...patch }]); assert.equal(rejected.ok, false); assert.match(rejected.errors.join(), new RegExp(error));
  }
});

test('手工规则把疲劳雨天安静人流降为软分，产生式推导仍有作用与trace', () => {
  const rules = JSON.parse(fs.readFileSync(new URL('../knowledge/rules.json', import.meta.url))).rules;
  const result = forwardChain({ context: { weather: 'rain', fatigueA: 6, fatigueB: 0, quietRequired: true, crowdAvoidance: true }, scene: { id: 'out', indoor: false, quiet: false, crowdRisk: 'high', load: 4 }, activity: { id: 'a', load: 3 } }, [...DEFAULT_RULES, ...rules]);
  assert.deepEqual(result.excludedSceneIds, []); assert.deepEqual(result.excludedActivityIds, []);
  assert.ok(result.scenePreferences.out < 0); assert.ok(result.activityPreferences.a < 0);
  assert.ok(result.trace.some(t => t.ruleId === 'R-fatigue-derive')); assert.ok(result.trace.some(t => t.ruleId === 'R-rain-outdoor'));
});

test('晴天户外只有简短防晒提醒；周期不推断忌口、同意或牛排功效', () => {
  const s = scene('park', { indoor: false });
  const sunny = fixed({ weather: 'clear' }, [s]); assert.ok(sunny.warnings.some(w => /防晒/.test(w)));
  const steak = scene('meal', { kind: 'meal', seated: true, tags: ['steak'], activities: [{ id: 'private', requiresExplicitConsent: true, cost: [0, 0], load: 0 }] });
  for (const cyclePhase of ['before', 'during', 'after']) {
    const result = fixed({ cyclePhase }, [steak]); assert.equal(result.ok, true);
    assert.deepEqual(result.context.dietaryRestrictions, []); assert.ok(!JSON.stringify(result.trace).includes('回血'));
    assert.equal(fixed({ cyclePhase }, [steak], ['private']).ok, false);
  }
  const warm = fixed({ cyclePhase: 'during' }, [steak]); assert.ok(warm.stages[0].featureContributions.SOFT_CYCLE_COMFORT > 0);
});

test('开心促进一方兴趣与交换爱好，主题与人格低权重可解释且图谱仍参与', () => {
  const s = scene('hobby', { tags: ['music', 'shared_hobby', 'japanese'], socialDemand: 0 });
  const result = fixed({ mood: 'happy', preferencesA: ['music'], themes: ['japanese'], personalityA: 'INFP' }, [s]);
  assert.equal(result.ok, true); assert.ok(result.trace.some(t => t.ruleId === 'KG_PREFERENCE_PATH'));
  const features = result.stages[0].featureContributions;
  assert.ok(features.SOFT_HOBBY_EXCHANGE > 0); assert.equal(features.SOFT_THEMES, 6); assert.ok(features.SOFT_PERSONALITY <= 4);
});

test('同场地所选活动社交性改变初次约会与MBTI软分，未选活动不影响', () => {
  const s = scene('games', { socialDemand: 0, activities: [{ id: 'duo', socialDemand: 0, cost: [0, 0], load: 0 }, { id: 'group', socialDemand: 3, cost: [0, 0], load: 0 }] });
  const duo = fixed({ relationship: 'first', personalityA: 'INFP' }, [s], ['duo']);
  const group = fixed({ relationship: 'first', personalityA: 'INFP' }, [s], ['group']);
  assert.equal(duo.ok, true); assert.equal(group.ok, true);
  assert.ok(duo.stages[0].featureContributions.SOFT_FIRST_MEETING > group.stages[0].featureContributions.SOFT_FIRST_MEETING);
  assert.equal(fixed({}, [{ ...s, socialDemand: 4 }]).status, 'invalid_data');
});

test('周中周末费用进入阶段、候选、预算与总金额，队列仅降低软分', () => {
  const s = scene('week', { costByWeekPart: { weekday: [10, 20], weekend: [30, 50] }, queueMinutesByWeekPart: { weekday: 0, weekend: 30 } });
  const weekday = fixed({ budget: 20 }, [s]); const weekend = fixed({ weekPart: 'weekend', budget: 50 }, [s]);
  assert.deepEqual(weekday.totalCost, [10, 20]); assert.deepEqual(weekend.totalCost, [30, 50]);
  assert.deepEqual(weekend.stages[0].costCents, [3000, 5000]); assert.deepEqual(weekend.stages[0].candidates.find(c => c.sceneId === 'week').cost, [30, 50]);
  assert.ok(weekend.trace.some(t => t.ruleId === 'R-weekend-queue'));
  assert.equal(fixed({ weekPart: 'weekend', budget: 49.99 }, [s]).ok, false);
});

test('梦幻场景仅探索100出现且提高排序，固定前缀也不能绕过任何硬约束', () => {
  const dream = scene('dream', { dreamOnly: true, tags: ['dream', 'travel'] });
  for (const exploration of [0, 50, 99]) { const r = fixed({ exploration }, [dream]); assert.equal(r.ok, false); assert.match(r.errors.join(), /H_DREAM_ONLY/); }
  const r = fixed({ exploration: 100 }, [dream]); assert.equal(r.ok, true); assert.equal(r.stages[0].featureContributions.SOFT_DREAM, 55);
  assert.equal(fixed({ exploration: 100, budget: 0 }, [{ ...dream, cost: [1, 1] }]).ok, false);
  assert.equal(fixed({ exploration: 100, area: 'campus' }, [{ ...dream, area: 'off' }]).ok, false);
  assert.equal(fixed({ exploration: 100 }, [{ ...dream, requires: { passport: 1 } }]).ok, false);
  assert.equal(fixed({ exploration: 100, duration: 20 }, [dream]).ok, false);
  const plain = scene('plain');
  const ctx = normalize(base);
  assert.ok(preferencePolicy(ctx, dream, dream, dream.tags, new Set(), 100).score > preferencePolicy(ctx, plain, plain, [], new Set(), 100).score);
  const explorer = createExploration(100, 'test');
  const entries = Array.from({ length: 20 }, (_, i) => ({ id: i, dream: i === 19 }));
  const shown = explorer.display(entries, 5, { key: x => x.id, confirmed: () => false, scope: 'test', dream: x => x.dream });
  assert.ok(shown.some(x => x.dream));
});

test('camping明确选择且仅跨午夜，费用和停留预留仍独立核算', () => {
  const catalog = { ...data([scene('walk')]), departures: [{ id: 'separate', minutes: 10, cost: [0, 0] }, { id: 'camping', minutes: 15, cost: [20, 40], onlyOvernight: true, requiresExplicitChoice: true }] };
  const input = { periodIds: ['night'], exploration: 80, reserve: 0, robust: false, fatigueA: 0, fatigueB: 0, anchors: [{ choice: { sceneId: 'walk', activityIds: [] }, startMinute: 1485, index: 0 }] };
  const r = planDate({ ...input, departureChoice: 'camping', budget: 40 }, catalog, { maxStages: 1 });
  assert.equal(r.ok, true, r.errors.join()); assert.equal(r.departure.id, 'camping'); assert.equal(r.departure.manualOnly, true); assert.deepEqual(r.totalCostCents, [2000, 4000]);
  assert.equal(r.departure.endMinute - r.departure.startMinute, 15);
  assert.equal(planDate({ ...input, departureChoice: 'camping', budget: 39.99 }, catalog, { maxStages: 1 }).ok, false);
  assert.equal(planDate({ ...input, departureChoice: 'camping', reserve: 1 }, catalog, { maxStages: 1 }).ok, false);
  assert.equal(planDate({ ...input, exploration: 100 }, catalog, { maxStages: 1 }).departure.id, 'separate');
  assert.match(planDate({ periodIds: ['afternoon'], departureChoice: 'camping' }, catalog).errors.join(), /H_DEPARTURE_OVERNIGHT/);
});

test('新增状态通过事实推导匹配产生式场景，重逢图谱路径与同意约束同时保留', () => {
  const cases = [
    [{ relationship: 'longterm' }, scene('fresh', { novelty: 80 }), 'R-longterm-novelty'],
    [{ relationship: 'longterm' }, scene('dorm_gate', { novelty: 20, tags: ['daily'] }), 'R-longterm-familiar'],
    [{ season: 'exam' }, scene('campus_short'), 'R-exam-campus-short'],
    [{ reunion: true }, scene('reunion', { tags: ['private', 'shared_hobby'] }), 'R-reunion-scene'],
    [{ weekPart: 'weekday' }, scene('empty', { uncrowded: true }), 'R-weekday-uncrowded'],
  ];
  for (const [input, s, ruleId] of cases) {
    const result = fixed(input, [s]); assert.equal(result.ok, true);
    const step = result.trace.find(t => t.ruleId === ruleId); assert.ok(step, ruleId);
    assert.ok(step.inputFacts.some(f => f.id.startsWith('derived.')));
    if (input.reunion) assert.ok(result.trace.some(t => t.ruleId === 'KG_PREFERENCE_PATH' && t.inputFacts.some(f => f.id === 'context.reunion')));
  }
  const s = scene('private', { activities: [{ id: 'close', tags: ['shared_hobby'], requiresExplicitConsent: true, cost: [0, 0], load: 0 }] });
  assert.match(fixed({ reunion: true }, [s], ['close']).errors.join(), /H_CONSENT/);
  const consented = fixed({ reunion: true, explicitConsentIds: ['close'] }, [s], ['close']);
  assert.ok(consented.trace.some(t => t.ruleId === 'R-reunion-activity'));
});

test('场景级前置不可由空活动绕过，完成前置后可进入且保留费用时间核算', () => {
  const travel = scene('travel', { cost: [10, 20] }), destination = scene('destination', { predecessorIds: ['travel'], cost: [5, 5] });
  assert.match(fixed({}, [destination]).errors.join(), /H_PREDECESSOR/);
  const result = planDate({ ...base, fixedPrefix: [{ sceneId: 'travel', activityIds: [] }, { sceneId: 'destination', activityIds: [] }] }, data([travel, destination]), { maxStages: 2 });
  assert.equal(result.ok, true, result.errors.join()); assert.deepEqual(result.totalCostCents, [1500, 2500]);
  assert.deepEqual(result.stages.map(s => s.sceneId), ['travel', 'destination']);
});
