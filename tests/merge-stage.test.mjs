import test from 'node:test';
import assert from 'node:assert/strict';
import {catalog} from '../data/catalog.mjs';
import {planDate,verifyPlanWitness} from '../engine.mjs';
import {mergeStageIntent,splitStageIntent,projectStageChoice,selectStageIntent,exploreIntent,restartIntent,updateContextIntent} from '../planning-intent.mjs';
import {mergeStayOption} from '../duration-policy.mjs';
import {buildActionJobs} from '../candidate-validation.mjs';

const night={periodIds:['night'],area:'campus',weather:'rain',budget:0};
// 可逆拆分在同地点验证；真实目录仍用于下方不同地点转场与费用语义。
const samePlaceCatalog={...catalog,scenes:catalog.scenes.filter(scene=>scene.id==='dorm_downstairs_shelter')};
const state=context=>({context,exploration:0,prefix:[]});
const checked=(context,options={},source=catalog)=>{const r=planDate(context,source,options);assert.equal(r.ok,true,r.errors.join(';'));return r;};
const details=stage=>({choice:projectStageChoice(stage),start:stage.start,end:stage.end});
function split(input,result,index,source=catalog){
  const next=splitStageIntent(input,result,index,source);
  const [job]=buildActionJobs(result,input,source,[{actionType:'split',stageIndex:index,sceneId:result.stages[index].sceneId}]);
  const verified=verifyPlanWitness(job.context,source,{...job.search,fixedPrefix:job.prefix,knownPlan:job.knownPlan});
  assert.equal(verified.ok,true,verified.errors.join(';'));
  return {input:next,result:checked(next.context,{fixedPrefix:next.prefix},source)};
}
function merge(input,result,index,source=catalog){
  const [job]=buildActionJobs(result,input,source,[{actionType:'merge',stageIndex:index,sceneId:result.stages[index].sceneId}]);
  const next=mergeStageIntent(input,result,index,source);
  assert.deepEqual(job.context,next.context);
  assert.deepEqual(job.prefix,next.prefix);
  const verified=verifyPlanWitness(job.context,source,{...job.search,fixedPrefix:job.prefix,knownPlan:job.knownPlan});
  assert.equal(verified.ok,true,verified.errors.join(';'));
  return {input:next,result:checked(next.context,{fixedPrefix:next.prefix,knownPlan:verified.continuationWitness},source)};
}

test('雨夜拆分后能合回原来一段，连续操作不遗留强制拆分条件',()=>{
  const original=checked(night,{},samePlaceCatalog);
  let current={input:state(night),result:original};
  for(let i=0;i<2;i++){
    current=split(current.input,current.result,0,samePlaceCatalog);
    assert.equal(current.result.stages.length,2);
    assert.deepEqual(current.input.splitStageIndexes,[1]);
    const before=structuredClone(current);
    current=merge(current.input,current.result,0,samePlaceCatalog);
    assert.equal(current.result.stages.length,1);
    assert.deepEqual(current.input.splitStageIndexes,[]);
    assert.deepEqual(details(current.result.stages[0]),details(original.stages[0]));
    assert.equal(current.result.totalCost[1],0);
    assert.equal(before.result.stages.length,2,'意图操作不能修改旧结果');
  }
});

test('不同地点合并保留前段选择，取消后段及转场并重新核算费用',()=>{
  const context={periodIds:['afternoon'],area:'any',weather:'unknown'};
  const current=split(state(context),checked(context),0),[first,second]=current.result.stages;
  assert.notEqual(first.sceneId,second.sceneId,'覆盖拆分后自动推荐了另一地点的情况');
  const changed=merge(current.input,current.result,0).result;
  assert.equal(changed.stages.length,1);
  assert.equal(changed.stages[0].sceneId,first.sceneId);
  assert.deepEqual(changed.stages[0].activityIds,first.activityIds);
  assert.equal(changed.stages[0].minutes,first.minutes+second.minutes);
  assert.equal(changed.metrics.transferMinutes,current.result.metrics.transferMinutes-second.transfer);
  assert.equal(changed.stages[0].end,second.end-second.transfer,'取消转场不自动补成额外停留');
  assert.ok(changed.totalCost[1]<=current.result.totalCost[1]);
});

test('拆成三段后可以逐次合并，剩余段数要求随之减少',()=>{
  const original=checked(night,{},samePlaceCatalog);
  let current=split(state(night),original,0,samePlaceCatalog);
  current=split(current.input,current.result,1,samePlaceCatalog);
  assert.equal(current.result.stages.length,3);
  assert.deepEqual(current.input.splitStageIndexes,[1,2]);
  current=merge(current.input,current.result,0,samePlaceCatalog);
  assert.equal(current.result.stages.length,2);
  assert.deepEqual(current.input.splitStageIndexes,[1]);
  current=merge(current.input,current.result,0,samePlaceCatalog);
  assert.equal(current.result.stages.length,1);
  assert.deepEqual(details(current.result.stages[0]),details(original.stages[0]));
});

test('拆分来源随选择保留，全部重选或改变硬条件后清除，不给普通阶段加合并入口',()=>{
  const current=split(state(night),checked(night),0);
  for(const index of [0,1]){
    const stage=current.result.stages[index];
    const next=selectStageIntent(current.input,current.result,index,stage.sceneId,stage.activityIds,catalog);
    assert.deepEqual(next.splitStageIndexes,[1]);
  }
  assert.deepEqual(exploreIntent(current.input,10,123).splitStageIndexes,[1]);
  assert.equal(restartIntent(current.input,123).splitStageIndexes,undefined);
  assert.deepEqual(updateContextIntent(current.input,{...current.input.context,weather:'clear'}).next.splitStageIndexes,[1]);
  assert.equal(updateContextIntent(current.input,{...current.input.context,budget:10}).next.splitStageIndexes,undefined);
  assert.equal(state(night).splitStageIndexes,undefined);
});

test('中间两段合并保留已确认早餐及前序时间，后面午餐仍然安排',()=>{
  const context={periodIds:['morning','afternoon'],area:'campus',weather:'rain',budget:50};
  const original=checked(context),index=original.stages.findIndex(stage=>!stage.mealRole);
  const current=split(state(context),original,index),before=structuredClone(current.input);
  const changed=merge(current.input,current.result,index);
  assert.deepEqual(current.input,before,'不能修改输入意图');
  assert.deepEqual(changed.result.stages.slice(0,index).map(details),current.result.stages.slice(0,index).map(details));
  assert.equal(changed.result.stages.filter(stage=>stage.mealRole==='breakfast').length,1);
  assert.equal(changed.result.stages.filter(stage=>stage.mealRole==='lunch').length,1);
  assert.ok(changed.result.totalCost[1]<=50);
});

test('合并不能吞掉餐次、分别卡或后一段的预约',()=>{
  const context={periodIds:['morning','afternoon'],area:'campus',weather:'rain',budget:50};
  const r=checked(context),index=r.stages.findIndex(stage=>stage.mealRole==='lunch')-1;
  assert.throws(()=>mergeStageIntent(state(context),r,index,catalog),/餐次或预约/);
  assert.throws(()=>mergeStageIntent(state(context),r,0,catalog),/餐次或预约/);
  const first=r.stages[index],scene=catalog.scenes.find(scene=>scene.id===first.sceneId);
  for(const flags of [{anchorId:'booked'},{fixedStartMinute:900},{departure:true},{virtualMeal:true}]){
    assert.equal(mergeStayOption(scene,first,{...first,...flags}),null);
  }
});

test('超出场景可调区间时不允许合并，不能改写原来的时长',()=>{
  const scene=catalog.scenes.find(scene=>scene.id==='mall');
  const r={ok:true,stages:[{sceneId:scene.id,activityIds:[],minutes:120},{sceneId:scene.id,activityIds:[],minutes:90}]};
  const input=state({periodIds:['afternoon']}),before=structuredClone(input);
  assert.match(mergeStayOption(scene,...r.stages).error,/210.*180/);
  assert.throws(()=>mergeStageIntent(input,r,0,catalog),/超出/);
  assert.deepEqual(input,before);
  assert.equal(mergeStayOption(scene,r.stages[0],undefined),null);
});

test('合并延长到闭馆之后时完整校验会拒绝，不会放宽开放时间',()=>{
  const context={periodIds:['evening'],area:'campus',weather:'rain',budget:0};
  const prefix=[{sceneId:'reading',activityIds:[],durationMinutes:60},{sceneId:'dorm_downstairs_shelter',activityIds:[],durationMinutes:120}];
  const r=checked(context,{fixedPrefix:prefix});
  const next=mergeStageIntent({...state(context),prefix},r,0,catalog);
  assert.equal(next.prefix[0].durationMinutes,180);
  const invalid=planDate(next.context,catalog,{fixedPrefix:next.prefix});
  assert.equal(invalid.ok,false);
  assert.ok(invalid.errors.some(error=>/开放|H_TIME/.test(error)),invalid.errors.join(';'));
});

test('合并不能借取消后段绕过必去地点',()=>{
  const context={periodIds:['afternoon'],area:'any',weather:'unknown'};
  const current=split(state(context),checked(context),0);
  const required=current.result.stages[1].sceneId;
  assert.notEqual(required,current.result.stages[0].sceneId);
  const input={...current.input,context:{...current.input.context,requiredSceneIds:[required]}};
  const next=mergeStageIntent(input,current.result,0,catalog);
  assert.deepEqual(next.context.requiredSceneIds,[required]);
  const invalid=verifyPlanWitness(next.context,catalog,{fixedPrefix:next.prefix,knownPlan:next.prefix});
  assert.equal(invalid.ok,false);
  assert.ok(invalid.errors.some(error=>error.startsWith('H_REQUIRED_SCENE:')));
});
