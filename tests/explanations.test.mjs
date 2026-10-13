import test from 'node:test';
import assert from 'node:assert/strict';
import {explainStage} from '../explanations.mjs';
test('首页理由只解释真正勾选的共同兴趣，不推断未填兴趣',()=>{
  const p={kind:'ordinary',tags:['indoor'],indoor:true,activities:[{id:'game',title:'双人游戏',tags:['play'],requires:[]}]};
  const a=explainStage({index:0,activityIds:['game']},p,{preferencesA:['play'],preferencesB:['play'],weather:'rain'});
  assert.ok(a.some(x=>x.includes('游戏')));assert.ok(a.some(x=>x.includes('下雨')));
  const b=explainStage({index:0,activityIds:[]},p,{});assert.ok(!b.some(x=>x.includes('共同喜欢')));
  assert.ok(!a.join('').match(/模型|效用|图谱|负担|预算|价格|¥/));
});
test('饭点与实际疲惫推理用因果过程解释，保留用户可读的判断步骤',()=>{
  const meal={kind:'meal',tags:['food'],activities:[{id:'eat',title:'简餐',tags:['food'],requires:[],provides:['meal_completed']}]};
  const reason=explainStage({index:3,mealRole:'dinner',activityIds:['eat']},meal,{periodIds:['afternoon','evening']}).join('');
  assert.match(reason,/下午和晚上/);assert.match(reason,/晚饭时间/);assert.match(reason,/两边的活动接起来/);assert.match(reason,/简餐/);
  const rest={kind:'rest',tags:[],activities:[]};
  const recovery=explainStage({index:2,activityIds:[],trace:[{ruleId:'R-fatigue-derive'}]},rest,{}).join('');
  assert.match(recovery,/疲惫状态/);assert.match(recovery,/所以先休息再继续/);assert.ok(!recovery.includes('R-fatigue'));
});
