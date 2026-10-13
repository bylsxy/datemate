import {interestLabels} from './planner.mjs';
import {preparationOptions} from './data/activities.mjs';

// 首页理由只使用用户的选择与实际安排，技术轨迹留在菜单中的知识页。
export function explainStage(stage,place,context={}) {
  const acts=place.activities.filter(a=>stage.activityIds.includes(a.id));
  const tags=new Set([...(place.tags||[]),...acts.flatMap(a=>a.tags||[])]);
  const shared=(context.preferencesA||[]).filter(t=>(context.preferencesB||[]).includes(t)&&tags.has(t));
  const lines=[];
  if(place.kind==='rest')lines.push(stage.index===0?'先坐下来歇一会儿，再慢慢开始。':'前面安排了几件事，这里留一段时间歇歇。');
  if(context.weather==='rain'&&place.indoor)lines.push('这段在室内，避开下雨。');
  if(shared.length)lines.push(`照顾你们共同喜欢的${shared.map(t=>interestLabels[t]||t).join('、')}。`);
  else if(acts.length)lines.push(`在这里安排${acts.map(a=>a.title).join('、')}，一起做点有意思的事。`);
  else if(place.kind!=='rest')lines.push('这段可以按自己的节奏待一会儿。');
  if(acts.some(a=>(a.provides||[]).includes('meal_completed')))lines.push('吃饭安排在这一段，不用临时再找地方。');
  const prepared=[...new Set(acts.flatMap(a=>a.requires||[]))].filter(id=>(context.preparedIds||[]).includes(id));
  if(prepared.length)lines.push(`用上你们已经准备好的${prepared.map(id=>preparationOptions.find(p=>p.id===id)?.label||id).join('、')}。`);
  return lines.slice(0,3);
}
