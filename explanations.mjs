import {interestLabels} from './planner.mjs?v=4.1.0';
import {preparationOptions,dietaryOptions} from './data/activities.mjs?v=4.1.0';

// 首页理由只使用用户的选择与实际安排，技术轨迹留在菜单中的知识页。
export function explainStage(stage,place,context={}) {
  const acts=place.activities.filter(a=>stage.activityIds.includes(a.id));
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
  const prepared=[...new Set(acts.flatMap(a=>a.requires||[]))].filter(id=>(context.preparedIds||[]).includes(id));
  if(prepared.length)lines.push(`这项玩法需要${prepared.map(id=>preparationOptions.find(p=>p.id===id)?.label||id).join('、')}；确认你们已经准备好后，才保留这项选择。`);
  return lines.slice(0,6);
}
