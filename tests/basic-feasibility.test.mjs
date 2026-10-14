import test from 'node:test';
import assert from 'node:assert/strict';
import { planDate } from '../engine.mjs';
import { catalog } from '../data/catalog.mjs';
import { TIME_PERIODS, getMealRequirements } from '../time-periods.mjs';
import { isSceneInSchoolScope } from '../school-scope.mjs';

const periods = TIME_PERIODS.map(p => p.id);
const spans = [];
for (let first = 0; first < periods.length; first++) {
  for (let last = first; last < periods.length; last++) spans.push(periods.slice(first, last + 1));
}
const weather = ['clear', 'rain', 'unknown'];
const areas = ['campus', 'near', 'all'];
const scopes = [{}, { school: 'scau' }, { school: 'scau', campusArea: 'taishan' }];
const light = { beamWidth: 4, maxExpandedNodes: 2000, maxCandidateExpandedNodes: 0, activitySubsetLimit: 4 };
const retry = { maxCandidateExpandedNodes: 0 };
const label = context => JSON.stringify(context);

// 每个连续时段内覆盖天气×范围、天气×学校、范围×学校的全部二元组合。
function representativeMatrix(full = false) {
  return spans.flatMap((periodIds, p) => weather.flatMap((w, wi) => areas.flatMap((area, ai) => {
    const selectedScopes = full ? scopes : [scopes[(p + wi + ai) % scopes.length]];
    return selectedScopes.map(scope => ({ periodIds, weather: w, area, ...scope }));
  })));
}

function solve(context) {
  const input = { fatigueA: 2, fatigueB: 2, robust: true, ...context };
  let result = planDate(input, catalog, light);
  if (!result.ok) result = planDate(input, catalog, retry);
  return { input, result };
}

function assertBasicSolution(context) {
  const { input, result } = solve(context);
  assert.equal(result.ok, true, `${label(context)}: ${result.status}; ${label(result.search)}`);
  assert.equal(result.metrics.mealSatisfied, true);
  assert.equal(result.metrics.periodCoverageSatisfied, true);
  assert.equal(result.metrics.endingCoverageSatisfied, true);
  assert.ok(result.stages.length > 0);
  assert.ok(result.stages.every(stage => isSceneInSchoolScope(catalog.scenes.find(s => s.id === stage.sceneId), result.context)));
  if (context.budget !== undefined) assert.ok(result.totalCostCents[1] <= context.budget * 100);
  const witness = result.continuationWitness;
  assert.ok(witness.every(choice=>Number.isInteger(choice.durationMinutes)),'可变停留的完整见证必须带上实际时长');
  // 成功必须可由真实目录独立重演，不能只相信搜索器的 ok 标记。
  const verified = planDate(input, catalog, { ...retry, knownPlan: witness, verifyKnownPlanOnly: true });
  assert.equal(verified.ok, true, `${label(context)}: witness ${verified.errors?.join(';')}`);
  return result;
}

test('基本可行性矩阵覆盖10个连续时段及所有天气/学校/范围二元组合', () => {
  const matrix = representativeMatrix();
  assert.equal(matrix.length, 90);
  for (const periodIds of spans) {
    const rows = matrix.filter(row => label(row.periodIds) === label(periodIds));
    for (const [left, right] of [['weather', 'area'], ['weather', 'schoolScope'], ['area', 'schoolScope']]) {
      const value = (row, key) => key === 'schoolScope' ? `${row.school || ''}/${row.campusArea || ''}` : row[key];
      assert.equal(new Set(rows.map(row => `${value(row, left)}|${value(row, right)}`)).size, 9);
    }
  }
});

test('真实目录所有90个常见代表组合都具有可重演的完整基本解', () => {
  const failed = [];
  for (const context of representativeMatrix(process.env.DATEMATE_FULL_MATRIX === '1')) {
    try { assertBasicSolution(context); } catch (error) { failed.push(error.message); }
  }
  assert.deepEqual(failed, [], failed.join('\n'));
});

test('无强制饭点的下午及雨夜支持疲劳6/安静/避拥挤/零预算的组合', () => {
  const rows = [
    ...areas.flatMap(area => scopes.map(scope => ({ periodIds: ['night'], weather: 'rain', area, ...scope, fatigueA: 6, fatigueB: 6, quietRequired: true, crowdAvoidance: true, budget: 0 }))),
    ...['afternoon', 'evening', 'night'].flatMap(period => weather.flatMap((w, wi) => scopes.map((scope, si) => ({ periodIds: [period], weather: w, area: areas[(wi + si) % areas.length], ...scope, fatigueA: 6, fatigueB: 6, quietRequired: true, crowdAvoidance: true, budget: 0 })))),
  ];
  const failed = [];
  for (const context of rows) {
    try { assertBasicSolution(context); } catch (error) { failed.push(error.message); }
  }
  assert.deepEqual(failed, [], failed.join('\n'));
});

// 预算是双人费用上界：独立计算餐次最低上界，证明真正的预算矛盾。
function mealCostLowerBound(context) {
  return getMealRequirements(context.periodIds, context.mealChoices).filter(m => m.choiceMode === 'together').reduce((sum, meal) => {
    const prices = catalog.scenes.filter(scene => isSceneInSchoolScope(scene, context)).flatMap(scene => scene.activities.filter(activity => activity.provides?.includes('meal_completed') && activity.mealRoles?.includes(meal.mealRole) && !(activity.requires||[]).length && (!activity.requiresExplicitConsent || context.explicitConsentIds?.includes(activity.id))).map(activity => scene.cost[1] + activity.cost[1]));
    return sum + Math.min(...prices);
  }, 0);
}

test('零预算却要求购买早餐或跨时段正餐不能伪造成功', () => {
  const rows = scopes.flatMap(scope => [
    { periodIds: ['morning'], area: 'campus', ...scope, budget: 0 },
    { periodIds: ['morning', 'afternoon'], area: 'campus', ...scope, budget: 0 },
    { periodIds: ['afternoon', 'evening'], area: 'campus', ...scope, budget: 0 },
  ]);
  for (const context of rows) {
    const minimum = mealCostLowerBound(context);
    assert.ok(Number.isFinite(minimum), `必须存在可购买的对应餐次，不能用供应缺失冒充预算冲突: ${label(context)}`);
    assert.ok(minimum > context.budget, label(context));
    const result = planDate(context, catalog, light);
    assert.equal(result.ok, false, label(context));
    assert.equal(result.status, 'no_plan_found');
    assert.equal(result.searchStatus, 'bounded_no_plan_found_not_proved_infeasible');
  }
});

test('明确选择会面前早餐后，安静/零预算上午可正常规划', () => {
  for (const scope of scopes) assertBasicSolution({ periodIds: ['morning'], area: 'campus', ...scope, quietRequired: true, budget: 0, mealChoices: { breakfast: { mode: 'before_meeting' } } });
});

test('50元支持常见时段；全天选择不吃宵夜后保留可重演基本解', () => {
  const failed = [];
  for (const periodIds of spans) for (const hardConditions of [false, true]) {
    const context = { periodIds, area: 'near', school: 'scau', campusArea: 'taishan', budget: 50, ...(periodIds.length===4?{mealChoices:{supper:{mode:'skip'}}}:{}), ...(hardConditions ? { weather: 'rain', quietRequired: true, crowdAvoidance: true, fatigueA: 6, fatigueB: 6 } : {}) };
    try { assertBasicSolution(context); } catch (error) { failed.push(error.message); }
  }
  assert.deepEqual(failed, [], failed.join('\n'));
});

test('低预算选酒店及必去同时排除不可伪造成功', () => {
  const contexts = [
    { periodIds: ['night'], area: 'near', budget: 0, departureChoice: 'hotel' },
    { periodIds: ['night'], area: 'near', budget: 50, departureChoice: 'hotel' },
    { periodIds: ['afternoon'], area: 'campus', requiredSceneIds: ['reading'], bans: ['reading'] },
  ];
  for (const context of contexts) {
    const { result } = solve(context);
    assert.equal(result.ok, false, label(context));
    assert.ok(['invalid_input', 'no_plan_found'].includes(result.status), `${label(context)}: ${result.status}`);
    if (result.status === 'no_plan_found') assert.equal(result.searchStatus, 'bounded_no_plan_found_not_proved_infeasible');
  }
});
