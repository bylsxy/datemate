// 用户意图与求解结果分离：仅投影显式选择，不把自动排程变成预约。
const clone = value => structuredClone(value);

function validateChoice(choice) {
  if (!choice || typeof choice.sceneId !== 'string' || !choice.sceneId ||
      !Array.isArray(choice.activityIds) || choice.activityIds.some(id => typeof id !== 'string')) {
    throw new TypeError('阶段选择需要真实场景和活动ID数组。');
  }
}

export function projectStageChoice(stage) {
  validateChoice(stage);
  if (stage.virtualMeal || stage.departure) throw new TypeError('虚拟用餐和分别卡不能投影为真实阶段。');
  return {
    sceneId: stage.sceneId,
    activityIds: [...stage.activityIds],
    ...(stage.mealRole ? {mealRole: stage.mealRole} : {}),
    ...(Number.isFinite(stage.fixedStartMinute) ? {startMinute: stage.fixedStartMinute} : {}),
  };
}

function validateIndex(result, index, allowEnd = false) {
  if (!result?.ok || !Array.isArray(result.stages) || !Number.isInteger(index) || index < 0 ||
      index >= result.stages.length + Number(allowEnd)) {
    throw new RangeError('选择位置必须对应当前完整安排的真实阶段或用餐插入位置。');
  }
}

function choiceAt(state, stage, index) {
  const actual = projectStageChoice(stage), pending = state.prefix?.[index];
  // 同一真实槽位的待提交选择可以改变场景；餐次身份必须匹配，避免虚拟餐卡串位。
  if (!pending || (pending.mealRole || null) !== (stage.mealRole || null)) return actual;
  validateChoice(pending);
  const selected = {
    sceneId: pending.sceneId,
    activityIds: [...pending.activityIds],
    ...(stage.mealRole ? {mealRole: stage.mealRole} : {}),
  };
  const explicitStart = Number.isFinite(pending.startMinute) ? pending.startMinute : pending.fixedStartMinute;
  if (Number.isFinite(explicitStart)) selected.startMinute = explicitStart;
  else if (pending.sceneId === stage.sceneId && Number.isFinite(actual.startMinute)) selected.startMinute = actual.startMinute;
  return selected;
}

function precedingChoices(state, result, index) {
  return result.stages.slice(0, index).map((stage, i) => choiceAt(state, stage, i));
}

function consentIds(choices, catalog) {
  if (!Array.isArray(catalog?.scenes)) throw new TypeError('需要场景目录以计算明确同意活动。');
  const scenes = new Map(catalog.scenes.map(scene => [scene.id, scene]));
  const consent = new Set();
  for (const choice of choices) {
    validateChoice(choice);
    const scene = scenes.get(choice.sceneId);
    if (!scene) throw new RangeError(`未知场景：${choice.sceneId}`);
    const activities = new Map((scene.activities || []).map(activity => [activity.id, activity]));
    for (const id of choice.activityIds) {
      const activity = activities.get(id);
      if (!activity) throw new RangeError(`场景 ${choice.sceneId} 不支持活动 ${id}`);
      if (activity.requiresExplicitConsent) consent.add(id);
    }
  }
  return [...consent];
}

export function selectStageIntent(state, result, index, sceneId, activityIds, catalog) {
  validateIndex(result, index);
  validateChoice({sceneId, activityIds});
  const next = clone(state), stage = result.stages[index];
  const current = {sceneId, activityIds: [...activityIds], ...(stage.mealRole ? {mealRole: stage.mealRole} : {})};
  // 连续修改尚未提交的同场景活动，也沿用该选择的显式预约。
  const previous = choiceAt(state, stage, index);
  if (previous.sceneId === sceneId && Number.isFinite(previous.startMinute)) current.startMinute = previous.startMinute;
  else if (stage.sceneId === sceneId && Number.isFinite(stage.fixedStartMinute)) current.startMinute = stage.fixedStartMinute;
  next.prefix = [...precedingChoices(state, result, index), current];
  if (stage.mealRole) {
    next.context.mealChoices = {...next.context.mealChoices, [stage.mealRole]: {sceneId, activityIds: [...activityIds]}};
  }
  next.context.explicitConsentIds = consentIds(next.prefix, catalog);
  return next;
}

export function selectMealIntent(state, result, role, choice, fromStage, catalog) {
  validateIndex(result, fromStage, true);
  if (!['breakfast', 'lunch', 'dinner', 'supper'].includes(role)) throw new RangeError('未知餐次。');
  const special = (role === 'breakfast' && choice?.mode === 'before_meeting') ||
    (role === 'supper' && choice?.mode === 'skip');
  if (special) {
    if (choice.sceneId != null || choice.activityIds != null) throw new TypeError('特殊用餐模式不能同时锁定餐馆或活动。');
  } else {
    if (choice?.mode && choice.mode !== 'together') throw new TypeError('该餐次不支持此用餐模式。');
    validateChoice(choice);
  }
  const next = clone(state);
  // 当前餐通过mealChoices表达一次；真实前序中出现同一餐次属于错误边界。
  next.prefix = precedingChoices(state, result, fromStage);
  if (next.prefix.some(stage => stage.mealRole === role)) throw new RangeError('用餐边界位于当前餐次之后。');
  next.context.mealChoices = {...next.context.mealChoices, [role]: special ? {mode: choice.mode} : clone(choice)};
  next.context.explicitConsentIds = consentIds([...next.prefix, ...(special ? [] : [choice])], catalog);
  return next;
}

export function exploreIntent(state, exploration, seed) {
  if (!Number.isInteger(exploration) || exploration < 0 || exploration > 100) throw new RangeError('探索度必须为0到100的整数。');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('探索种子必须为uint32。');
  const next = clone(state), mealChoices = state.context.mealChoices || {};
  next.exploration = exploration;
  next.prefix = [];
  next.context.mealChoices = {};
  for (const [role, mode] of [['breakfast', 'before_meeting'], ['supper', 'skip']]) {
    if (mealChoices[role]?.mode === mode) next.context.mealChoices[role] = {mode};
  }
  next.context.explicitConsentIds = [];
  next.context.explorationSeed = seed;
  return next;
}
