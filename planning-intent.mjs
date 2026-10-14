// 用户意图与求解结果分离：仅投影显式选择，不把自动排程变成预约。
import {durationBounds,splitDuration,mergeStayOption} from './duration-policy.mjs?v=36f4e0d02f4b2a0b';
const clone = value => structuredClone(value);
const mealRoles = ['breakfast', 'lunch', 'dinner', 'supper'];

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
    ...(stage.durationRange && Number.isInteger(stage.minutes) ? {durationMinutes:stage.minutes} : {}),
    ...(Number.isFinite(stage.fixedStartMinute) ? {startMinute: stage.fixedStartMinute} : {}),
  };
}

function validateIndex(result, index, allowEnd = false, requireComplete = true) {
  if ((requireComplete && result?.ok !== true) || !Array.isArray(result?.stages) || !Number.isInteger(index) || index < 0 ||
      index >= result.stages.length + Number(allowEnd)) {
    throw new RangeError('选择位置必须对应有效安排的真实阶段或用餐插入位置。');
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
  if (Number.isInteger(pending.durationMinutes)) selected.durationMinutes = pending.durationMinutes;
  else if (pending.sceneId === stage.sceneId && Number.isInteger(actual.durationMinutes)) selected.durationMinutes = actual.durationMinutes;
  if (Number.isFinite(explicitStart)) selected.startMinute = explicitStart;
  else if (pending.sceneId === stage.sceneId && Number.isFinite(actual.startMinute)) selected.startMinute = actual.startMinute;
  return selected;
}

function precedingChoices(state, result, index) {
  return result.stages.slice(0, index).map((stage, i) => choiceAt(state, stage, i));
}

function specialMealMode(role, choice) {
  const mode = typeof choice === 'string' ? choice : choice?.mode;
  return (role === 'breakfast' && mode === 'before_meeting') || (role === 'supper' && mode === 'skip');
}

function releaseLaterMeals(next, result, index, currentRole = null) {
  const choices = {...next.context.mealChoices};
  const fixedRoles = new Set(next.prefix.map(choice => choice.mealRole).filter(Boolean));
  for (const meal of result.mealRequirements || []) {
    const role = meal.mealRole;
    if (role === currentRole || fixedRoles.has(role) || specialMealMode(role, choices[role])) continue;
    const position = meal.stageIndex ?? meal.insertIndex;
    // 失败菜单中的多个尚未安排餐次可能共享insertIndex，按饭点顺序区分当前之后。
    const later = Number.isInteger(position) && (position > index ||
      (position === index && currentRole && mealRoles.indexOf(role) > mealRoles.indexOf(currentRole)));
    if (later) delete choices[role];
  }
  next.context.mealChoices = choices;
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

export function selectStageIntent(state, result, index, sceneId, activityIds, catalog, details={}) {
  validateIndex(result, index);
  validateChoice({sceneId, activityIds});
  const next = clone(state), stage = result.stages[index];
  const current = {sceneId, activityIds: [...activityIds], ...(stage.mealRole ? {mealRole: stage.mealRole} : {})};
  if(Number.isInteger(details.durationMinutes))current.durationMinutes=details.durationMinutes;
  // 连续修改尚未提交的同场景活动，也沿用该选择的显式预约。
  const previous = choiceAt(state, stage, index);
  if (current.durationMinutes===undefined && previous.sceneId === sceneId && Number.isInteger(previous.durationMinutes)) current.durationMinutes = previous.durationMinutes;
  if (previous.sceneId === sceneId && Number.isFinite(previous.startMinute)) current.startMinute = previous.startMinute;
  else if (stage.sceneId === sceneId && Number.isFinite(stage.fixedStartMinute)) current.startMinute = stage.fixedStartMinute;
  next.prefix = [...precedingChoices(state, result, index), current];
  releaseLaterMeals(next, result, index, stage.mealRole || null);
  if (stage.mealRole) {
    next.context.mealChoices = {...next.context.mealChoices, [stage.mealRole]: {sceneId, activityIds: [...activityIds]}};
  }
  next.context.explicitConsentIds = consentIds(next.prefix, catalog);
  return next;
}

export function selectMealIntent(state, result, role, choice, fromStage, catalog) {
  validateIndex(result, fromStage, true, false);
  if (!mealRoles.includes(role)) throw new RangeError('未知餐次。');
  const special = (role === 'breakfast' && choice?.mode === 'before_meeting') ||
    (role === 'supper' && choice?.mode === 'skip');
  if (special) {
    if (choice.sceneId != null || choice.activityIds != null) throw new TypeError('特殊用餐模式不能同时锁定餐馆或活动。');
  } else {
    if (choice?.mode && choice.mode !== 'together') throw new TypeError('该餐次不支持此用餐模式。');
    validateChoice(choice);
  }
  const next = clone(state);
  // 失败餐菜单用于恢复时，只沿用结果中真实已有的前序，不重带造成失败的待提交前缀。
  next.prefix = result.ok === true ? precedingChoices(state, result, fromStage)
    : result.stages.slice(0, fromStage).map(projectStageChoice);
  if (next.prefix.some(stage => stage.mealRole === role)) throw new RangeError('用餐边界位于当前餐次之后。');
  if (!special) {
    const current = {sceneId: choice.sceneId, activityIds: [...choice.activityIds], mealRole: role};
    if (Number.isInteger(choice.durationMinutes)) current.durationMinutes = choice.durationMinutes;
    const original = result.stages[fromStage];
    // 真实餐固定在当前动作位置；餐次条件与prefix共同约束同一次用餐。
    if (original?.mealRole === role) {
      const pending = result.ok === true ? choiceAt(state, original, fromStage) : projectStageChoice(original);
      if (current.durationMinutes === undefined && pending.sceneId === choice.sceneId && Number.isInteger(pending.durationMinutes)) current.durationMinutes = pending.durationMinutes;
      if (pending.sceneId === choice.sceneId && Number.isFinite(pending.startMinute)) current.startMinute = pending.startMinute;
      else if (Number.isFinite(original.fixedStartMinute)) current.startMinute = original.fixedStartMinute;
    }
    if (Number.isFinite(choice.fixedStartMinute)) current.startMinute = choice.fixedStartMinute;
    next.prefix.push(current);
  }
  releaseLaterMeals(next, result, fromStage, role);
  next.context.mealChoices = {...next.context.mealChoices, [role]: special ? {mode: choice.mode} : clone(choice)};
  next.context.explicitConsentIds = consentIds(next.prefix, catalog);
  return next;
}

export function setStageDurationIntent(state, result, index, minutes, catalog) {
  validateIndex(result,index);
  const stage=result.stages[index],scene=catalog.scenes.find(s=>s.id===stage.sceneId);
  const {min,max}=durationBounds(scene);
  if(!Number.isInteger(minutes)||minutes<min||minutes>max)throw new RangeError('所选时长超出这个场景允许的范围。');
  const next=selectStageIntent(state,result,index,stage.sceneId,stage.activityIds,catalog);
  next.prefix.at(-1).durationMinutes=minutes;
  if(index===result.stages.length-1)next.context.endAfterStage=index;
  return next;
}

export function splitStageIntent(state, result, index, catalog) {
  validateIndex(result,index);
  const stage=result.stages[index],scene=catalog.scenes.find(s=>s.id===stage.sceneId);
  const parts=!stage.mealRole&&scene.kind!=='rest'?splitDuration(scene,stage.minutes):null;
  if(!parts)throw new RangeError('这段安排太短，暂时不能再拆分。');
  const next=setStageDurationIntent(state,result,index,parts[0],catalog);
  next.context.minimumStageCount=next.prefix.length+1;
  delete next.context.endAfterStage;
  return next;
}

export function mergeStageIntent(state, result, index, catalog) {
  validateIndex(result,index);
  const stage=result.stages[index],scene=catalog.scenes.find(s=>s.id===stage.sceneId);
  const merge=mergeStayOption(scene,stage,result.stages[index+1]);
  if(!merge || merge.error)throw new RangeError(merge?.error || '只能合并相邻的普通安排，不能跨过餐次或预约。');
  const next=selectStageIntent(state,result,index,stage.sceneId,stage.activityIds,catalog,{durationMinutes:merge.minutes});
  // 撤销一次拆分的阶段下限，避免求解器立即把刚合并的时间再次拆开。
  const minimum=Math.max(0,(next.context.minimumStageCount??0)-1);
  if(minimum)next.context.minimumStageCount=minimum;else delete next.context.minimumStageCount;
  if(index+2===result.stages.length)next.context.endAfterStage=index;
  else if(Number.isInteger(next.context.endAfterStage)&&next.context.endAfterStage>index)next.context.endAfterStage--;
  return next;
}

export function selectDepartureIntent(state, result, id, catalog) {
  validateIndex(result, result?.stages?.length, true);
  if (typeof id !== 'string' || !id) throw new TypeError('分别方式需要有效ID。');
  const next = clone(state);
  next.prefix = precedingChoices(state, result, result.stages.length);
  next.context.explicitConsentIds = consentIds(next.prefix, catalog);
  next.context.departureChoice = id;
  return next;
}

export function exploreIntent(state, exploration, seed) {
  if (!Number.isInteger(exploration) || exploration < 0 || exploration > 100) throw new RangeError('探索度必须为0到100的整数。');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('探索种子必须为uint32。');
  const next = clone(state), mealChoices = state.context.mealChoices || {};
  next.exploration = exploration;
  next.prefix = clone(state.prefix || []);
  next.context.mealChoices = {};
  const fixedRoles=new Set(next.prefix.map(choice=>choice.mealRole).filter(Boolean));
  for(const [role,choice] of Object.entries(mealChoices))if(fixedRoles.has(role))next.context.mealChoices[role]=clone(choice);
  for (const [role, mode] of [['breakfast', 'before_meeting'], ['supper', 'skip']]) {
    const choice = mealChoices[role];
    if (specialMealMode(role, choice)) next.context.mealChoices[role] = typeof choice === 'string' ? mode : {mode};
  }
  const selectedActivities=new Set(next.prefix.flatMap(choice=>choice.activityIds));
  next.context.explicitConsentIds=(next.context.explicitConsentIds||[]).filter(id=>selectedActivities.has(id));
  next.context.explorationSeed = seed;
  return next;
}

export function restartIntent(state, seed) {
  const next=clone(state);
  next.prefix=[];next.context.explicitConsentIds=[];
  delete next.context.endAfterStage;delete next.context.minimumStageCount;
  next.context.mealChoices=Object.fromEntries(Object.entries(next.context.mealChoices||{}).map(([role,choice])=>[role,specialMealMode(role,choice)?clone(choice):{mode:'together'}]));
  return exploreIntent(next,next.exploration,seed);
}

export function updateContextIntent(state,context) {
  const hard=['periodIds','budget','weather','area','school','campusArea','fatigueA','fatigueB','quietRequired','crowdAvoidance','dietaryRestrictions','preparedIds','resources','bans','requiredSceneIds','anchors','robust','mealNeed'];
  const changed=hard.some(key=>JSON.stringify(state.context[key]??null)!==JSON.stringify(context[key]??null));
  const next=clone(state);next.context=clone(context);
  if(changed){next.prefix=[];delete next.context.endAfterStage;delete next.context.minimumStageCount;}
  else for(const key of ['endAfterStage','minimumStageCount'])if(state.context[key]!==undefined)next.context[key]=state.context[key];
  return {next,hardChanged:changed};
}
