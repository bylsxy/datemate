import {isSceneInSchoolScope} from './school-scope.mjs?v=644ec13f68f75c23';
import {isSceneAvailableInContext} from './scene-time.mjs?v=644ec13f68f75c23';

export function mealModeCard(role) {
  if(role==='breakfast')return {id:'__breakfast_together',title:'一起吃早餐'};
  if(role==='supper')return {id:'__supper_together',title:'一起吃宵夜'};
  return null;
}

// 先决定是否一起吃，再选择实际去处。每项仍提交真实地点和用餐活动，由同一个规划器验证。
export function mealOptions(catalog,context,role,current,candidates=[]) {
  const activeContext={...context,mealChoices:{...context.mealChoices,[role]:{mode:'together'}}};
  const candidateById=new Map(candidates.map(c=>[c.sceneId,c]));
  const result=[];
  for(const scene of catalog.scenes){
    if(!scene.mealRoles?.includes(role)||!isSceneInSchoolScope(scene,context)||!isSceneAvailableInContext(scene,activeContext))continue;
    if(context.bans?.includes(scene.id)||context.quietRequired&&scene.quiet!==true||context.crowdAvoidance&&scene.crowdRisk==='high')continue;
    if(context.weather==='rain'&&(!scene.indoor&&!scene.sheltered||scene.weather?.length&&!scene.weather.includes('rain')))continue;
    const available=scene.activities.filter(a=>a.mealRoles?.includes(role)&&a.provides?.includes('meal_completed')&&!context.bans?.includes(a.id)&&!(a.dietaryTags||[]).some(tag=>context.dietaryRestrictions?.includes(tag)));
    if(!available.length)continue;
    const selected=current?.sceneId===scene.id&&current.activityIds?.some(id=>available.some(a=>a.id===id));
    const suggested=candidateById.get(scene.id);
    const activity=available.find(a=>selected&&current.activityIds.includes(a.id))||available.find(a=>suggested?.activityIds?.includes(a.id))||[...available].sort((a,b)=>a.cost[1]-b.cost[1]||a.id.localeCompare(b.id))[0];
    const activityIds=selected?[...current.activityIds]:suggested?.activityIds?.includes(activity.id)?[...suggested.activityIds]:[activity.id];
    result.push({sceneId:scene.id,activityIds,selected:!!selected,title:scene.title,description:scene.description,cost:scene.cost.map((n,i)=>n+activity.cost[i]),candidate:suggested});
  }
  return result;
}
