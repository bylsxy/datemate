import test from 'node:test';
import assert from 'node:assert/strict';
import {toggleActivity,validateReplay,defaultContext,escapeHTML,costLabel,formatTime} from '../planner.mjs';
test('单选活动可全部取消，互斥餐饮跨组保持一项',()=>{
 const scene={activities:[{id:'a',group:'drink',mode:'single'},{id:'b',group:'drink',mode:'single'},{id:'c',group:'style',mode:'multi',exclusiveKey:'meal'},{id:'d',group:'dish',mode:'multi',exclusiveKey:'meal'}]};
 assert.deepEqual(toggleActivity(scene,['a'],'b'),['b']);assert.deepEqual(toggleActivity(scene,['b'],'b'),[]);assert.deepEqual(toggleActivity(scene,['c'],'d'),['d']);assert.throws(()=>toggleActivity(scene,[],'unknown'));
});
test('零输入默认下午四小时，偏好与用餐选择没有隐式持久状态',()=>{const a=defaultContext(),b=defaultContext();a.preferencesA.push('play');a.mealChoices.supper={mode:'skip'};assert.deepEqual(b.preferencesA,[]);assert.deepEqual(b.mealChoices,{});assert.deepEqual(b.periodIds,['afternoon']);assert.equal(b.duration,240);assert.equal(b.budget,null);assert.equal(b.weather,'cloudy');assert.deepEqual(b.windows,[{id:'period-span',startMinute:840,endMinute:1080}]);});
test('复盘入口拒绝其他格式和超范围探索度',()=>{assert.throws(()=>validateReplay({}));assert.throws(()=>validateReplay({format:'datemate-ui-replay-3.0',state:{exploration:101,prefix:[]}}));});
test('知识摘要按文本转义，时间与双人区间统一展示',()=>{assert.equal(escapeHTML('<img src=x>'),'&lt;img src=x&gt;');assert.equal(formatTime(840),'14:00');assert.equal(costLabel([0,0]),'¥0');assert.equal(costLabel([20,50]),'¥20–50');});
test('跨午夜显示次日时钟而非25点，复盘拒绝非连续时段',()=>{assert.equal(formatTime(1380),'23:00');assert.equal(formatTime(1440),'次日00:00');assert.equal(formatTime(1560),'次日02:00');const value={format:'datemate-ui-replay-4.1',state:{context:defaultContext(),exploration:0,prefix:[]},outputFingerprint:'12345678'};assert.equal(validateReplay(value),value);value.state.context.periodIds=['morning','evening'];assert.throws(()=>validateReplay(value),/只能整段规划/);});
