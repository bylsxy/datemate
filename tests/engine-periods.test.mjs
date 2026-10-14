import test from 'node:test';
import assert from 'node:assert/strict';
import { planDate, normalize, canonical } from '../engine.mjs';
import { TIME_PERIODS, normalizePeriods, normalizePeriodIds, getMealRequirements } from '../time-periods.mjs';
import { catalog } from '../data/catalog.mjs';
import { selectMealIntent } from '../planning-intent.mjs';
import { buildCandidateJobs } from '../candidate-validation.mjs';

const scene = (id, extra = {}) => ({ id, minutes: 30, cost: [0, 0], load: 0, kind: 'ordinary', area: 'campus', indoor: true, quiet: true, fit: 70, activities: [], ...extra });
const eating = (role, extra = {}) => ({ id: `eat-${role}`, minutes: 999, cost: [0, 0], load: 0, group: 'meal', mode: 'single', exclusiveKey: 'main_meal', provides: ['meal_completed'], mealRoles: [role], ...extra });
const mealScene = (id, roles, extra = {}) => scene(id, { kind: 'meal', mealRoles: roles, activities: roles.map(role => eating(role)), ...extra });
const fixture = (scenes = [mealScene('food', ['breakfast', 'lunch', 'dinner', 'supper']), scene('walk')]) => ({ version: 'period-test', scenes, departures: [{ id: 'separate', title: '各自回去', minutes: 15, cost: [0, 0] }], transfers: { campus: { campus: 0 } } });
const input = { reserve: 0, robust: false, fatigueA: 0, fatigueB: 0 };
const allPeriods = TIME_PERIODS.map(p => p.id);

function assertMealIntegrity(result, source) {
  assert.equal(result.ok, true, result.errors?.join(';'));
  for (const meal of result.mealRequirements) {
    assert.equal(meal.satisfied, true);
    if (meal.choiceMode !== 'together') {
      assert.equal(meal.stageIndex, null);
      assert.deepEqual(meal.activityIds, []);
      assert.equal(meal.sceneId, null);
    } else {
      const stage = result.stages[meal.stageIndex];
      assert.equal(stage.mealRole, meal.mealRole);
      assert.equal(stage.sceneId, meal.sceneId);
      assert.deepEqual(stage.activityIds, meal.activityIds);
      assert.ok(stage.start >= meal.startMinute && stage.end <= meal.endMinute);
    }
    assert.ok(meal.insertIndex >= 0 && meal.insertIndex <= result.stages.length);
    for (const candidate of meal.candidates) {
      const s = source.scenes.find(s => s.id === candidate.sceneId);
      assert.ok(s.mealRoles.includes(meal.mealRole));
      const acts = candidate.activityIds.map(id => s.activities.find(a => a.id === id));
      assert.ok(acts.some(a => a.provides?.includes('meal_completed') && a.mealRoles.includes(meal.mealRole)));
      assert.ok(acts.filter(a => a.provides?.includes('meal_completed')).every(a => a.mealRoles.includes(meal.mealRole)));
      assert.equal(candidate.end - candidate.start, s.minutes);
    }
  }
  for (const id of result.context.periodIds) {
    const p = TIME_PERIODS.find(p => p.id === id);
    assert.ok(result.stages.some(s => s.start < p.endMinute && s.end > p.startMinute), `${id}缺少实际阶段`);
  }
  assert.equal(result.metrics.mealSatisfied, true);
  assert.equal(result.metrics.periodCoverageSatisfied, true);
  assert.equal(result.metrics.endingCoverageSatisfied, true);
  assert.ok((result.departure?.endMinute ?? result.stages.at(-1).end) >= result.context.windows.at(-1).endMinute - 60);
  assert.equal(result.metrics.activeMinutes, result.stages.reduce((sum, s) => sum + s.minutes, 0));
  assert.equal(result.metrics.waitingMinutes, result.stages.reduce((sum, s) => sum + s.wait, 0));
}

test('共享时段解析合并间隔、排序去重，夜晚保留次日绝对分钟', () => {
  assert.deepEqual(normalizePeriodIds(['afternoon', 'morning', 'morning']), ['morning', 'afternoon']);
  const span = normalizePeriods(['morning', 'afternoon']);
  assert.deepEqual(span.windows, [{ id: 'period-span', startMinute: 450, endMinute: 1080 }]);
  assert.equal(span.duration, 630);
  assert.equal(normalizePeriods(allPeriods).duration, 1110);
  assert.equal(normalizePeriods(['night']).endMinute, 1560);
  for (const ids of [[], ['morning', 'evening'], ['afternoon', 'night'], ['unknown']]) assert.throws(() => normalizePeriods(ids), /H_PERIOD/);
  assert.equal(planDate({ periodIds: ['morning', 'night'] }, fixture()).status, 'invalid_input');
});

test('时段输入删除时长限制，覆盖旧duration/windows，通用windows仍保持分窗语义', () => {
  const normalized = normalize({ periodIds: ['morning', 'afternoon'], duration: 1, windows: [{ start: 0, end: 1 }] });
  assert.equal(normalized.duration, 630);
  assert.equal(normalized.windows[0].startMinute, 450);
  assert.equal(normalize({ duration: 90, windows: [{ start: 10, end: 100 }] }).duration, 90);
});

test('饭点来自跨度，只有早餐能提前吃、只有宵夜能跳过', () => {
  assert.deepEqual(getMealRequirements(allPeriods).map(m => m.mealRole), ['breakfast', 'lunch', 'dinner', 'supper']);
  assert.deepEqual(getMealRequirements(['afternoon']).map(m => m.mealRole), []);
  assert.deepEqual(getMealRequirements(['night']).map(m => m.mealRole), []);
  for (const mealChoices of [{ lunch: { mode: 'skip' } }, { dinner: { mode: 'before_meeting' } }, { breakfast: { mode: 'skip' } }, { supper: { mode: 'before_meeting' } }, { breakfast: { mode: 'before_meeting', sceneId: 'food' } }, { dinner: { activityIds: 'bad' } }, { unknown: {} }]) assert.throws(() => getMealRequirements(allPeriods, mealChoices), /H_MEAL_CHOICE/);
});

test('所有10种连续选择使用真实目录满足全部饭点和每个时段', () => {
  for (let first = 0; first < TIME_PERIODS.length; first++) for (let last = first; last < TIME_PERIODS.length; last++) {
    const ids = allPeriods.slice(first, last + 1);
    const result = planDate({ ...input, periodIds: ids, area: 'near' }, catalog);
    assertMealIntegrity(result, catalog);
    assert.ok(result.search.expandedNodes <= result.search.maxExpandedNodes);
    assert.ok(result.stages.every(s => s.start >= result.context.windows[0].startMinute && s.end <= result.context.windows[0].endMinute));
  }
});

test('早餐和宵夜特殊选择无耗时、无费用阶段，菜单仍能切回实际吃饭', () => {
  const result = planDate({ ...input, periodIds: allPeriods, mealChoices: { breakfast: { mode: 'before_meeting' }, supper: { mode: 'skip' } }, area: 'near' }, catalog);
  assertMealIntegrity(result, catalog);
  for (const role of ['breakfast', 'supper']) {
    const slot = result.mealRequirements.find(m => m.mealRole === role);
    assert.ok(slot.candidates.length > 0);
    assert.ok(slot.candidates.every(c => c.fitScore === null && c.scoreStatus === 'pending'));
    assert.ok(!result.stages.some(s => s.mealRole === role));
  }
  assert.deepEqual(result.totalCostCents, [0, 1].map(i => result.stages.reduce((sum, s) => sum + s.costCents[i], 0) + result.departure.costCents[i]));
  assert.equal(result.metrics.totalMinutes, result.stages.reduce((sum, s) => sum + s.minutes + s.transfer + s.wait, 0) + result.departure.minutes);
});

test('同一餐馆同一合并窗口可吃不同餐次，main_meal不成为全局互斥', () => {
  const choices = Object.fromEntries(['breakfast', 'lunch', 'dinner', 'supper'].map(role => [role, { sceneId: 'food', activityIds: [`eat-${role}`] }]));
  const result = planDate({ ...input, periodIds: allPeriods, mealChoices: choices }, fixture());
  assertMealIntegrity(result, fixture());
  assert.equal(result.stages.filter(s => s.mealRole).length, 4);
  assert.equal(new Set(result.stages.filter(s => s.mealRole).map(s => s.windowId)).size, 1);
  assert.ok(result.stages.filter(s => !s.mealRole).every(s => s.sceneId !== 'food'));
});

test('跳过宵夜可释放跨饭点自动尾段，菜单切换和候选续算均产生合法真实用餐', () => {
  const context = { ...input, periodIds: allPeriods, area: 'near', mealChoices: { breakfast: { mode: 'before_meeting' }, supper: { mode: 'skip' } } };
  const skipped = planDate(context, catalog);
  assertMealIntegrity(skipped, catalog);
  const supper = skipped.mealRequirements.find(m => m.mealRole === 'supper');
  const boundary = skipped.stages.findIndex(s => s.end > supper.targetMinute);
  assert.equal(supper.insertIndex, boundary);
  assert.ok(supper.insertIndex < skipped.stages.length);
  assert.ok(skipped.stages[supper.insertIndex].start < supper.targetMinute, '原自动阶段确实跨越宵夜目标时间');
  assert.ok(supper.candidates.length > 0);
  assert.equal(skipped.context.school, '');
  assert.equal(skipped.context.campusArea, '');
  const state = { context, prefix: [], exploration: 0 };
  const jobs = buildCandidateJobs(skipped, state).filter(job => job.mealRole === 'supper');
  assert.equal(jobs.length, supper.candidates.length);
  for (const candidate of supper.candidates) {
    assert.ok(candidate.start >= supper.startMinute && candidate.end <= supper.endMinute);
    assert.equal(candidate.fitScore, null);
    assert.equal(candidate.continuationFound, false);
    const choice = { sceneId: candidate.sceneId, activityIds: candidate.activityIds };
    const intent = selectMealIntent(state, skipped, 'supper', choice, supper.insertIndex, catalog);
    const switched = planDate({ ...intent.context, fixedPrefix: intent.prefix }, catalog);
    assertMealIntegrity(switched, catalog);
    assert.equal(switched.mealRequirements.find(m => m.mealRole === 'supper').sceneId, candidate.sceneId);
    const job = jobs.find(j => j.sceneId === candidate.sceneId);
    const continuation = planDate(job.context, catalog, { ...job.search, exploration: job.exploration, fixedPrefix: job.prefix, continuationOnly: true });
    assert.equal(continuation.ok, true, continuation.errors?.join(';'));
    assert.ok(continuation.stages.some(s => s.mealRole === 'supper' && s.sceneId === candidate.sceneId && s.start >= supper.startMinute && s.end <= supper.endMinute));
  }
  const locked = skipped.stages.map(s => ({ sceneId: s.sceneId, activityIds: s.activityIds, ...(s.mealRole ? { mealRole: s.mealRole } : {}) }));
  const fixed = planDate({ ...context, fixedPrefix: locked }, catalog);
  assertMealIntegrity(fixed, catalog);
  const fixedSupper = fixed.mealRequirements.find(m => m.mealRole === 'supper');
  assert.equal(fixedSupper.insertIndex, locked.length);
  assert.deepEqual(fixedSupper.candidates, [], '完整固定前缀不能被菜单回退或伪造可行候选');
});

test('没有实际吃饭活动、错误餐次及仅提供场景资源均不能伪装完成饭点', () => {
  const c = fixture([mealScene('food', ['breakfast'], { provides: ['meal_completed'] }), scene('walk')]);
  for (const fixedPrefix of [[{ sceneId: 'food', activityIds: [], mealRole: 'breakfast' }], [{ sceneId: 'food', activityIds: ['eat-breakfast'], mealRole: 'lunch' }]]) {
    const result = planDate({ ...input, periodIds: ['morning'], fixedPrefix }, c);
    assert.equal(result.status, 'invalid_input');
    assert.match(result.errors.join(), /H_MEAL/);
  }
  const wrong = planDate({ ...input, periodIds: ['morning'], mealChoices: { breakfast: { sceneId: 'walk' } } }, c);
  assert.equal(wrong.status, 'invalid_input');
  assert.match(wrong.errors.join(), /H_MEAL_ROLE/);
  const none = planDate({ ...input, periodIds: ['morning'] }, fixture([scene('walk', { provides: ['meal_completed'] })]));
  assert.equal(none.status, 'no_plan_found');
});

test('人工固定餐卡超出子集仍精确有效，活动时长不能改变场景时长', () => {
  const c = fixture([mealScene('food', ['breakfast', 'lunch']), scene('walk')]);
  const result = planDate({ ...input, periodIds: ['morning', 'afternoon'], mealChoices: { breakfast: { sceneId: 'food', activityIds: ['eat-breakfast'] }, lunch: { sceneId: 'food', activityIds: ['eat-lunch'] } } }, c, { activitySubsetLimit: 1 });
  assertMealIntegrity(result, c);
  assert.ok(result.stages.every(s => s.minutes === 30 && s.end - s.start === 30));
  assert.ok(result.stages.filter(s => s.mealRole).every(s => s.schedule.every(a => a.endOffset === 30)));
});

test('菜单位于当前前序状态：预算、忌口、地点、准备和开放时段全部生效', () => {
  const c = fixture([
    mealScene('good', ['breakfast'], { cost: [5, 5] }),
    mealScene('expensive', ['breakfast'], { cost: [11, 11] }),
    mealScene('allergen', ['breakfast'], { activities: [eating('breakfast', { dietaryTags: ['gluten'] })] }),
    mealScene('offsite', ['breakfast'], { area: 'off' }),
    mealScene('unprepared', ['breakfast'], { requires: ['kit'] }),
    mealScene('closed', ['breakfast'], { openWindows: [{ startMinute: 700, endMinute: 720 }] }),
    scene('walk'),
  ]);
  const result = planDate({ ...input, periodIds: ['morning'], area: 'campus', budget: 10, dietaryRestrictions: ['gluten'], mealChoices: { breakfast: { mode: 'before_meeting' } } }, c);
  assert.equal(result.ok, true);
  assert.deepEqual(result.mealRequirements[0].candidates.map(c => c.sceneId), ['good']);
  const selected = planDate({ ...input, periodIds: ['morning'], budget: 4, mealChoices: { breakfast: { sceneId: 'good', activityIds: ['eat-breakfast'] } } }, c);
  assert.equal(selected.status, 'no_plan_found');
  assert.ok(selected.search.constraintRejections.H_BUDGET > 0);
});

test('自动用餐被枚举截断时仍保留最小真实吃饭组合，且餐候选不混入普通场景', () => {
  const result = planDate({ ...input, periodIds: allPeriods }, fixture(), { activitySubsetLimit: 1 });
  assertMealIntegrity(result, fixture());
  for (const stage of result.stages) assert.ok(stage.candidates.every(c => (c.mealRole ?? null) === (stage.mealRole ?? null)));
});

test('人工前缀不能越过未吃饭点，预约不能跨过未覆盖时段', () => {
  const c = fixture();
  const beforeBreakfast = planDate({ ...input, periodIds: ['morning'], fixedPrefix: [{ sceneId: 'walk', activityIds: [] }] }, c);
  assert.equal(beforeBreakfast.status, 'invalid_input');
  const skippingAfternoon = planDate({ ...input, periodIds: allPeriods, fixedPrefix: [{ sceneId: 'food', activityIds: ['eat-breakfast'], mealRole: 'breakfast' }, { sceneId: 'food', activityIds: ['eat-lunch'], mealRole: 'lunch' }, { sceneId: 'food', activityIds: ['eat-dinner'], mealRole: 'dinner' }] }, c);
  assert.equal(skippingAfternoon.status, 'invalid_input');
  assert.match(skippingAfternoon.errors.join(), /H_PERIOD_COVERAGE/);
});

test('明确夜晚预约可执行到次日02:00，结束缓冲仍按绝对分钟校验', () => {
  const c = fixture([scene('late')]);
  const exact = { ...input, periodIds: ['night'], anchors: [{ choice: { sceneId: 'late', activityIds: [] }, startMinute: 1515, index: 0 }] };
  const result = planDate(exact, c, { maxStages: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.stages[0].end, 1545);
  assert.equal(result.departure.endMinute, 1560);
  assert.equal(planDate({ ...exact, reserve: 1 }, c, { maxStages: 1 }).status, 'no_plan_found');
});

test('长期限节点预算、候选预算、depth限制可控；未完成饭点不能作为完整terminal', () => {
  const limited = planDate({ ...input, periodIds: allPeriods }, fixture(), { maxExpandedNodes: 1 });
  assert.equal(limited.status, 'no_plan_found');
  assert.equal(limited.search.expandedNodes, 1);
  assert.equal(limited.search.nodeBudgetReached, true);
  const shallow = planDate({ ...input, periodIds: allPeriods }, fixture(), { maxStages: 1 });
  assert.equal(shallow.status, 'no_plan_found');
  assert.equal(shallow.search.terminalPlans, 0);
  assert.equal(shallow.search.provedOptimal, false);
});

test('长跨度0→90→0重规划保持确定性、输入不变、饭点和末段覆盖不可被探索分数抵消', () => {
  const request = { ...input, periodIds: allPeriods, mealChoices: { supper: { mode: 'skip' } }, area: 'near' };
  const saved = canonical(request);
  const original = planDate(request, catalog);
  const explored = planDate({ ...request, exploration: 90 }, catalog);
  const restored = planDate(request, catalog);
  for (const result of [original, explored, restored]) assertMealIntegrity(result, catalog);
  assert.equal(original.outputFingerprint, restored.outputFingerprint);
  assert.equal(canonical(original), canonical(restored));
  assert.equal(canonical(request), saved);
});

test('上午下午真实覆盖优于提前结束和长等待，午间间隔允许真实活动', () => {
  const result = planDate({ periodIds: ['morning', 'afternoon'], area: 'near' }, catalog);
  assertMealIntegrity(result, catalog);
  assert.ok(result.metrics.activeMinutes >= result.context.duration * 0.65);
  assert.ok(result.metrics.waitingMinutes <= 60);
  assert.ok(result.stages.some(s => !s.mealRole && s.start < 840 && s.end > 720), '12:00..14:00间隔没有安排真实活动');
  assert.ok(result.stages.at(-1).end >= 1020);
  assert.ok(result.stages.every(s => s.end - s.start === catalog.scenes.find(c => c.id === s.sceneId).minutes));
});

test('纯餐饮和多用途地点分开：玻璃房桌游仍可作为普通阶段，不偷吃一顿饭', () => {
  const result = planDate({ ...input, periodIds: ['afternoon'], area: 'near', school: 'scau', campusArea: 'taishan', preparedIds: ['boardgame_kit', 'venue_checked'], fixedPrefix: [{ sceneId: 'taishan_glass', activityIds: ['boardgame_coop'] }] }, catalog);
  assertMealIntegrity(result, catalog);
  assert.equal(result.stages[0].sceneId, 'taishan_glass');
  assert.equal(result.stages[0].mealRole, undefined);
  assert.deepEqual(result.stages[0].activityIds, ['boardgame_coop']);
  assert.equal(result.mealRequirements.length, 0);
  assert.ok(result.stages.filter(s => !s.mealRole).every(s => s.activityIds.every(id => !catalog.scenes.find(c => c.id === s.sceneId).activities.find(a => a.id === id).provides?.includes('meal_completed'))));
});

test('零预算首次早餐失败仍返回可恢复的餐槽，改会面前吃后零费用可行', () => {
  const request = { periodIds: ['morning'], budget: 0 };
  const failed = planDate(request, catalog);
  assert.equal(failed.status, 'no_plan_found');
  assert.equal(failed.mealRequirements[0].mealRole, 'breakfast');
  assert.equal(failed.mealRequirements[0].targetMinute, 450);
  assert.equal(failed.mealRequirements[0].stageIndex, null);
  assert.equal(failed.mealRequirements[0].satisfied, false);
  const recovered = planDate({ ...request, mealChoices: { breakfast: { mode: 'before_meeting' } } }, catalog);
  assertMealIntegrity(recovered, catalog);
  assert.deepEqual(recovered.totalCostCents, [0, 0]);
  assert.ok(recovered.stages.every(s => !s.mealRole));
  assert.equal(recovered.mealRequirements[0].choiceMode, 'before_meeting');
});
