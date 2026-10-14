import test from 'node:test';
import {CAMPING_EXPLORATION_MIN,isSceneAllowedAtExploration} from '../exploration.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {isSceneInSchoolScope} from '../school-scope.mjs';
import {sceneDurationAt,isSceneOpenDuring} from '../scene-time.mjs';
import {isSceneInUIScope,filterUIGraph} from '../scope-ui.mjs';
import {searchPlaces,addPlace,createPlacePicker} from '../place-picker.mjs';

const night={area:'near',periodIds:['night']};
const place=(id,dailyWindows,extra={})=>({id,title:id,kind:'ordinary',area:'near',minutes:30,activities:[{id:`${id}-only`},{id:'shared'}],dailyWindows,...extra});
const closed=place('day-only',[{startMinute:540,endMinute:1020}]);
const open=place('night-open',[{startMinute:1380,endMinute:120}]);

test('夜间搜索和必去添加排除白天关闭地点，学校条件仍同时生效',()=>{
  const school=place('school-only',open.dailyWindows,{place:{universityId:'scau'}});
  assert.deepEqual(searchPlaces([closed,open,school],'',night).map(s=>s.id),['night-open']);
  assert.throws(()=>addPlace({},'requiredSceneIds',closed.id,[closed,open],night),/选择一个地点/);
  assert.deepEqual(addPlace({},'requiredSceneIds',open.id,[closed,open],night).requiredSceneIds,[open.id]);
  assert.equal(isSceneInUIScope(school,{...night,school:'scau'}),true);
});

test('夜间普通场景必须有连续60分钟，跨午夜连续窗口允许停留',()=>{
  const short=place('short',[{startMinute:1380,endMinute:1439}]);
  const exact=place('exact',[{startMinute:1380,endMinute:1440}]);
  const split=place('split',[{startMinute:1380,endMinute:1410},{startMinute:1440-1,endMinute:30}]);
  assert.equal(isSceneInUIScope(short,night),false);
  assert.equal(isSceneInUIScope(exact,night),true);
  assert.equal(isSceneInUIScope(split,night),false);
  assert.equal(isSceneInUIScope(open,night),true);
});

test('无periodIds的旧相对时间fixture保留原有学校范围语义',()=>{
  assert.equal(isSceneInUIScope(closed,{area:'near',windows:[{startMinute:0,endMinute:100}]}),true);
  assert.deepEqual(searchPlaces([closed,open],'',{area:'near'}).map(s=>s.id),[closed.id,open.id]);
});

test('夜间图谱移除关闭场景及专属活动和边，保留共享活动且不修改输入',()=>{
  const graph={nodes:[closed.id,open.id,'day-only-only','night-open-only','shared','feature'].map(id=>({id})),edges:[
    {subject:closed.id,object:'day-only-only'},{subject:closed.id,object:'shared'},
    {subject:open.id,object:'shared'},{subject:open.id,object:'night-open-only'},
  ]};
  const original=structuredClone(graph),filtered=filterUIGraph(graph,[closed,open],night);
  assert.deepEqual(filtered.nodes.map(n=>n.id),[open.id,'night-open-only','shared','feature']);
  assert.deepEqual(filtered.edges,graph.edges.slice(2));
  assert.deepEqual(graph,original);
});

function element(){return {value:'',innerHTML:'',textContent:'',disabled:false,addEventListener(){}};}
test('时段切换保留显式必去以报告冲突，关闭地点从新增下拉移除',()=>{
  const elements=new Map(['place-search','place-select','place-choice-error','add-exclude','add-anchor','excluded-places','anchored-places'].map(id=>[`#${id}`,element()]));
  const picker=createPlacePicker({root:{querySelector:id=>elements.get(id),addEventListener(){}},scenes:[closed,open],onChange(){assert.fail('同步筛选不应提交规划');}});
  picker.setChoices({area:'near',periodIds:['morning'],requiredSceneIds:[closed.id]});
  assert.deepEqual(picker.getChoices().requiredSceneIds,[closed.id]);
  picker.setScope(night);
  assert.deepEqual(picker.getChoices().requiredSceneIds,[closed.id]);
  assert.doesNotMatch(elements.get('#place-select').innerHTML,/day-only/);
  picker.setChoices({...night,anchors:[{sceneOnly:true,choice:{sceneId:closed.id}}]});
  assert.deepEqual(picker.getChoices().requiredSceneIds,[closed.id]);
});

test('宵夜餐馆以30分钟连续开放窗筛选，29分钟排除',()=>{
  const supper={...night,periodIds:['evening','night']};
  const meal=(id,endMinute)=>place(id,[{startMinute:1380,endMinute}],{kind:'meal',minutes:10,mealRoles:['supper']});
  assert.equal(isSceneInUIScope(meal('short-supper',1409),supper),false);
  assert.equal(isSceneInUIScope(meal('exact-supper',1410),supper),true);
});

// 执行真实 timeline；仅复用无浏览器 DOM 和轮播替身，营业时间 API 使用真实实现。
async function timelineFixture(scenes){
  const fixtureSource=await readFile(new URL('./timeline-order.test.mjs',import.meta.url),'utf8');
  const fixture=new Function('isSceneInSchoolScope',`${fixtureSource.slice(fixtureSource.indexOf('class Element'),fixtureSource.indexOf('const candidate='))};return fixture;`)(isSceneInSchoolScope);
  const f=fixture(),previousDocument=globalThis.document;
  f.catalog.scenes=scenes;
  const key=Symbol.for('datemate.night.ui.test');
  globalThis.document=f.doc;globalThis[key]={...f.deps,isSceneAllowedAtExploration,sceneDurationAt,isSceneOpenDuring};
  const source=(await readFile(new URL('../timeline.mjs',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
  const {createTimeline}=await import(`data:text/javascript;base64,${Buffer.from(`const CAMPING_EXPLORATION_MIN=${CAMPING_EXPLORATION_MIN}; const {isSceneAllowedAtExploration,attachCarousel,centerCard,syncCarousel,esc,formatTime,toggleActivity,isSceneInSchoolScope,sceneDurationAt,isSceneOpenDuring}=globalThis[Symbol.for('datemate.night.ui.test')];\n${source}`).toString('base64')}`);
  const timeline=createTimeline({...f,onScene(){},onActivities(){},onMeal(){}});
  return {...f,timeline,cleanup(){timeline.dispose();globalThis.document=previousDocument;delete globalThis[key];}};
}
const cardIds=f=>f.root.children[0].querySelector('.scene-strip').children.map(card=>card.dataset.scene);
const planAt=(start,candidates)=>({ok:true,stages:[{sceneId:'night-open',activityIds:[],startMinute:start,endMinute:start+60,candidates:candidates.map(scene=>({sceneId:scene.id,activityIds:[],scoreStatus:'pending'}))}]});

test('00:40图书馆从真实timeline DOM完全移除，冻结旧候选也不能复活',async()=>{
  const library=place('library',[{startMinute:480,endMinute:1320}]);
  const f=await timelineFixture([library,open]);try{
    f.setIntent({prefix:[],context:{area:'near'}});
    f.timeline.render(planAt(600,[library,open]));
    assert.ok(cardIds(f).includes('library'));
    f.setIntent({prefix:[],context:night});
    f.timeline.render(planAt(1480,[open]),{preserveThrough:0});
    assert.deepEqual(cardIds(f),[open.id]);
    assert.equal(f.timeline.getPendingActions().some(action=>action.sceneId==='library'),false);
  }finally{f.cleanup();}
});

test('19:00普通30分钟candidate需容纳60分钟，短开放窗卡完全移除',async()=>{
  const short=place('short-evening',[{startMinute:1140,endMinute:1199}]);
  const exact=place('exact-evening',[{startMinute:1140,endMinute:1200}]);
  const f=await timelineFixture([short,exact,open]);try{
    f.setIntent({prefix:[],context:{area:'near',periodIds:['evening']}});
    const plan=planAt(1140,[short,exact]);plan.stages[0].sceneId=exact.id;
    f.timeline.render(plan);
    assert.deepEqual(cardIds(f),[exact.id]);
  }finally{f.cleanup();}
});
