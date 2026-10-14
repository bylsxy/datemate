import test from 'node:test';
import assert from 'node:assert/strict';
import {projectStageChoice, selectStageIntent, selectMealIntent, exploreIntent} from '../planning-intent.mjs';

const catalog = {scenes: ['a', 'b', 'c', 'food', 'other-food'].map(id => ({
  id, activities: [{id: 'walk'}, {id: 'meal'}, {id: 'touch', requiresExplicitConsent: true}],
}))};
const stage = (sceneId, extra = {}) => ({sceneId, activityIds: ['walk'], startMinute: 100, fixedStartMinute: null, ...extra});
const result = {ok: true, stages: [stage('a', {fixedStartMinute: 40}), stage('b'), stage('c')]};
const state = (extra = {}) => ({
  exploration: 12, prefix: [],
  context: {budget: 80, periodIds: ['afternoon'], endAfterStage: 2, departureChoice: 'walk_together',
    requiredSceneIds: ['c'], bans: ['outside'], mealChoices: {}, explicitConsentIds: ['stale'], explorationSeed: 7},
  ...extra,
});
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('真实stage投影保留餐次和显式预约，自动排程不能转为预约', () => {
  const actual = stage('food', {mealRole: 'lunch', fixedStartMinute: 0, activityIds: ['meal']});
  assert.deepEqual(projectStageChoice(actual), {sceneId: 'food', activityIds: ['meal'], mealRole: 'lunch', startMinute: 0});
  assert.equal(Object.hasOwn(projectStageChoice(stage('a')), 'startMinute'), false);
  const projected = projectStageChoice(actual);
  projected.activityIds.push('walk');
  assert.deepEqual(actual.activityIds, ['meal']);
});

test('阶段点击固定实际0到current，裁掉后续人工前缀并保留硬上限', () => {
  const input = state({prefix: [{sceneId: 'a', activityIds: ['walk']}, {sceneId: 'b', activityIds: ['walk']}, {sceneId: 'c', activityIds: ['touch']}]});
  const next = selectStageIntent(input, result, 1, 'b', ['touch'], catalog);
  assert.deepEqual(next.prefix, [{sceneId: 'a', activityIds: ['walk'], startMinute: 40}, {sceneId: 'b', activityIds: ['touch']}]);
  assert.deepEqual(next.context.explicitConsentIds, ['touch']);
  assert.equal(next.context.endAfterStage, 2);
  assert.equal(next.context.explorationSeed, 7);
});

test('连续点击保留前序待提交场景和活动，不依赖旧result已刷新', () => {
  const first = selectStageIntent(state(), result, 0, 'c', ['touch'], catalog);
  const second = selectStageIntent(first, result, 1, 'b', ['walk'], catalog);
  assert.deepEqual(second.prefix, [{sceneId: 'c', activityIds: ['touch']}, {sceneId: 'b', activityIds: ['walk']}]);
  assert.deepEqual(second.context.explicitConsentIds, ['touch']);
  assert.equal(Object.hasOwn(second.prefix[0], 'startMinute'), false);
});

test('同场景活动更新保留真实和待提交的显式预约，换场景释放旧预约', () => {
  const same = selectStageIntent(state(), result, 0, 'a', ['touch'], catalog);
  assert.equal(same.prefix[0].startMinute, 40);
  const pending = state({prefix: [{sceneId: 'b', activityIds: ['walk'], startMinute: 75}]});
  assert.equal(selectStageIntent(pending, result, 0, 'b', ['touch'], catalog).prefix[0].startMinute, 75);
  assert.equal(Object.hasOwn(selectStageIntent(pending, result, 0, 'c', [], catalog).prefix[0], 'startMinute'), false);
});

test('pending餐次身份不匹配真实槽位时忽略，后续pending不会被带入', () => {
  const input = state({prefix: [{sceneId: 'food', activityIds: ['meal'], mealRole: 'breakfast'}, {sceneId: 'b', activityIds: []}, {sceneId: 'c', activityIds: ['touch']}]});
  const next = selectStageIntent(input, result, 1, 'b', [], catalog);
  assert.deepEqual(next.prefix[0], {sceneId: 'a', activityIds: ['walk'], startMinute: 40});
  assert.equal(next.prefix.length, 2);
  assert.deepEqual(next.context.explicitConsentIds, []);
});

test('真实餐馆切换固定前序并保留其它餐次，当前餐仅由mealChoices表达', () => {
  const meals = {ok: true, stages: [stage('a', {fixedStartMinute: 40}), stage('food', {mealRole: 'lunch', activityIds: ['meal']}), stage('c')]};
  const input = state();
  input.context.mealChoices = {lunch: {sceneId: 'food', activityIds: ['meal']}, dinner: {sceneId: 'food', activityIds: ['meal']}};
  const next = selectMealIntent(input, meals, 'lunch', {sceneId: 'other-food', activityIds: ['meal', 'touch']}, 1, catalog);
  assert.deepEqual(next.prefix, [{sceneId: 'a', activityIds: ['walk'], startMinute: 40}]);
  assert.deepEqual(next.context.mealChoices.lunch, {sceneId: 'other-food', activityIds: ['meal', 'touch']});
  assert.deepEqual(next.context.mealChoices.dinner, input.context.mealChoices.dinner);
  assert.deepEqual(next.context.explicitConsentIds, ['touch']);
});

test('虚拟餐卡同index不吞入普通阶段，首端和末端插入均支持', () => {
  const breakfast = selectMealIntent(state(), result, 'breakfast', {mode: 'before_meeting'}, 0, catalog);
  assert.deepEqual(breakfast.prefix, []);
  assert.deepEqual(breakfast.context.mealChoices.breakfast, {mode: 'before_meeting'});
  const inserted = selectMealIntent(breakfast, result, 'breakfast', {sceneId: 'food', activityIds: ['meal']}, 0, catalog);
  assert.deepEqual(inserted.prefix, []);
  const supper = selectMealIntent(state(), result, 'supper', {mode: 'skip'}, result.stages.length, catalog);
  assert.equal(supper.prefix.length, result.stages.length);
  assert.equal(supper.prefix.some(choice => choice.mealRole === 'supper'), false);
});

test('餐次点击也保留前序未完成选择并重算同意，不重复固定已经经过的同餐次', () => {
  const input = state({prefix: [{sceneId: 'b', activityIds: ['touch'], startMinute: 60}]});
  const next = selectMealIntent(input, result, 'lunch', {sceneId: 'food', activityIds: ['meal']}, 1, catalog);
  assert.deepEqual(next.prefix, [{sceneId: 'b', activityIds: ['touch'], startMinute: 60}]);
  assert.deepEqual(next.context.explicitConsentIds, ['touch']);
  const misplaced = {ok: true, stages: [stage('food', {mealRole: 'lunch', activityIds: ['meal']}), stage('b')]};
  assert.throws(() => selectMealIntent(state(), misplaced, 'lunch', {sceneId: 'food', activityIds: ['meal']}, 1, catalog), /边界/);
});

test('探索释放所有真实选择与旧同意，保留特殊用餐、硬条件、分别及结束上限', () => {
  const input = state({prefix: [{sceneId: 'a', activityIds: ['touch'], startMinute: 40}]});
  input.context.mealChoices = {breakfast: {mode: 'before_meeting'}, lunch: {sceneId: 'food', activityIds: ['meal']}, dinner: {sceneId: 'other-food', activityIds: ['meal']}, supper: {mode: 'skip'}};
  input.context.anchors = [{index: 2, startMinute: 200, choice: {sceneId: 'c', activityIds: ['walk']}}];
  input.context.dietaryRestrictions = ['gluten'];
  input.context.weather = 'rain';
  const next = exploreIntent(input, 97, 0xffffffff);
  assert.equal(next.exploration, 97);
  assert.deepEqual(next.prefix, []);
  assert.deepEqual(next.context.mealChoices, {breakfast: {mode: 'before_meeting'}, supper: {mode: 'skip'}});
  assert.deepEqual(next.context.explicitConsentIds, []);
  assert.equal(next.context.explorationSeed, 0xffffffff);
  const expected = structuredClone(input.context);
  expected.mealChoices = next.context.mealChoices;
  expected.explicitConsentIds = [];
  expected.explorationSeed = 0xffffffff;
  assert.deepEqual(next.context, expected);
});

test('探索接受零seed，拒绝非uint32和非整数探索度', () => {
  assert.equal(exploreIntent(state(), 0, 0).context.explorationSeed, 0);
  for (const seed of [-1, 2 ** 32, 1.5, '7', NaN, undefined]) assert.throws(() => exploreIntent(state(), 97, seed), /uint32/);
  for (const exploration of [-1, 101, 1.5, '97']) assert.throws(() => exploreIntent(state(), exploration, 0), /探索度/);
});

test('所有意图函数支持冻结输入且返回独立副本', () => {
  const input = freeze(state()), actual = freeze(structuredClone(result)), knowledge = freeze(structuredClone(catalog));
  const before = JSON.stringify({input, actual, knowledge});
  const outputs = [selectStageIntent(input, actual, 1, 'b', ['walk'], knowledge), selectMealIntent(input, actual, 'lunch', {sceneId: 'food', activityIds: ['meal']}, 1, knowledge), exploreIntent(input, 97, 9)];
  for (const output of outputs) {
    output.context.requiredSceneIds.push('new');
    output.context.periodIds.push('evening');
  }
  assert.equal(JSON.stringify({input, actual, knowledge}), before);
});

test('无效阶段、活动和餐次在意图边界给出明确错误', () => {
  for (const index of [-1, 0.5, result.stages.length]) assert.throws(() => selectStageIntent(state(), result, index, 'a', [], catalog), RangeError);
  assert.throws(() => selectStageIntent(state(), result, 0, 'missing', [], catalog), /未知场景/);
  assert.throws(() => selectStageIntent(state(), result, 0, 'a', ['missing'], catalog), /不支持活动/);
  assert.throws(() => selectMealIntent(state(), result, 'dinner', {mode: 'skip'}, 1, catalog), /不支持/);
  assert.throws(() => selectMealIntent(state(), result, 'breakfast', {mode: 'before_meeting', sceneId: 'food'}, 0, catalog), /不能同时/);
  assert.throws(() => projectStageChoice({sceneId: 'a', activityIds: 'bad'}), TypeError);
  assert.throws(() => projectStageChoice(stage('food', {virtualMeal: true})), /真实阶段/);
});

test('通过真实求解器验证阶段前缀、明确同意及餐馆替换不重复餐次', async () => {
  const {planDate} = await import('../engine.mjs');
  const data = {version: 'intent-integration', scenes: [
    {id: 'walk', minutes: 30, cost: [0, 0], load: 0, kind: 'walk', area: 'campus', indoor: true, quiet: true, fit: 70,
      activities: [{id: 'consent', cost: [0, 0], load: 0, requiresExplicitConsent: true}]},
    ...['food', 'other-food'].map(id => ({id, minutes: 30, cost: [0, 0], load: 0, kind: 'meal', area: 'campus', indoor: true, quiet: true, fit: 70,
      mealRoles: ['lunch'], activities: [{id: 'eat', cost: [0, 0], load: 0, provides: ['meal_completed'], mealRoles: ['lunch']}]})),
  ], transfers: {campus: {campus: 0}}, departures: [{id: 'separate', minutes: 15, cost: [0, 0]}]};
  const initialState = {exploration: 0, prefix: [], context: {duration: 120, reserve: 0, robust: false, fatigueA: 0, fatigueB: 0}};
  const initial = planDate(initialState.context, data, {maxStages: 3});
  assert.equal(initial.ok, true);
  const selected = selectStageIntent(initialState, initial, 0, 'walk', ['consent'], data);
  const fixed = planDate(selected.context, data, {fixedPrefix: selected.prefix, exploration: selected.exploration, maxStages: 3});
  assert.equal(fixed.ok, true, fixed.errors?.join(';'));
  assert.equal(fixed.stages[0].sceneId, 'walk');
  assert.deepEqual(fixed.stages[0].activityIds, ['consent']);
  const mealState = {exploration: 0, prefix: [], context: {periodIds: ['afternoon'], reserve: 0, robust: false, fatigueA: 0, fatigueB: 0,
    mealChoices: {lunch: {sceneId: 'food', activityIds: ['eat']}}}};
  // 下午没有午餐目标；用上午到下午的连续时段覆盖午餐，并跳过会面前早餐。
  mealState.context.periodIds = ['morning', 'afternoon'];
  mealState.context.mealChoices.breakfast = {mode: 'before_meeting'};
  const originalMeal = planDate(mealState.context, data);
  assert.equal(originalMeal.ok, true, originalMeal.errors?.join(';'));
  const mealIndex = originalMeal.stages.findIndex(s => s.mealRole === 'lunch');
  assert.ok(mealIndex >= 0);
  const changed = selectMealIntent(mealState, originalMeal, 'lunch', {sceneId: 'other-food', activityIds: ['eat']}, mealIndex, data);
  const replaced = planDate(changed.context, data, {fixedPrefix: changed.prefix});
  assert.equal(replaced.ok, true, replaced.errors?.join(';'));
  assert.equal(replaced.stages.filter(s => s.mealRole === 'lunch').length, 1);
  assert.equal(replaced.stages.find(s => s.mealRole === 'lunch').sceneId, 'other-food');
  assert.deepEqual(replaced.stages.slice(0, mealIndex).map(projectStageChoice), changed.prefix);
});
