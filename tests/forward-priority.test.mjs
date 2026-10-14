import test from 'node:test';
import assert from 'node:assert/strict';
import {toggleActivity} from '../planner.mjs';
import {selectStageIntent,projectStageChoice} from '../planning-intent.mjs';
import {planDate} from '../engine.mjs';
import {buildActionJobs} from '../candidate-validation.mjs';

test('已选唯一吃饭活动保持选中，换吃法仍替换同组，普通可选活动仍能取消',()=>{
  const scene={mealActivityIds:['rice','noodles'],activities:[
    {id:'rice',group:'food',mode:'single'},{id:'noodles',group:'food',mode:'single'},{id:'chat',group:'extra'}]};
  assert.deepEqual(toggleActivity(scene,['rice'],'rice','lunch'),['rice']);
  assert.deepEqual(toggleActivity(scene,['rice'],'noodles','lunch'),['noodles']);
  assert.deepEqual(toggleActivity(scene,['rice','chat'],'chat','lunch'),['rice']);
  assert.deepEqual(toggleActivity(scene,['chat'],'chat'),[]);
});

test('早段新增消费可释放后段酒店预算；后段选择不能回改早段',()=>{
  const data={version:'forward-priority',scenes:['free','paid'].map(id=>({id,minutes:30,cost:id==='paid'?[20,20]:[0,0],load:0,kind:'walk',area:'campus',indoor:true,quiet:true,fit:70,activities:[]})),transfers:{campus:{campus:0}},departures:[{id:'separate',minutes:10,cost:[0,0]},{id:'hotel',minutes:10,cost:[30,30]}]};
  const state={prefix:[],exploration:0,context:{duration:70,budget:30,reserve:0,robust:false,fatigueA:0,fatigueB:0,departureChoice:'hotel',endAfterStage:1,minimumStageCount:2}};
  const original=planDate(state.context,data,{maxStages:2});assert.equal(original.ok,true);
  const next=selectStageIntent(state,original,0,'paid',[],data);
  assert.equal(next.context.departureChoice,'separate');assert.equal(next.context.endAfterStage,undefined);assert.equal(next.context.minimumStageCount,undefined);
  const changed=planDate(next.context,data,{fixedPrefix:next.prefix,maxStages:2,selectionMode:'utility_best'});
  assert.equal(changed.ok,true,changed.errors?.join(';'));assert.equal(changed.stages[0].sceneId,'paid');
  const later=selectStageIntent(next,changed,1,'free',[],data);
  assert.deepEqual(later.prefix[0],projectStageChoice(changed.stages[0]));
  const jobs=buildActionJobs({...original,replay:{search:{maxStages:1}}},state,data,[{actionKey:'paid',actionType:'scene',stageIndex:0,sceneId:'paid',activityIds:[]}]);
  assert.equal(jobs[0].search.maxStages,undefined);assert.equal(jobs[0].context.departureChoice,'separate');
});
