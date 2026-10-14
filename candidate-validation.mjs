import {selectStageIntent,selectMealIntent,selectDepartureIntent,projectStageChoice,setStageDurationIntent,splitStageIntent,mergeStageIntent} from './planning-intent.mjs?v=a4420782c4d5e641';
import {splitDuration} from './duration-policy.mjs?v=a4420782c4d5e641';
// 候选验证与当前安排分开：只补全卡片评分，不改选中地点、时间线或复盘输出。
export const candidateKey = ({stageIndex, sceneId, mealRole}) => `${mealRole ? `meal-${mealRole}` : `stage-${stageIndex}`}:${sceneId}`;

/** 验证必须复用点击时的意图投影，不能把旧餐次条件或自动排程时间带入搜索。 */
export function buildActionJobs(result, state, catalog, actions = []) {
  if (!Array.isArray(result?.stages)) return [];
  const jobs = new Map();
  for (const action of actions) {
    const {stageIndex, mealRole, actionType, sceneId, activityIds} = action;
    if(result.ok!==true&&!['meal_option','meal_mode'].includes(actionType))continue;
    let next;
    if (actionType === 'departure') next = selectDepartureIntent(state, result, action.departureId, catalog);
    else if (actionType === 'meal_mode') next = selectMealIntent(state, result, mealRole, action.choice, stageIndex, catalog);
    else if (actionType === 'duration') next = setStageDurationIntent(state,result,stageIndex,action.durationMinutes,catalog);
    else if (actionType === 'split') next = splitStageIntent(state,result,stageIndex,catalog);
    else if (actionType === 'merge') next = mergeStageIntent(state,result,stageIndex,catalog);
    else if (actionType === 'scene' || actionType === 'activity' || actionType === 'meal_option') {
      next = mealRole
        ? selectMealIntent(state, result, mealRole, {sceneId, activityIds}, stageIndex, catalog)
        : selectStageIntent(state, result, stageIndex, sceneId, activityIds, catalog);
    } else throw new TypeError(`未知验证动作：${actionType}`);
    const key = action.actionKey ?? JSON.stringify([action.viewKey ?? null, stageIndex ?? null, mealRole ?? null, actionType, sceneId ?? null, activityIds ?? null, action.activityId ?? null, action.departureId ?? null, action.choice ?? null]);
    let knownPlan = action.continuationWitness ?? action.candidate?.continuationWitness;
    if (knownPlan == null) {
      knownPlan = result.stages.map(stage => ({...projectStageChoice(stage), ...(stage.anchorId !== undefined ? {anchorId:stage.anchorId} : {})}));
      if (actionType === 'scene' || actionType === 'activity' || actionType === 'meal_option') {
        // 虚拟餐卡插入真实用餐；已有阶段只替换当前目标，其余作为快捷重验的初次尝试。
        const insertingMeal = mealRole && result.stages[stageIndex]?.mealRole !== mealRole;
        const anchorId = insertingMeal ? undefined : result.stages[stageIndex]?.anchorId;
        knownPlan.splice(stageIndex, insertingMeal ? 0 : 1, {...structuredClone(next.prefix.at(-1)), ...(anchorId !== undefined ? {anchorId} : {})});
      } else if (actionType === 'duration') {
        knownPlan[stageIndex]={...knownPlan[stageIndex],durationMinutes:action.durationMinutes};
      } else if (actionType === 'split') {
        const stage=result.stages[stageIndex],scene=catalog.scenes.find(s=>s.id===stage.sceneId);
        const parts=splitDuration(scene,stage.minutes);
        knownPlan.splice(stageIndex,1,{...knownPlan[stageIndex],durationMinutes:parts[0]},
          {sceneId:stage.sceneId,activityIds:[],durationMinutes:parts[1]});
      } else if (actionType === 'merge') {
        knownPlan.splice(stageIndex,2,structuredClone(next.prefix.at(-1)));
      }
    }
    const meal = mealRole ? result.mealRequirements?.find(item => item.mealRole === mealRole) : null;
    const reference = action.reference ?? (meal?.stageIndex === null ? null : result.stages[stageIndex]?.scoreReference);
    const candidate = {...structuredClone(action.candidate), ...(sceneId !== undefined ? {sceneId} : {}), ...(activityIds !== undefined ? {activityIds:[...activityIds]} : {})};
    const search={...structuredClone(result.replay?.search ?? {}),method:'bounded',maxCandidateExpandedNodes:0};
    // 旧方案的阶段上限可能来自提前结束；新后续必须重新决定容量。
    if(actionType!=='departure')delete search.maxStages;
    jobs.set(key, {...structuredClone(action), actionFields:structuredClone(action), candidate, key, context:next.context, prefix:next.prefix, exploration:next.exploration, reference, knownPlan:structuredClone(knownPlan), search});
  }
  return [...jobs.values()];
}

function validationStatus(job, result) {
  if (result?.ok) return !job.actionType || Array.isArray(result.continuationWitness)&&result.continuationWitness.length>0 ? 'verified' : 'unresolved';
  if (['invalid_data', 'error'].includes(result?.status)) return 'error';
  if (['invalid_input', 'hard_rejected', 'hard_violation', 'hard_violations'].includes(result?.status)) return 'hard_rejected';
  return 'unresolved';
}

export function buildCandidateJobs(result, state, {pendingCandidates = null} = {}) {
  if (!result?.ok) return [];
  const jobs = new Map();
  function add(stageIndex, mealRole, candidate, reference) {
    if (!candidate.sceneId || Number.isFinite(candidate.fitScore)) return;
    const context = structuredClone(state.context);
    if (mealRole) context.mealChoices = {...context.mealChoices, [mealRole]: {sceneId:candidate.sceneId, activityIds:[...candidate.activityIds]}};
    // 自动排出的时间不是预约，不能转成硬性开始时间，否则会额外触发鲁棒缓冲约束。
    const prefix = result.stages.slice(0, stageIndex).map(s => ({sceneId:s.sceneId, activityIds:[...s.activityIds], ...(Number.isFinite(s.fixedStartMinute) ? {startMinute:s.fixedStartMinute} : {}), ...(s.mealRole ? {mealRole:s.mealRole} : {})}));
    prefix.push({sceneId:candidate.sceneId, activityIds:[...(candidate.activityIds || [])], ...(mealRole ? {mealRole} : {}), ...(Number.isFinite(candidate.fixedStartMinute) ? {startMinute:candidate.fixedStartMinute} : {})});
    const job = {stageIndex, sceneId:candidate.sceneId, ...(mealRole ? {mealRole} : {}), candidate, reference, context, prefix, exploration:state.exploration, search:{...result.replay.search, method:'bounded', maxCandidateExpandedNodes:0}};
    job.key = candidateKey(job);
    jobs.set(job.key, job);
  }
  if (pendingCandidates) {
    // 冻结的横条可能保留搜索输出已截断的卡片，仍须补分，不能让它们无限转圈。
    for (const entry of pendingCandidates) {
      const meal = entry.mealRole ? result.mealRequirements?.find(m => m.mealRole === entry.mealRole) : null;
      const index = meal ? meal.stageIndex ?? meal.insertIndex : entry.stageIndex;
      const reference = entry.reference ?? (meal?.stageIndex === null ? null : result.stages[index]?.scoreReference);
      if (Number.isInteger(index) && index >= 0 && index <= result.stages.length) add(index, entry.mealRole, entry.candidate, reference);
    }
  } else {
    result.stages.forEach((stage, i) => (stage.candidates || []).forEach(c => add(i, stage.mealRole, c, stage.scoreReference)));
    for (const meal of result.mealRequirements || []) {
      const index = meal.stageIndex ?? meal.insertIndex;
      const reference = meal.stageIndex === null ? null : result.stages[index]?.scoreReference;
      for (const candidate of meal.candidates || []) add(index, meal.mealRole, candidate, reference);
    }
  }
  return [...jobs.values()];
}

export function validatedCandidate(job, result) {
  const status = validationStatus(job, result);
  if (status !== 'verified') return {...job.candidate, fitScore:null, score:null, recommendationIndex:null, rawUtility:null, q:null, continuationWitness:null, scoreStatus:status, evaluationStatus:status === 'error' ? 'validation_error' : status === 'hard_rejected' ? 'hard_rejected' : 'bounded_no_continuation_found', continuationFound:false, feasibilityStatus:status === 'hard_rejected' ? 'hard_rejected' : 'unresolved'};
  const prefixUtility = job.reference?.prefixUtility ?? result.prefixUtility;
  const referenceUtility = job.reference?.referenceUtility ?? result.referenceUtility;
  const gain = result.q - prefixUtility;
  const fitScore = +(50 + 50 * gain / (Math.abs(gain) + referenceUtility)).toFixed(2);
  return {...job.candidate, fitScore, score:fitScore, recommendationIndex:fitScore, rawUtility:result.q, q:result.q, scoreVersion:result.scoreVersion, scoreStatus:'evaluated', evaluationStatus:'complete_continuation_found', continuationFound:true, feasibilityStatus:'feasible_continuation_found', ...(result.continuationWitness ? {continuationWitness:result.continuationWitness} : {})};
}

/** 先贯穿各阶段重验完整路径，再分片补搜索；短片段合并运行，避免逐片空等。 */
export function createCandidateScheduler({createSearch, verifyCandidate, onResult, schedule = setTimeout, cancel = clearTimeout, now = () => performance.now(), idleDelay = 4, visibleDelay = 0, maxStepsPerTick = 32, sliceMs = 8}) {
  let generation = null, timer = null, timerRevision = 0, turn = 0, revision = 0, paused = false;
  const jobs = new Map(), groups = new Map();
  const profiles = [{beamWidth:8, maxExpandedNodes:1600}, {beamWidth:16, maxExpandedNodes:6000}, {beamWidth:32, maxExpandedNodes:18000}];
  const primary = job => !job.actionType || ['scene','departure','meal_option','meal_mode'].includes(job.actionType);
  function choose(entries) {
    const byGroup = new Map();
    for (const job of entries) {
      if (!byGroup.has(job.groupKey)) byGroup.set(job.groupKey, []);
      byGroup.get(job.groupKey).push(job);
    }
    // 各段先有三个可用选项；同一段的更多选项不能挡住后面的整段。
    const ordered = [...byGroup].sort(([a,aa],[b,bb]) => {
      const ga=groups.get(a), gb=groups.get(b);
      return Math.min(ga.verified,3)-Math.min(gb.verified,3)
        || Number(bb.some(j=>j.visible))-Number(aa.some(j=>j.visible))
        || ga.turn-gb.turn;
    });
    const list = ordered[0]?.[1];
    return list?.sort((a,b) => Number(b.visible)-Number(a.visible)
      || Number(primary(b)&&b.selected===true)-Number(primary(a)&&a.selected===true)
      || Number(!!b.iterator)-Number(!!a.iterator)
      || Number(primary(b))-Number(primary(a)) || a.turn-b.turn)[0];
  }
  function nextJob() {
    const entries = [...jobs.values()];
    // 已有证书的重验只花很短时间，先把全时间线铺出来，不被一个难搜选项阻塞。
    const checks = entries.filter(job=>job.phase==='check');
    if (checks.length) return choose(checks);
    let active = entries.filter(job=>job.iterator);
    if(active.length===2&&active[0].groupKey===active[1].groupKey) {
      const other=entries.some(job=>job.visible&&!job.iterator&&job.groupKey!==active[0].groupKey);
      if(other) {
        // 同段占满槽位时让出一棵低优先树；只撤销未回包的搜索，稍后按原预算重新核验。
        const displaced=[...active].sort((a,b)=>Number(a.visible)-Number(b.visible)||a.turn-b.turn)[0];
        displaced.iterator.return();displaced.iterator=null;displaced.preemptions++;
        active=active.filter(job=>job!==displaced);
      }
    }
    // 仅保留一个普通搜索；可见搜索可以抢占它，同时最多挂起两棵搜索树。
    return choose(entries.filter(job=>job.iterator || !active.length || job.visible&&active.length<2));
  }
  function arm(delay) {
    if (paused || timer !== null || !jobs.size) return;
    const token = revision, ticket=++timerRevision;
    timer = schedule(()=>{if(token===revision&&ticket===timerRevision&&!paused)tick();}, delay);
  }
  function complete(job, result) {
    jobs.delete(job.key);
    const status = validationStatus(job, result);
    if(status==='verified'&&primary(job))groups.get(job.groupKey).verified++;
    const candidate = {...validatedCandidate(job, result), validation:{attempts:job.attempt+1, expandedNodes:job.expanded, computeMs:job.elapsed, preemptions:job.preemptions, visiblePriority:job.visible, searchStatus:result?.status, errors:result?.errors || []}};
    onResult({...job.actionFields, generation, key:job.key, stageIndex:job.stageIndex, sceneId:job.sceneId, mealRole:job.mealRole, validationStatus:status, continuationWitness:status === 'verified' ? result?.continuationWitness ?? null : null, candidate});
  }
  function advance(job) {
    const started = now();
    try {
      if (job.phase==='check') {
        const verified = verifyCandidate(job, profiles[0]);
        job.elapsed += now()-started;
        job.phase='search';
        if(verified?.ok)complete(job,verified);
        return;
      }
      if (!job.iterator) job.iterator = createSearch(job, profiles[job.attempt]);
      const step = job.iterator.next();
      job.elapsed += now() - started;
      if (step.done) {
        job.iterator = null;
        job.expanded += step.value?.search?.expandedNodes || 0;
        const status = validationStatus(job, step.value);
        const final = step.value?.ok || status === 'hard_rejected' || status === 'error' || job.attempt === profiles.length-1;
        if (final) complete(job,step.value);
        else job.attempt++;
      }
    } catch (error) {
      jobs.delete(job.key);
      try { job.iterator?.return(); } catch { /* 原搜索错误优先回包，关闭失败不能阻断其他动作。 */ }
      onResult({...job.actionFields, generation, key:job.key, stageIndex:job.stageIndex, sceneId:job.sceneId, mealRole:job.mealRole, validationStatus:'error', continuationWitness:null, candidate:{...validatedCandidate(job, null), scoreStatus:'error', evaluationStatus:'validation_error'}, error:String(error.message || error)});
    }
  }
  function tick() {
    timer = null;
    const token=revision, started=now();
    let steps=0;
    do {
      const job=nextJob();if(!job)break;
      job.turn=++turn;groups.get(job.groupKey).turn=turn;
      advance(job);steps++;
    } while(token===revision&&!paused&&jobs.size&&steps<maxStepsPerTick&&now()-started<sliceMs);
    if(token===revision)arm([...jobs.values()].some(j => j.visible) ? visibleDelay : idleDelay);
  }
  function reset(nextGeneration, entries = []) {
    revision++;timerRevision++;
    if (timer !== null) cancel(timer);
    timer = null;
    for (const job of jobs.values()) job.iterator?.return();
    jobs.clear();groups.clear(); generation = nextGeneration; turn = 0;
    for (const entry of entries) {
      const groupKey=entry.viewKey??(entry.mealRole?`meal-${entry.mealRole}`:`stage-${entry.stageIndex??0}`);
      if(!groups.has(groupKey))groups.set(groupKey,{turn:groups.size,verified:0});
      jobs.set(entry.key, {...entry,groupKey,phase:typeof verifyCandidate==='function'?'check':'search',visible:false,iterator:null,attempt:0,preemptions:0,elapsed:0,expanded:0,turn:++turn});
    }
    arm(idleDelay);
  }
  return {
    reset,
    pause(value) {
      paused = !!value;
      timerRevision++;
      if (timer !== null) cancel(timer);
      timer = null;
      if (!paused) arm([...jobs.values()].some(j => j.visible) ? visibleDelay : idleDelay);
    },
    prioritize(key) {
      const job = jobs.get(key);
      if (!job || job.visible) return;
      job.visible = true;
      timerRevision++;
      if (timer !== null) cancel(timer);
      timer = null;
      arm(visibleDelay);
    },
    dispose: () => reset(null),
  };
}
