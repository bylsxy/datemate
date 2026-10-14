import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultContext,excludedKeywordIds} from '../planner.mjs';
import {exploreIntent,updateContextIntent} from '../planning-intent.mjs';

test('新一页默认阴天，个人状态不预填',()=>{
  const context=defaultContext();
  assert.equal(context.weather,'cloudy');assert.equal(context.personalityA,'');
  assert.equal(context.cyclePhase,'none');assert.equal(context.weekPart,'weekday');
});
test('不去关键词匹配地点与活动名称，不把无关说明当成地点',()=>{
  const catalog={scenes:[{id:'park',title:'公园',description:'去完KTV再逛',activities:[{id:'boat',title:'湖心划船'}]},{id:'ktv',title:'双人KTV',activities:[]}]};
  assert.deepEqual(excludedKeywordIds(catalog,'ktv，划船'),['ktv','boat']);
  assert.deepEqual(excludedKeywordIds(catalog,''),[]);
});
test('雨天和人少改变偏好但保留手选前缀，周末价格重排',()=>{
  const state={context:defaultContext(),exploration:0,prefix:[{sceneId:'park',activityIds:[]}]};
  const soft=updateContextIntent(state,{...state.context,weather:'rain',crowdAvoidance:true});
  assert.equal(soft.hardChanged,false);assert.deepEqual(soft.next.prefix,state.prefix);
  const price=updateContextIntent(state,{...state.context,weekPart:'weekend'});
  assert.equal(price.hardChanged,true);assert.deepEqual(price.next.prefix,[]);
});
test('退出梦幻模式只释放首个梦幻地点及后续，清理相关同意和餐次',()=>{
  const state={context:{...defaultContext(),endAfterStage:2,requiredSceneIds:['dream'],explicitConsentIds:['private'],mealChoices:{dinner:{sceneId:'dinner',activityIds:['eat']}}},exploration:100,prefix:[{sceneId:'park',activityIds:[]},{sceneId:'dream',activityIds:['private']},{sceneId:'dinner',activityIds:['eat'],mealRole:'dinner'}]};
  const next=exploreIntent(state,99,9,{scenes:[{id:'park'},{id:'dream',dreamOnly:true}]});
  assert.deepEqual(next.prefix,[state.prefix[0]]);assert.deepEqual(next.context.requiredSceneIds,[]);
  assert.deepEqual(next.context.explicitConsentIds,[]);assert.deepEqual(next.context.mealChoices,{});
  assert.equal(next.context.endAfterStage,undefined);assert.equal(state.prefix.length,3);
});
