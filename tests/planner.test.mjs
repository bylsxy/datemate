import test from 'node:test';
import assert from 'node:assert/strict';
import {toggleActivity,validateReplay,defaultContext,escapeHTML,costLabel,formatTime} from '../planner.mjs';
test('单选活动可全部取消，互斥餐饮跨组保持一项',()=>{
 const scene={activities:[{id:'a',group:'drink',mode:'single'},{id:'b',group:'drink',mode:'single'},{id:'c',group:'style',mode:'multi',exclusiveKey:'meal'},{id:'d',group:'dish',mode:'multi',exclusiveKey:'meal'}]};
 assert.deepEqual(toggleActivity(scene,['a'],'b'),['b']);assert.deepEqual(toggleActivity(scene,['b'],'b'),[]);assert.deepEqual(toggleActivity(scene,['c'],'d'),['d']);assert.throws(()=>toggleActivity(scene,[],'unknown'));
});
test('零输入公开默认与未知偏好没有隐式持久状态',()=>{const a=defaultContext(),b=defaultContext();a.preferencesA.push('play');assert.deepEqual(b.preferencesA,[]);assert.equal(b.budget,null);assert.equal(b.weather,'unknown');assert.equal(b.windows[0].startMinute,840);});
test('复盘入口拒绝其他格式和超范围探索度',()=>{assert.throws(()=>validateReplay({}));assert.throws(()=>validateReplay({format:'datemate-ui-replay-3.0',state:{exploration:101,prefix:[]}}));});
test('知识摘要按文本转义，时间与双人区间统一展示',()=>{assert.equal(escapeHTML('<img src=x>'),'&lt;img src=x&gt;');assert.equal(formatTime(840),'14:00');assert.equal(costLabel([0,0]),'¥0');assert.equal(costLabel([20,50]),'¥20–50');});
