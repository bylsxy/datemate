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
