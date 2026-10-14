import {interestLabels} from './planner.mjs?v=32c9a437a5c51c9d';
import {dietaryOptions} from './data/activities.mjs?v=32c9a437a5c51c9d';

// 简短理由保留原调用方式；详细决策与原始规则轨迹由 explainDecision 提供。
export function explainStage(stage,place,context={}) {
  const acts=(place.activities||[]).filter(a=>(stage.activityIds||[]).includes(a.id));
  const tags=new Set([...(place.tags||[]),...acts.flatMap(a=>a.tags||[])]);
  const shared=(context.preferencesA||[]).filter(t=>(context.preferencesB||[]).includes(t)&&tags.has(t));
  const lines=[];
  if(stage.manual)lines.push('你指定了这里，先保留前面的选择，再重新安排后面。');
  if(context.weather==='rain'&&place.indoor)lines.push('你勾选了预计下雨，先去掉容易淋雨的地点，再从室内地点里挑选。');
  if(place.kind==='rest')lines.push((stage.trace||[]).some(t=>t.ruleId==='R-fatigue-derive')?'按你设置的疲惫状态和前面活动的强度推算，这时需要缓一缓，所以先休息再继续。':stage.index===0?'先坐下来歇一会儿，再慢慢开始。':'前面安排了几件事，这里留一段时间歇歇。');
  if(stage.mealRole){
    const causes={breakfast:'你选择了上午，先留出一起吃早餐的时间',lunch:'上午和下午连着安排，会经过午饭时间',dinner:'下午和晚上连着安排，会经过晚饭时间',supper:'晚上和夜晚连着安排，在23点附近留一段吃宵夜的时间'};
    lines.push(`${causes[stage.mealRole]}，再把两边的活动接起来。`);
  }
  if(shared.length)lines.push(`你们都勾选了${shared.map(t=>interestLabels[t]||t).join('、')}，将地点和实际选中的活动一起比较，这段能照顾共同兴趣。`);
  else if(acts.length)lines.push(`这里选中了${acts.map(a=>a.title).join('、')}；比较它们是否符合两人的喜好，再和前后安排接起来。`);
  else if(place.kind!=='rest')lines.push('你没有在这里加选活动，这段按地点本身和顺路程度来比较，留给你们按自己的节奏相处。');
  if(context.dietaryRestrictions?.length)lines.push(`你勾选了不吃${context.dietaryRestrictions.map(id=>dietaryOptions.find(x=>x.id===id)?.label||id).join('、')}，先避开这些食物，再比较剩下的选择。`);
  if(context.budget!==null&&context.budget!==undefined)lines.push('先确认整段花费在你设置的额度内，再比较还能去哪些地方。');
  if(acts.some(a=>Array.isArray(a.provides)?a.provides.includes('meal_completed'):a.provides?.meal_completed>0)&&!stage.mealRole)lines.push('这段包含实际吃饭的活动，因此会核算餐费，并检查前后是否赶得上。');
  // 准备栏负责区分外部物品和内部成果，短摘要不从 requires 推断准备事项。
  return lines.slice(0,6);
}

// 仅格式化已有事实，不截断数组或对象，也不把缺失值当成零或 false。
export function formatFact(value) {
  if(value===undefined)return '未提供';
  if(value===null)return 'null（空值）';
  if(typeof value==='string')return value;
  if(typeof value==='boolean')return value?'true（是）':'false（否）';
  if(typeof value==='object')return JSON.stringify(value,null,2);
  return String(value);
}

const featureLabels={
  preferenceA:'A 的偏好匹配',preferenceB:'B 的偏好匹配',sharedInterest:'共同兴趣',
  generalPreference:'通用偏好',goalBonus:'目标匹配',themeBonus:'主题匹配',
  activityExperienceA:'A 的活动体验',activityExperienceB:'B 的活动体验',
  sharedActivityExperience:'共同活动体验',generalActivityExperience:'通用活动体验',
  comfort:'舒适度',transferPenalty:'转场扣分',extraActivityPenalty:'额外活动扣分',
  resourcePenalty:'资源消耗扣分',repeatFunctionPenalty:'同类阶段重复扣分',
  repeatScenePenalty:'同地点重复扣分',unnecessaryRestPenalty:'非必要休息扣分',
  stageComplexityPenalty:'阶段复杂度扣分',novelty:'新鲜度',variety:'多样性',
  ruleBonus:'规则综合项',fairnessFloor:'双方体验最低值项',activeCoverage:'活动覆盖',waitPenalty:'等待扣分',
};
const traceTitles={KG_PREFERENCE_PATH:'图谱偏好匹配',RESOURCE_ACCOUNTING:'时间、费用与资源核算'};
const scoreOf=value=>value.scoreStatus==='pending'||value.continuationFound===false?null:
  Number.isFinite(value.fitScore)?value.fitScore:Number.isFinite(value.score)?value.score:null;
const mealLabels={breakfast:'早餐',lunch:'午餐',dinner:'晚餐',supper:'宵夜'};

/** 展示可核查的规则执行记录与搜索结果，不生成模型内部思维。
 * trace/raw、候选及约束使用独立副本，供渲染方展开，避免修改规划结果。
 */
export function explainDecision(stage,place,context={}) {
  const score=scoreOf(stage);
  const candidates=structuredClone(stage.candidates||[]);
  const evaluated=candidates.filter(c=>scoreOf(c)!==null);
  const higher=score===null?null:evaluated.filter(c=>scoreOf(c)>score).length;
  const tied=score===null?null:evaluated.filter(c=>scoreOf(c)===score).length;
  const rank=higher===null?null:higher+1;
  const bestScore=evaluated.length?Math.max(...evaluated.map(scoreOf)):null;
  const locked=Boolean(stage.manual);
  const anchored=stage.anchorId!==undefined&&stage.anchorId!==null;
  const requiredScene=(context.requiredSceneIds||[]).includes(stage.sceneId);
  const anchor=anchored?(context.anchors||[]).find(a=>a.id===stage.anchorId):undefined;
  const scoreMessage=score===null?'本次初始搜索中，当前选择尚无可用的完整后续方案得分。':
    `本次初始搜索中，当前选择的方案契合分为 ${formatFact(score)}；${evaluated.length?`在本次初始搜索返回的 ${evaluated.length} 个已评分候选中列第 ${rank} 位（按高于该分数的候选数计）`:'本次初始搜索没有已评分候选可用于排名'}。`;
  const selectionMessage=[locked?'当前选择由手动锁定，保留指定地点和活动组合。':stage.decisionMode==='seeded_exploration'?'当前选择来自本次初始探索搜索，在满足硬约束的完整方案中尝试不同路线；卡片按探索顺序展露，契合分仍使用真实计算值。':'当前选择来自本次初始搜索的有界规划。',
    requiredScene?'当前地点满足必去地点要求；访问次序由引擎安排。':null,
    anchored?`本阶段受预约锚点 ${formatFact(stage.anchorId)} 约束。`:null,
    context.requiredSceneIds?.length?`本次输入包含 ${context.requiredSceneIds.length} 项必去地点要求，完整内容见约束记录。`:null,
    context.anchors?.length?`本次输入包含 ${context.anchors.length} 项预约约束，完整内容见约束记录。`:null,
    context.bans?.length?`本次输入包含 ${context.bans.length} 项排除约束，完整内容见约束记录。`:null,
    stage.mealRole?`本阶段承担${mealLabels[stage.mealRole]||stage.mealRole}安排。`:null,scoreMessage].filter(Boolean).join('');
  const reference=structuredClone(stage.scoreReference??null);
  const q=Number.isFinite(stage.rawUtility)?stage.rawUtility:null;
  const prefix=Number.isFinite(reference?.prefixUtility)?reference.prefixUtility:null;
  const scale=Number.isFinite(reference?.referenceUtility)?reference.referenceUtility:null;
  const gain=q!==null&&prefix!==null?q-prefix:null;
  const formula=reference?.formula??null;
  // 特征有折扣、合并和非线性项，不能冒充各项之和等于完整方案效用。
  const features=structuredClone(stage.featureContributions||{});
  const metrics={score,rawUtility:stage.rawUtility,scoreReference:reference,remainingUtility:gain,
    formula,calculation:q!==null&&prefix!==null&&scale!==null&&formula?
      `q=${formatFact(q)}，prefixUtility=${formatFact(prefix)}，referenceUtility=${formatFact(scale)}；q - prefixUtility=${formatFact(gain)}；公式：${formula}`:
      '评分参考数据未完整提供，无法展示完整计算。',
    featureContributions:features,features:Object.entries(features).map(([id,value])=>({id,label:featureLabels[id]||id,value})),
    featureNote:'这些是引擎记录的特征项，不能直接相加当作完整方案效用。',
    stageFacts:structuredClone(Object.fromEntries(['minutes','transfer','wait','start','end','cost','costCents','loadByPerson','reserve','uncertaintyMinutes','localUtility','before','after'].filter(key=>Object.hasOwn(stage,key)).map(key=>[key,stage[key]]))),
  };
  const comparison={message:`本次初始搜索返回的候选中，${evaluated.length} 项已有完整后续评分，${candidates.length-evaluated.length} 项没有可比较的完整后续评分。比较保留此前阶段和锚点；候选列表及搜索有界，不代表全局最优。这里的排名仅依据本次初始搜索快照；后台验证结果独立显示，可能找到更优候选，当前选择不会因此自动改变。`,
    basis:'initial_planning_snapshot',
    candidates,evaluatedCount:evaluated.length,pendingCount:candidates.length-evaluated.length,
    rank,higherCount:higher,tiedCount:tied,bestScore,
    scope:reference?.scope??null,searchStatus:reference?.searchStatus??null};
  const selection={message:selectionMessage,manual:locked,requiredScene,anchorId:stage.anchorId??null,
    anchor:structuredClone(anchor??null),mealRole:stage.mealRole??null,
    sceneId:stage.sceneId,activityIds:structuredClone(stage.activityIds||[]),
    constraints:structuredClone({bans:context.bans||[],anchors:context.anchors||[],requiredSceneIds:context.requiredSceneIds||[]}),score,rank};
  // 不去重、不重排：同一规则对多个活动执行也必须逐条呈现。
  const trace=(stage.trace||[]).map(entry=>{
    const raw=structuredClone(entry);
    return {...structuredClone(entry),title:entry.title??traceTitles[entry.ruleId]??entry.ruleId??entry.rule??'规则执行记录',raw};
  });
  return {summary:explainStage(stage,place,context),selection,comparison,metrics,trace};
}
