import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveMealCardChoice} from '../timeline.mjs';

test('会面前早餐和不吃宵夜没有地点对象，也能直接形成有效选择',()=>{
  assert.deepEqual(resolveMealCardChoice('breakfast','__breakfast_before_meeting'),{mode:'before_meeting'});
  assert.deepEqual(resolveMealCardChoice('supper','__supper_skip'),{mode:'skip'});
  assert.throws(()=>resolveMealCardChoice('lunch','__supper_skip'),/用餐地点/);
});
test('再点击当前餐馆保留已经勾选的玩法，换馆才取新的实际餐食',()=>{
  const scene={id:'glass',mealActivityIds:['breakfast','dinner'],activities:[{id:'breakfast',mealRoles:['breakfast']},{id:'dinner',mealRoles:['dinner']}]};
  const current={sceneId:'glass',activityIds:['breakfast','cards']};
  const selected=resolveMealCardChoice('breakfast','glass',{scene,current,candidate:{activityIds:['breakfast']}});
  assert.deepEqual(selected.activityIds,['breakfast','cards']);selected.activityIds.push('extra');assert.deepEqual(current.activityIds,['breakfast','cards']);
  assert.deepEqual(resolveMealCardChoice('dinner','glass',{scene,current:{sceneId:'elsewhere',activityIds:['other']}}),{sceneId:'glass',activityIds:['dinner']});
});
