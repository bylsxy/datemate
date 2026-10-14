import test from 'node:test';
import assert from 'node:assert/strict';
import {planDate,verifyPlanWitness} from '../engine.mjs';
const fixture={version:'bundled-travel-test',transfers:{campus:{campus:0}},departures:[{id:'separate',minutes:15,cost:[0,0]}],scenes:[
  {id:'trip',title:'完整往返旅行',kind:'travel',area:'campus',minutes:780,durationRange:[60,900],cost:[200,200],load:0,indoor:false,bundledMeals:['lunch','dinner'],activities:[]},
  {id:'meal',kind:'meal',area:'campus',minutes:30,cost:[0,0],load:0,indoor:true,mealRoles:['lunch','dinner'],activities:[{id:'eat',mealRoles:['lunch','dinner'],provides:['meal_completed'],cost:[30,30],load:0}]},
]};
const context={periodIds:['morning','afternoon','evening'],mealChoices:{breakfast:{mode:'before_meeting'}},endAfterStage:0,robust:false,reserve:0,budget:200};
const options={fixedPrefix:[{sceneId:'trip',activityIds:[],durationMinutes:780}],maxCandidateExpandedNodes:0};
test('完整旅行真实容纳两餐并计入预算，见证可以复算',()=>{
  const result=planDate(context,fixture,options);assert.equal(result.ok,true,result.errors?.join(';'));
  assert.deepEqual(result.stages[0].bundledMeals.map(m=>[m.mealRole,m.startMinute,m.endMinute]),[['lunch',720,750],['dinner',1080,1110]]);
  assert.deepEqual(result.totalCost,[200,200]);assert.equal(result.metrics.mealSatisfied,true);
  assert.ok(result.mealRequirements.filter(m=>m.choiceMode==='together').every(m=>m.satisfied&&m.bundled&&m.candidates.length===0));
  assert.equal(verifyPlanWitness(context,fixture,{...options,knownPlan:result.continuationWitness}).ok,true);
  assert.equal(planDate({...context,budget:199},fixture,options).ok,false);
});
test('旅行不能覆盖用户另选的餐馆，也不能缺少其中一餐',()=>{
  assert.equal(planDate({...context,mealChoices:{...context.mealChoices,dinner:{sceneId:'meal',activityIds:['eat']}}},fixture,options).ok,false);
  const missing=structuredClone(fixture);missing.scenes[0].bundledMeals=['lunch'];
  assert.equal(planDate(context,missing,options).ok,false);
});
test('仅跨饭点十分钟不算吃过饭，不在旅行时段内的餐次继续待安排',()=>{
  const partial=planDate({...context,periodIds:['afternoon','evening']},fixture,{...options,fixedPrefix:[{sceneId:'trip',activityIds:[],durationMinutes:250}]});
  assert.equal(partial.ok,false);
  const early=planDate(context,fixture,{...options,fixedPrefix:[{sceneId:'trip',activityIds:[],durationMinutes:300}]});
  assert.equal(early.ok,false);
});
