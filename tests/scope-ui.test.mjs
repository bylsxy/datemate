import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeUIScope,isSceneInUIScope,createSchoolScopeControls,filterUIGraph,filterUIResult} from '../scope-ui.mjs';
import {createPlacePicker,searchPlaces,addPlace} from '../place-picker.mjs';

const scenes = [
  {id:'generic',title:'通用校园地点',area:'campus',activities:[{id:'shared'}]},
  {id:'scau',title:'华农地点',area:'campus',place:{universityId:'scau'},activities:[{id:'scau_activity'},{id:'shared'}]},
  {id:'taishan',title:'泰山区地点',area:'campus',place:{universityId:'scau',campusArea:'taishan'},activities:[{id:'taishan_activity'}]},
  {id:'city',title:'城市地点',area:'off',activities:[]},
];
const school = {area:'near',school:'scau',campusArea:''};
const taishan = {...school,campusArea:'taishan'};

test('所有入口共享学校、宿舍区与活动范围权限', () => {
  assert.deepEqual(searchPlaces(scenes,'',{area:'all'}).map(s=>s.id),['generic','city']);
  assert.deepEqual(searchPlaces(scenes,'',school).map(s=>s.id),['generic','scau']);
  assert.deepEqual(searchPlaces(scenes,'',taishan).map(s=>s.id),['generic','scau','taishan']);
  assert.deepEqual(searchPlaces(scenes,'华农',{area:'near'}),[]);
  assert.throws(()=>addPlace({},'requiredSceneIds','scau',scenes,{area:'near'}),/选择一个地点/);
  assert.equal(isSceneInUIScope(scenes[3],{area:'campus'}),false);
});

test('不限制或未选学校会清空隐藏后代，包括旧导入值', () => {
  assert.deepEqual(normalizeUIScope({...taishan,area:'all'}),{area:'all',school:'',campusArea:''});
  assert.deepEqual(normalizeUIScope({...taishan,school:''}),{area:'near',school:'',campusArea:''});
  assert.deepEqual(normalizeUIScope({area:'nearby',school:'scau'}),school);
});

function element() {
  const handlers=new Map();
  return {checked:false,hidden:false,value:'',innerHTML:'',textContent:'',disabled:false,
    addEventListener(name,handler){handlers.set(name,handler);},
    emit(name,event={}){handlers.get(name)?.(event);},
    dispatchEvent(event){this.emit(event.type,event);},
  };
}
function controlsFixture() {
  const ids=new Map(['school-scau','campus-area-taishan','school-scope','school-scope-hint','campus-area-scope','campus-area-scope-hint'].map(id=>[`#${id}`,element()]));
  const areas=['all','near','campus'].map(value=>({...element(),value})),root=element();
  root.querySelector=selector=>selector==='input[name="area"]:checked'?areas.find(input=>input.checked):ids.get(selector);
  root.querySelectorAll=()=>areas;
  return {root,areas,el:id=>ids.get(`#${id}`),controls:createSchoolScopeControls(root)};
}

test('表单首次未选学校和宿舍区；父项变化同步清空，不会在展开后复活', () => {
  const f=controlsFixture();f.controls.set({area:'near'});
  assert.equal(f.el('school-scope').hidden,false);
  assert.equal(f.el('school-scau').checked,false);
  assert.equal(f.el('campus-area-scope').hidden,true);
  f.controls.set(taishan);
  assert.equal(f.el('school-scope-hint').hidden,false);
  assert.equal(f.el('campus-area-scope-hint').hidden,false);
  f.el('school-scau').checked=false;f.controls.read();
  assert.equal(f.el('campus-area-taishan').checked,false);
  f.el('school-scau').checked=true;f.controls.read();
  assert.equal(f.el('campus-area-scope').hidden,false);
  assert.equal(f.el('campus-area-taishan').checked,false);
  f.controls.set({...taishan,area:'all'});
  assert.equal(f.el('school-scope').hidden,true);
  assert.equal(f.el('school-scau').checked,false);
  assert.equal(f.el('campus-area-taishan').checked,false);
});

test('泰山区 radio 再次点击标签或空格激活可恢复未选', async () => {
  const f=controlsFixture(),dorm=f.el('campus-area-taishan');f.controls.set(taishan);
  let prevented=0,changes=0;dorm.addEventListener('change',()=>changes++);
  f.root.emit('pointerdown',{target:{closest:()=>({contains:input=>input===dorm})}});
  dorm.emit('click',{preventDefault:()=>prevented++});await Promise.resolve();
  assert.equal(dorm.checked,false);assert.equal(prevented,1);assert.equal(changes,1);
  dorm.checked=true;dorm.emit('keydown',{key:' '});
  dorm.emit('click',{preventDefault:()=>prevented++});await Promise.resolve();
  assert.equal(dorm.checked,false);assert.equal(changes,2);
});

test('地点同步与父范围切换清理隐藏必去、不去以及旧 anchors', () => {
  const elements=new Map(['place-search','place-select','place-choice-error','add-exclude','add-anchor','excluded-places','anchored-places'].map(id=>[`#${id}`,element()]));
  const root={querySelector:id=>elements.get(id),addEventListener(){}};
  const picker=createPlacePicker({root,scenes,onChange(){throw Error('同步不应触发规划');}});
  picker.setChoices({...taishan,bans:['scau'],anchors:[{sceneOnly:true,choice:{sceneId:'taishan'}}]});
  assert.deepEqual(picker.getChoices(),{bans:['scau'],requiredSceneIds:['taishan']});
  picker.setScope({area:'near'});
  assert.deepEqual(picker.getChoices(),{bans:[],requiredSceneIds:[]});
  assert.doesNotMatch(elements.get('#place-select').innerHTML,/华农地点|泰山区地点/);
  picker.setChoices({...school,bans:['generic'],requiredSceneIds:['taishan']});
  assert.deepEqual(picker.getChoices(),{bans:['generic'],requiredSceneIds:[]});
});

test('知识图谱去除范围外场景、专属活动和关联边，保留通用活动', () => {
  const graph={nodes:['generic','scau','taishan','city','shared','scau_activity','taishan_activity'].map(id=>({id})),edges:[
    {subject:'scau',object:'scau_activity'}, {subject:'generic',object:'shared'}, {subject:'taishan',object:'taishan_activity'},
  ]};
  const filtered=filterUIGraph(graph,scenes,{area:'near'});
  assert.deepEqual(filtered.nodes.map(n=>n.id),['generic','shared']);
  assert.deepEqual(filtered.edges,[{subject:'generic',object:'shared'}]);
});

test('推荐与用餐候选、对比备选过滤不修改引擎原始结果', () => {
  const result={stages:[{sceneId:'generic',candidates:[{sceneId:'scau'},{sceneId:'generic'}]}],mealRequirements:[{candidates:[{sceneId:'taishan'}]}],paretoPlans:[{stages:[{sceneId:'scau'}]}]};
  const filtered=filterUIResult(result,scenes,{area:'near'});
  assert.deepEqual(filtered.stages[0].candidates,[{sceneId:'generic'}]);
  assert.deepEqual(filtered.mealRequirements[0].candidates,[]);
  assert.deepEqual(filtered.paretoPlans,[]);
  assert.equal(result.stages[0].candidates.length,2);
});
