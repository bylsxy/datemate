import test from 'node:test';
import assert from 'node:assert/strict';
import {buildActionJobs, createCandidateScheduler} from '../candidate-validation.mjs';
import {selectStageIntent, selectMealIntent, selectDepartureIntent} from '../planning-intent.mjs';
import {createContinuationSearch, planDate} from '../engine.mjs';

const catalog = {scenes:[
  {id:'walk', activities:[{id:'talk'},{id:'consent', requiresExplicitConsent:true}]},
  {id:'food', activities:[{id:'eat'}]},
  {id:'other', activities:[]},
]};
function fixture() {
  return {
    state:{context:{mealChoices:{lunch:{sceneId:'food',activityIds:['eat']},dinner:{sceneId:'food',activityIds:['eat']},supper:{mode:'skip'}}}, prefix:[{sceneId:'walk',activityIds:['consent'],startMinute:20}], exploration:37},
    result:{ok:true,stages:[{sceneId:'walk',activityIds:['talk'],start:20,fixedStartMinute:20,anchorId:'reserved'}, {sceneId:'food',activityIds:['eat'],mealRole:'lunch'}, {sceneId:'other',activityIds:[]}], mealRequirements:[{mealRole:'lunch',stageIndex:1},{mealRole:'dinner',stageIndex:null,insertIndex:3},{mealRole:'supper',stageIndex:null,insertIndex:3}], replay:{search:{beamWidth:12, method:'exact',maxCandidateExpandedNodes:123}}},
  };
}
const freeze = value => {
  if (value && typeof value === 'object') {Object.values(value).forEach(freeze);Object.freeze(value);}
  return value;
};
test('四类动作复用真实 intent，释放未来条件、固定前序及重新计算明确同意', () => {
  const {state,result}=fixture();
  const actions=[
    {actionKey:'scene',viewKey:'v',stageIndex:2,actionType:'scene',sceneId:'walk',activityIds:['talk']},
    {actionKey:'activity',viewKey:'v',stageIndex:0,actionType:'activity',activityId:'consent',sceneId:'walk',activityIds:['consent']},
    {actionKey:'meal',viewKey:'v',stageIndex:1,mealRole:'lunch',actionType:'scene',sceneId:'food',activityIds:['eat']},
    {actionKey:'mode',viewKey:'v',stageIndex:3,mealRole:'supper',actionType:'meal_mode',choice:{mode:'skip'}},
    {actionKey:'departure',viewKey:'v',stageIndex:3,actionType:'departure',departureId:'together'},
  ];
  const expected=[
    selectStageIntent(state,result,2,'walk',['talk'],catalog),
    selectStageIntent(state,result,0,'walk',['consent'],catalog),
    selectMealIntent(state,result,'lunch',{sceneId:'food',activityIds:['eat']},1,catalog),
    selectMealIntent(state,result,'supper',{mode:'skip'},3,catalog),
    selectDepartureIntent(state,result,'together',catalog),
  ];
  const before=JSON.stringify({state,result,actions});freeze(state);freeze(result);freeze(actions);
  const jobs=buildActionJobs(result,state,catalog,actions);
  jobs.forEach((job,index)=>{
    assert.deepEqual(job.context,expected[index].context);
    assert.deepEqual(job.prefix,expected[index].prefix);
    assert.equal(job.exploration,37);
    assert.equal(job.key,actions[index].actionKey);
    for(const [key,value] of Object.entries(actions[index])) assert.deepEqual(job[key],value);
    assert.deepEqual(job.search,{beamWidth:12,method:'bounded',maxCandidateExpandedNodes:0});
  });
  assert.equal(jobs[1].context.mealChoices.lunch,undefined);
  assert.equal(jobs[1].context.mealChoices.dinner,undefined);
  assert.equal(jobs[1].context.mealChoices.supper,undefined);
  assert.deepEqual(jobs[0].prefix[0],{sceneId:'walk',activityIds:['consent'],startMinute:20});
  jobs[0].knownPlan[0].activityIds.push('isolated');
  assert.equal(JSON.stringify({state,result,actions}),before);
});

test('knownPlan 优先动作 witness 再候选 witness，否则 compact 实际安排并替换或插入目标', () => {
  const {state,result}=fixture();
  const base={stageIndex:2,actionType:'scene',sceneId:'walk',activityIds:['talk']};
  const own=[{sceneId:'own',activityIds:[]}], candidate=[{sceneId:'candidate',activityIds:[]}];
  const jobs=buildActionJobs(result,state,catalog,[
    {...base,actionKey:'a',continuationWitness:own,candidate:{continuationWitness:candidate}},
    {...base,actionKey:'b',candidate:{continuationWitness:candidate}},
    {...base,actionKey:'c'},
    {...base,actionKey:'d',stageIndex:3,mealRole:'dinner',sceneId:'food',activityIds:['eat']},
    {actionKey:'e',stageIndex:3,actionType:'meal_mode',mealRole:'supper',choice:{mode:'skip'}},
  ]);
  assert.deepEqual(jobs[0].knownPlan,own);assert.deepEqual(jobs[1].knownPlan,candidate);
  assert.deepEqual(jobs[2].knownPlan[0],{sceneId:'walk',activityIds:['talk'],startMinute:20,anchorId:'reserved'});
  assert.deepEqual(jobs[2].knownPlan[2],{sceneId:'walk',activityIds:['talk']});
  assert.equal(jobs[3].knownPlan.length,4);assert.equal(jobs[3].knownPlan[3].mealRole,'dinner');
  assert.equal(jobs[4].knownPlan.length,3);
  jobs[0].knownPlan[0].sceneId='changed';assert.equal(own[0].sceneId,'own');
  const anonymous=buildActionJobs(result,state,catalog,[base]);
  assert.equal(anonymous[0].key,buildActionJobs(result,state,catalog,[base])[0].key);
  assert.deepEqual(buildActionJobs({...result,ok:false},state,catalog,[base]),[]);
});

function runScheduler(entries, outcome) {
  const callbacks=new Map(),updates=[],attempts=[];let serial=0;
  const scheduler=createCandidateScheduler({
    createSearch:(job,profile)=>{attempts.push([job.key,profile]);return (function*(){return outcome(job);})();},
    onResult:update=>updates.push(update),schedule:callback=>{callbacks.set(++serial,callback);return serial;},cancel:id=>callbacks.delete(id),now:()=>0,
  });
  scheduler.reset('generation',entries);
  for(let count=0;callbacks.size && count<50;count++){const [id,callback]=callbacks.entries().next().value;callbacks.delete(id);callback();}
  assert.equal(callbacks.size,0);return {updates,attempts};
}
test('动作只有完整 witness 成功才 verified，所有 action 字段回传；硬失败、搜索未找到和异常分开', () => {
  const {state,result}=fixture();
  const names=['success','missing','hard','bounded','error'];
  const jobs=buildActionJobs(result,state,catalog,names.map(actionKey=>({actionKey,viewKey:'view',stageIndex:0,actionType:'activity',activityId:'talk',sceneId:'walk',activityIds:[],candidate:{fitScore:99,continuationWitness:[{stale:true}]},extraField:'preserved'})));
  const witness=[{sceneId:'walk',activityIds:[]}];
  const {updates,attempts}=runScheduler(jobs,job=>{
    if(job.key==='error')throw Error('failed');
    if(job.key==='hard')return {ok:false,status:'invalid_input',errors:['H_PREPARATION: missing']};
    if(job.key==='bounded')return {ok:false,status:'no_plan_found',errors:['H_PREPARATION: rejected branches']};
    return {ok:true,status:'feasible',q:80,prefixUtility:0,referenceUtility:80,...(job.key==='success'?{continuationWitness:witness}:{})};
  });
  assert.deepEqual(updates.map(update=>update.validationStatus),['verified','unresolved','hard_rejected','error','unresolved']);
  const verified=updates.find(update=>update.key==='success');
  assert.deepEqual(verified.continuationWitness,witness);assert.equal(verified.candidate.fitScore,75);
  for(const update of updates){assert.equal(update.actionKey,update.key);assert.equal(update.viewKey,'view');assert.equal(update.actionType,'activity');assert.equal(update.activityId,'talk');assert.equal(update.extraField,'preserved');}
  for(const update of updates.filter(update=>update.key!=='success')){
    assert.equal(update.continuationWitness,null);assert.equal(update.candidate.continuationWitness,null);
    assert.equal(update.candidate.fitScore,null);assert.equal(update.candidate.continuationFound,false);
  }
  assert.equal(attempts.filter(([key])=>key==='bounded').length,3);
  assert.equal(attempts.filter(([key])=>key==='hard').length,1);
});

test('真实搜索核验活动删除导致未来准备条件失败时不产出可点击结果', () => {
  const data={version:'action-test',transfers:{campus:{campus:0}},departures:[{id:'separate',minutes:0,cost:[0,0]}],scenes:[
    {id:'prepare',minutes:20,cost:[0,0],load:0,kind:'walk',area:'campus',indoor:true,quiet:true,fit:70,activities:[{id:'kit',cost:[0,0],load:0,provides:['kit']}]},
    {id:'booking',minutes:20,cost:[0,0],load:0,kind:'play',area:'campus',indoor:true,quiet:true,fit:70,requires:['kit'],activities:[]},
  ]};
  const state={context:{duration:100,reserve:0,robust:false,fatigueA:0,fatigueB:0,anchors:[{index:1,startMinute:40,choice:{sceneId:'booking',activityIds:[]}}]},prefix:[{sceneId:'prepare',activityIds:['kit']}],exploration:0};
  const result=planDate(state.context,data,{fixedPrefix:state.prefix,maxStages:2,maxCandidateExpandedNodes:0});
  assert.equal(result.ok,true,result.errors?.join(';'));
  const [job]=buildActionJobs(result,state,data,[{actionKey:'remove-kit',stageIndex:0,actionType:'activity',activityId:'kit',sceneId:'prepare',activityIds:[]}]);
  const iterator=createContinuationSearch(job.context,data,{...job.search,fixedPrefix:job.prefix,knownPlan:job.knownPlan,exploration:job.exploration});
  let checked;for(let count=0;count<10000;count++){const step=iterator.next();if(step.done){checked=step.value;break;}}
  assert.ok(checked);assert.equal(checked.ok,false);assert.equal(checked.continuationWitness,undefined);
});
