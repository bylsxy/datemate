import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultContext,validateReplay} from '../planner.mjs';
import {filterScopedMealChoices} from '../scope-ui.mjs';

const replay=context=>({format:'datemate-ui-replay-4.1',state:{context,exploration:0,prefix:[]},outputFingerprint:'1234abcd'});

test('新加载不预选学校或宿舍区，学校选择支持复盘',()=>{
  const context=defaultContext();
  assert.equal(context.school,'');assert.equal(context.campusArea,'');
  for(const extra of [{},{school:'scau'},{school:'scau',campusArea:'taishan'}]){
    const input=replay({...context,...extra});assert.equal(validateReplay(input),input);
  }
});

test('复盘拒绝未知学校、未知宿舍区及脱离父条件的选择',()=>{
  for(const extra of [{school:'unknown'},{campusArea:'unknown'},{campusArea:'taishan'},{area:'all',school:'scau'},{area:'all',school:'scau',campusArea:'taishan'}]){
    assert.throws(()=>validateReplay(replay({...defaultContext(),...extra})),/学校与宿舍区/);
  }
});

test('旧复盘没有学校字段时仍通过格式检查，不推定华农身份',()=>{
  const context=defaultContext();delete context.school;delete context.campusArea;
  assert.equal(validateReplay(replay(context)).state.context.school,undefined);
});

test('取消学校或宿舍区解除专属固定餐馆，保留通用餐馆和特殊餐次选择',()=>{
  const scenes=[{id:'generic',area:'campus'},{id:'scau',area:'campus',place:{universityId:'scau',campusArea:'taishan'}}];
  const choices={breakfast:{sceneId:'scau',activityIds:['eat']},lunch:{sceneId:'generic',activityIds:['eat']},supper:{mode:'skip'}};
  const allowed=filterScopedMealChoices(choices,scenes,{area:'near',school:'scau',campusArea:'taishan'});
  assert.deepEqual(allowed,choices);allowed.breakfast.activityIds.push('other');assert.deepEqual(choices.breakfast.activityIds,['eat']);
  for(const scope of [{area:'near'},{area:'campus',school:'scau'},{area:'all',school:'scau',campusArea:'taishan'}]){
    assert.deepEqual(filterScopedMealChoices(choices,scenes,scope),{lunch:choices.lunch,supper:choices.supper});
  }
});
