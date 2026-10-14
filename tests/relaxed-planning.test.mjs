import test from 'node:test';
import assert from 'node:assert/strict';
import {catalog} from '../data/catalog.mjs';
import {planDate,verifyPlanWitness} from '../engine.mjs';
import {projectStageChoice,setStageDurationIntent,splitStageIntent,selectStageIntent,selectMealIntent} from '../planning-intent.mjs';
import {mealOptions} from '../meal-options.mjs';
import {buildActionJobs} from '../candidate-validation.mjs';

const night={periodIds:['night'],area:'campus',weather:'rain',budget:0};
const state=context=>({context,exploration:0,prefix:[]});
const checked=(context,options={})=>{const r=planDate(context,catalog,options);assert.equal(r.ok,true,r.errors.join(';'));return r;};
const selected=stage=>({sceneId:stage.sceneId,activityIds:stage.activityIds,start:stage.start,end:stage.end});

test('默认雨夜保留少量长停留，不靠反复休息填时间',()=>{
  const r=checked(night);
  assert.ok(r.stages.length<=3);
  assert.ok(r.stages.some(stage=>stage.minutes>=60));
  assert.ok(r.stages.filter(stage=>stage.sceneId==='rest').length<=1);
  assert.ok(r.metrics.transferMinutes<=30);
});

test('手调最后一段时长按个人选择结束，不再自动追加地点填满时间',()=>{
  const original=checked(night),index=original.stages.length-1,next=setStageDurationIntent(state(night),original,index,60,catalog);
  const changed=checked(next.context,{fixedPrefix:next.prefix});
  assert.equal(changed.stages.length,original.stages.length);
  assert.deepEqual(changed.stages.slice(0,index).map(selected),original.stages.slice(0,index).map(selected));
  assert.equal(changed.stages[index].minutes,60);
  const invalid=verifyPlanWitness(next.context,catalog,{fixedPrefix:next.prefix,knownPlan:original.continuationWitness});
  assert.equal(invalid.ok,false);
  assert.ok(invalid.errors.some(e=>e.startsWith('H_KNOWN_PREFIX:')));
});

test('主动拆分产生第二个可选阶段；之后换场景也不能更改第一段',()=>{
  const original=checked(night),next=splitStageIntent(state(night),original,0,catalog);
  const split=checked(next.context,{fixedPrefix:next.prefix});
  assert.ok(split.stages.length>=2);
  assert.equal(split.stages[0].minutes,next.prefix[0].durationMinutes);
  assert.equal(split.stages[0].sceneId,original.stages[0].sceneId);
  const selectedTail=selectStageIntent(next,split,1,split.stages[1].sceneId,[],catalog);
  const result=checked(selectedTail.context,{fixedPrefix:selectedTail.prefix});
  assert.deepEqual(selected(result.stages[0]),selected(split.stages[0]));
});

test('后序选择保留已确认前序的地点、活动和可变时长',()=>{
  const context={periodIds:['morning','afternoon'],area:'campus',weather:'rain',budget:50};
  const original=checked(context),index=original.stages.length-1;
  const next=selectStageIntent(state(context),original,index,original.stages[index].sceneId,original.stages[index].activityIds,catalog);
  const result=checked(next.context,{fixedPrefix:next.prefix});
  assert.deepEqual(result.stages.slice(0,index).map(selected),original.stages.slice(0,index).map(selected));
  assert.ok(next.prefix.every(choice=>Number.isInteger(choice.durationMinutes)));
});

test('早餐具体选项尊重范围；自备早餐不能自动冒充免费餐',()=>{
  const context={periodIds:['morning'],area:'near',weather:'rain',budget:0};
  const options=mealOptions(catalog,context,'breakfast',null);
  for(const id of ['breakfast_shop','breakfast_mcdonalds','campus_canteen','breakfast_supermarket','breakfast_prepared'])assert.ok(options.some(o=>o.sceneId===id),id);
  assert.ok(!mealOptions(catalog,{...context,area:'campus'},'breakfast',null).some(o=>o.sceneId==='breakfast_mcdonalds'));
  assert.equal(planDate(context,catalog).ok,false);
  const before={...context,mealChoices:{breakfast:{mode:'before_meeting'}}};
  const current=checked(before),choice=options.find(o=>o.sceneId==='breakfast_prepared');
  const next=selectMealIntent(state(before),current,'breakfast',{sceneId:choice.sceneId,activityIds:choice.activityIds},0,catalog);
  const together=checked(next.context,{fixedPrefix:next.prefix});
  assert.equal(together.stages[0].sceneId,'breakfast_prepared');
  assert.equal(together.totalCost[1],0);
});

test('时长和拆分动作使用同一意图投影及完整后续验证',()=>{
  const r=checked(night),s=state(night);
  const jobs=buildActionJobs(r,s,catalog,[{actionType:'duration',stageIndex:0,sceneId:r.stages[0].sceneId,durationMinutes:60},{actionType:'split',stageIndex:0,sceneId:r.stages[0].sceneId}]);
  assert.equal(jobs.length,2);
  for(const job of jobs){
    const result=checked(job.context,{fixedPrefix:job.prefix,knownPlan:job.knownPlan});
    assert.equal(result.stages[0].minutes,job.prefix[0].durationMinutes);
    assert.deepEqual(projectStageChoice(result.stages[0]),job.prefix[0]);
  }
});

test('当前选择会挤掉后面必需的餐费时直接硬拒绝，避免显示不能兑现的选项',()=>{
  const context={periodIds:['morning','afternoon','evening'],area:'near',weather:'rain',budget:50};
  const choice={sceneId:'breakfast_mcdonalds',activityIds:['breakfast_mcdonalds_eat'],mealRole:'breakfast'};
  const result=planDate(context,catalog,{fixedPrefix:[choice]});
  assert.equal(result.ok,false);
  assert.equal(result.status,'invalid_input');
  assert.ok(result.errors.some(e=>e.startsWith('H_BUDGET:')));
});
