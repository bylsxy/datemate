import test from 'node:test';
import assert from 'node:assert/strict';
import {projectStageChoice, selectStageIntent, selectMealIntent, selectDepartureIntent, exploreIntent, restartIntent, updateContextIntent} from '../planning-intent.mjs';

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

test('真实餐馆切换固定到当前餐，并释放后续餐馆锁', () => {
  const meals = {ok: true, stages: [stage('a', {fixedStartMinute: 40}), stage('food', {mealRole: 'lunch', activityIds: ['meal']}), stage('c')],
    mealRequirements: [{mealRole: 'lunch', stageIndex: 1}, {mealRole: 'dinner', stageIndex: null, insertIndex: 3}]};
  const input = state();
  input.context.mealChoices = {lunch: {sceneId: 'food', activityIds: ['meal']}, dinner: {sceneId: 'food', activityIds: ['meal']}};
  const next = selectMealIntent(input, meals, 'lunch', {sceneId: 'other-food', activityIds: ['meal', 'touch']}, 1, catalog);
  assert.deepEqual(next.prefix, [{sceneId: 'a', activityIds: ['walk'], startMinute: 40}, {sceneId: 'other-food', activityIds: ['meal', 'touch'], mealRole: 'lunch'}]);
  assert.deepEqual(next.context.mealChoices.lunch, {sceneId: 'other-food', activityIds: ['meal', 'touch']});
  assert.equal(Object.hasOwn(next.context.mealChoices, 'dinner'), false);
  assert.deepEqual(next.context.explicitConsentIds, ['touch']);
});

test('虚拟餐卡同index不吞入普通阶段，首端和末端插入均支持', () => {
  const breakfast = selectMealIntent(state(), result, 'breakfast', {mode: 'before_meeting'}, 0, catalog);
  assert.deepEqual(breakfast.prefix, []);
  assert.deepEqual(breakfast.context.mealChoices.breakfast, {mode: 'before_meeting'});
  const inserted = selectMealIntent(breakfast, result, 'breakfast', {sceneId: 'food', activityIds: ['meal']}, 0, catalog);
  assert.deepEqual(inserted.prefix, [{sceneId: 'food', activityIds: ['meal'], mealRole: 'breakfast'}]);
  const supper = selectMealIntent(state(), result, 'supper', {mode: 'skip'}, result.stages.length, catalog);
  assert.equal(supper.prefix.length, result.stages.length);
  assert.equal(supper.prefix.some(choice => choice.mealRole === 'supper'), false);
});

test('餐次点击也保留前序未完成选择并重算同意，不重复固定已经经过的同餐次', () => {
  const input = state({prefix: [{sceneId: 'b', activityIds: ['touch'], startMinute: 60}]});
  const next = selectMealIntent(input, result, 'lunch', {sceneId: 'food', activityIds: ['meal']}, 1, catalog);
  assert.deepEqual(next.prefix, [{sceneId: 'b', activityIds: ['touch'], startMinute: 60}, {sceneId: 'food', activityIds: ['meal'], mealRole: 'lunch'}]);
  assert.deepEqual(next.context.explicitConsentIds, ['touch']);
  const misplaced = {ok: true, stages: [stage('food', {mealRole: 'lunch', activityIds: ['meal']}), stage('b')]};
  assert.throws(() => selectMealIntent(state(), misplaced, 'lunch', {sceneId: 'food', activityIds: ['meal']}, 1, catalog), /边界/);
});

test('探索保留已确认选择及相关同意，只释放后续未确认餐馆', () => {
  const input = state({prefix: [{sceneId: 'a', activityIds: ['touch'], startMinute: 40}]});
  input.context.explicitConsentIds=['touch','stale'];
  input.context.mealChoices = {breakfast: {mode: 'before_meeting'}, lunch: {sceneId: 'food', activityIds: ['meal']}, dinner: {sceneId: 'other-food', activityIds: ['meal']}, supper: {mode: 'skip'}};
  input.context.anchors = [{index: 2, startMinute: 200, choice: {sceneId: 'c', activityIds: ['walk']}}];
  input.context.dietaryRestrictions = ['gluten'];
  input.context.weather = 'rain';
  const next = exploreIntent(input, 97, 0xffffffff);
  assert.equal(next.exploration, 97);
  assert.deepEqual(next.prefix, input.prefix);
  assert.deepEqual(next.context.mealChoices, {breakfast: {mode: 'before_meeting'}, supper: {mode: 'skip'}});
  assert.deepEqual(next.context.explicitConsentIds, ['touch']);
  assert.equal(next.context.explorationSeed, 0xffffffff);
  const expected = structuredClone(input.context);
  expected.mealChoices = next.context.mealChoices;
  expected.explicitConsentIds = ['touch'];
  expected.explorationSeed = 0xffffffff;
  assert.deepEqual(next.context, expected);
});

test('只有全部重新推荐才清空已选；改变软偏好保留选择，改变硬条件再重排',()=>{
  const input=state({prefix:[{sceneId:'a',activityIds:['touch'],durationMinutes:60}]});
  input.context.explicitConsentIds=['touch'];input.context.minimumStageCount=2;
  const restarted=restartIntent(input,123);
  assert.deepEqual(restarted.prefix,[]);assert.deepEqual(restarted.context.explicitConsentIds,[]);
  assert.equal(restarted.context.endAfterStage,undefined);assert.equal(restarted.context.minimumStageCount,undefined);
  const soft=updateContextIntent(input,{...input.context,preferencesA:['nature']});
  assert.equal(soft.hardChanged,false);assert.deepEqual(soft.next.prefix,input.prefix);
  const hard=updateContextIntent(input,{...input.context,weather:'rain'});
  assert.equal(hard.hardChanged,true);assert.deepEqual(hard.next.prefix,[]);
});

test('探索接受零seed，拒绝非uint32和非整数探索度', () => {
  assert.equal(exploreIntent(state(), 0, 0).context.explorationSeed, 0);
  for (const seed of [-1, 2 ** 32, 1.5, '7', NaN, undefined]) assert.throws(() => exploreIntent(state(), 97, seed), /uint32/);
  for (const exploration of [-1, 101, 1.5, '97']) assert.throws(() => exploreIntent(state(), exploration, 0), /探索度/);
});

test('失败餐菜单空stages可恢复，旧失败prefix不带入且保留时间硬上限', () => {
  const input = freeze(state({prefix: [{sceneId: 'a', activityIds: ['touch']}]}));
  const failed = freeze({ok: false, stages: []});
  const before = JSON.stringify(input);
  for (const [role, choice] of [['breakfast', {mode: 'before_meeting'}], ['lunch', {sceneId: 'food', activityIds: ['meal']}], ['supper', {mode: 'skip'}]]) {
    const next = selectMealIntent(input, failed, role, choice, 0, catalog);
    assert.deepEqual(next.prefix, choice.sceneId ? [{...choice, mealRole: role}] : []);
    assert.deepEqual(next.context.mealChoices[role], choice);
    assert.deepEqual(next.context.explicitConsentIds, []);
    assert.equal(next.context.endAfterStage, 2);
  }
  assert.equal(JSON.stringify(input), before);
  assert.throws(() => selectStageIntent(input, failed, 0, 'a', [], catalog), RangeError);
});

test('未完成餐菜单仅投影已有真实前序，餐卡索引仍严格检查结构与范围', () => {
  const input = state({prefix: [{sceneId: 'b', activityIds: ['touch'], startMinute: 90}]});
  const partial = {ok: false, stages: [stage('a', {fixedStartMinute: 40})]};
  const next = selectMealIntent(input, partial, 'lunch', {sceneId: 'food', activityIds: ['meal']}, 1, catalog);
  assert.deepEqual(next.prefix, [{sceneId: 'a', activityIds: ['walk'], startMinute: 40}, {sceneId: 'food', activityIds: ['meal'], mealRole: 'lunch'}]);
  assert.deepEqual(next.context.explicitConsentIds, []);
  assert.equal(next.context.endAfterStage, 2);
  assert.throws(() => selectStageIntent(input, partial, 0, 'a', [], catalog), RangeError);
  for (const index of [-1, 0.5, 2, NaN]) assert.throws(() => selectMealIntent(input, partial, 'lunch', {sceneId: 'food', activityIds: ['meal']}, index, catalog), RangeError);
  for (const invalid of [null, {}, {ok: false}, {ok: false, stages: {}}]) assert.throws(() => selectMealIntent(input, invalid, 'lunch', {sceneId: 'food', activityIds: ['meal']}, 0, catalog), RangeError);
});

test('探索保留旧字符串特殊模式和对象模式，释放餐馆并保留结束硬上限', () => {
  for (const breakfast of ['before_meeting', {mode: 'before_meeting'}]) {
    for (const supper of ['skip', {mode: 'skip'}]) {
      const input = state();
      input.context.mealChoices = {breakfast, supper, lunch: {sceneId: 'food', activityIds: ['meal']}, dinner: {sceneId: 'other-food', activityIds: ['touch']}};
      freeze(input);
      const next = exploreIntent(input, 97, 0);
      assert.deepEqual(next.context.mealChoices, {breakfast, supper});
      assert.deepEqual(next.context.explicitConsentIds, []);
      assert.equal(next.context.endAfterStage, 2);
    }
  }
});

test('所有意图函数支持冻结输入且返回独立副本', () => {
  const input = freeze(state()), actual = freeze(structuredClone(result)), knowledge = freeze(structuredClone(catalog));
  const before = JSON.stringify({input, actual, knowledge});
  const outputs = [selectStageIntent(input, actual, 1, 'b', ['walk'], knowledge), selectMealIntent(input, actual, 'lunch', {sceneId: 'food', activityIds: ['meal']}, 1, knowledge), selectDepartureIntent(input, actual, 'hotel', knowledge), exploreIntent(input, 97, 9)];
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
  assert.deepEqual(replaced.stages.slice(0, mealIndex + 1).map(projectStageChoice), changed.prefix);
  assert.equal(replaced.stages[mealIndex].mealRole, 'lunch', '当前餐之前不能插入新的普通场景');
  const brokenState = structuredClone(mealState);
  brokenState.context.mealChoices.lunch = {sceneId: 'walk', activityIds: []};
  brokenState.context.endAfterStage = 18;
  const failedMeal = planDate(brokenState.context, data);
  assert.equal(failedMeal.ok, false);
  const recoveredIntent = selectMealIntent(brokenState, failedMeal, 'lunch', {sceneId: 'food', activityIds: ['eat']}, 0, data);
  assert.equal(recoveredIntent.context.endAfterStage, 18);
  const emptyAttempt = planDate(recoveredIntent.context, data, {fixedPrefix: recoveredIntent.prefix});
  assert.equal(emptyAttempt.ok, false, '空前序午餐固定在第0段仍需满足上午实际覆盖');
  assert.ok(emptyAttempt.errors.some(error => error.includes('H_PERIOD_COVERAGE')));
  const partialFailure = {...failedMeal, stages: originalMeal.stages.slice(0, mealIndex)};
  const withPredecessors = selectMealIntent(brokenState, partialFailure, 'lunch', {sceneId: 'food', activityIds: ['eat']}, mealIndex, data);
  assert.equal(withPredecessors.context.endAfterStage, 18);
  const recovered = planDate(withPredecessors.context, data, {fixedPrefix: withPredecessors.prefix});
  assert.equal(recovered.ok, true, recovered.errors?.join(';'));
  assert.equal(recovered.stages.filter(s => s.mealRole === 'lunch').length, 1);
});

test('阶段动作保留之前餐馆和特殊模式，释放之后的场馆与活动并保留其它硬条件', () => {
  const meals = freeze({ok: true, stages: [stage('food', {mealRole: 'breakfast', activityIds: ['meal']}), stage('a'), stage('food', {mealRole: 'lunch', activityIds: ['meal']}), stage('other-food', {mealRole: 'dinner', activityIds: ['meal']})],
    mealRequirements: [{mealRole: 'breakfast', stageIndex: 0}, {mealRole: 'lunch', stageIndex: 2}, {mealRole: 'dinner', stageIndex: 3}, {mealRole: 'supper', stageIndex: null, insertIndex: 4}]});
  const input = state();
  input.context.mealChoices = {breakfast: {sceneId: 'food', activityIds: ['meal']}, lunch: {sceneId: 'food', activityIds: ['meal', 'touch']}, dinner: {activityIds: ['meal']}, supper: 'skip'};
  freeze(input);
  const next = selectStageIntent(input, meals, 1, 'a', ['walk'], catalog);
  assert.deepEqual(next.context.mealChoices, {breakfast: input.context.mealChoices.breakfast, supper: 'skip'});
  const expected = structuredClone(input.context);
  expected.mealChoices = next.context.mealChoices;
  expected.explicitConsentIds = [];
  assert.deepEqual(next.context, expected);
  const onMeal = selectStageIntent(input, meals, 2, 'other-food', ['meal'], catalog);
  assert.deepEqual(onMeal.context.mealChoices, {breakfast: input.context.mealChoices.breakfast, lunch: {sceneId: 'other-food', activityIds: ['meal']}, supper: 'skip'});
  assert.equal(onMeal.prefix[2].mealRole, 'lunch');
});

test('当前餐加入prefix保留显式预约，虚拟餐插入不借用普通阶段预约', () => {
  const input = state();
  input.context.mealChoices = {breakfast: 'before_meeting', lunch: {sceneId: 'food', activityIds: ['meal']}, dinner: {sceneId: 'food', activityIds: ['meal']}, supper: {mode: 'skip'}};
  const meals = {ok: true, stages: [stage('a'), stage('food', {mealRole: 'lunch', activityIds: ['meal'], fixedStartMinute: 120}), stage('other-food', {mealRole: 'dinner', activityIds: ['meal']})],
    mealRequirements: [{mealRole: 'breakfast', stageIndex: null, insertIndex: 0}, {mealRole: 'lunch', stageIndex: 1}, {mealRole: 'dinner', stageIndex: 2}, {mealRole: 'supper', stageIndex: null, insertIndex: 3}]};
  const next = selectMealIntent(input, meals, 'lunch', {sceneId: 'other-food', activityIds: ['meal']}, 1, catalog);
  assert.deepEqual(next.prefix[1], {sceneId: 'other-food', activityIds: ['meal'], mealRole: 'lunch', startMinute: 120});
  assert.deepEqual(next.context.mealChoices, {breakfast: 'before_meeting', lunch: {sceneId: 'other-food', activityIds: ['meal']}, supper: {mode: 'skip'}});
  const virtual = selectMealIntent(input, result, 'breakfast', {sceneId: 'food', activityIds: ['meal']}, 0, catalog);
  assert.equal(Object.hasOwn(virtual.prefix[0], 'startMinute'), false);
});

test('失败菜单同insertIndex仍释放后续餐馆，特殊餐次保持无当前真实阶段', () => {
  const input = state();
  input.context.mealChoices = {breakfast: {mode: 'before_meeting'}, lunch: {sceneId: 'food', activityIds: ['meal']}, dinner: {sceneId: 'other-food', activityIds: ['meal']}, supper: 'skip'};
  const failed = {ok: false, stages: [], mealRequirements: ['breakfast', 'lunch', 'dinner', 'supper'].map(mealRole => ({mealRole, stageIndex: null, insertIndex: 0}))};
  const real = selectMealIntent(input, failed, 'lunch', {sceneId: 'other-food', activityIds: ['meal']}, 0, catalog);
  assert.deepEqual(real.prefix, [{sceneId: 'other-food', activityIds: ['meal'], mealRole: 'lunch'}]);
  assert.deepEqual(real.context.mealChoices, {breakfast: {mode: 'before_meeting'}, lunch: {sceneId: 'other-food', activityIds: ['meal']}, supper: 'skip'});
  const special = selectMealIntent(input, failed, 'breakfast', {mode: 'before_meeting'}, 0, catalog);
  assert.deepEqual(special.prefix, []);
  assert.deepEqual(special.context.mealChoices, {breakfast: {mode: 'before_meeting'}, supper: 'skip'});
  assert.equal(special.context.endAfterStage, 2);
});

test('分别动作固定所有真实阶段及pending前序，重算同意并保留餐次与时间硬条件', () => {
  const input = state({prefix: [{sceneId: 'c', activityIds: ['touch'], startMinute: 60}]});
  input.context.mealChoices = {supper: 'skip'};
  freeze(input);
  const next = selectDepartureIntent(input, freeze(structuredClone(result)), 'hotel', catalog);
  assert.deepEqual(next.prefix, [{sceneId: 'c', activityIds: ['touch'], startMinute: 60}, {sceneId: 'b', activityIds: ['walk']}, {sceneId: 'c', activityIds: ['walk']}]);
  const expected = structuredClone(input.context);
  expected.departureChoice = 'hotel';
  expected.explicitConsentIds = ['touch'];
  assert.deepEqual(next.context, expected);
  assert.throws(() => selectDepartureIntent(input, {ok: false, stages: []}, 'hotel', catalog), RangeError);
  assert.throws(() => selectDepartureIntent(input, result, '', catalog), TypeError);
});

test('酒店费用变化时真实求解保持全部前段，预算不足明确失败而不替换前段', async () => {
  const {planDate} = await import('../engine.mjs');
  const data = {version: 'departure-intent-test', scenes: [
    {id: 'a', minutes: 30, cost: [0, 0], load: 0, kind: 'walk', area: 'campus', indoor: true, quiet: true, fit: 70, activities: []},
    {id: 'b', minutes: 30, cost: [1, 1], load: 0, kind: 'play', area: 'campus', indoor: true, quiet: true, fit: 90, activities: []},
  ], transfers: {campus: {campus: 0}}, departures: [{id: 'separate', minutes: 15, cost: [0, 0]}, {id: 'hotel', minutes: 15, cost: [10, 10]}]};
  const input = {exploration: 0, prefix: [], context: {periodIds: ['evening', 'night'], mealChoices: {supper: 'skip'}, departureChoice: 'separate', cityTier: 'tier1', budget: 100, robust: false, reserve: 0, fatigueA: 0, fatigueB: 0, endAfterStage: 18}};
  const original = planDate(input.context, data);
  assert.equal(original.ok, true, original.errors?.join(';'));
  const next = selectDepartureIntent(input, original, 'hotel', data);
  const changed = planDate(next.context, data, {fixedPrefix: next.prefix});
  assert.equal(changed.ok, true, changed.errors?.join(';'));
  assert.deepEqual(changed.stages.map(projectStageChoice), next.prefix);
  assert.equal(changed.departure.id, 'hotel');
  const tight = structuredClone(next.context);
  tight.budget = 9;
  const rejected = planDate(tight, data, {fixedPrefix: next.prefix});
  assert.equal(rejected.ok, false);
  assert.ok(rejected.errors.some(error => error.includes('H_BUDGET')));
});
