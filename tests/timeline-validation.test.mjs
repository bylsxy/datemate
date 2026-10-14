import test from 'node:test';
import {CAMPING_EXPLORATION_MIN,isSceneAllowedAtExploration} from '../exploration.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {isSceneInSchoolScope} from '../school-scope.mjs';

// 复用只读 DOM fixture，直接执行 timeline 源码，避免引入浏览器或构建依赖。
let fixtureRound=0;
async function setup(options={}){
  const {prepareFixture,...callbacks}=options;
  const fixtureSource=await readFile(new URL('./timeline-order.test.mjs',import.meta.url),'utf8');
  const fixture=new Function('isSceneInSchoolScope',`${fixtureSource.slice(fixtureSource.indexOf('class Element'),fixtureSource.indexOf('const candidate='))};return fixture;`)(isSceneInSchoolScope);
  const f=fixture(),oldDocument=globalThis.document;
  prepareFixture?.(f);
  globalThis.document=f.doc;
  const key=Symbol.for('datemate.timeline.validation.test');globalThis[key]={...f.deps,isSceneAllowedAtExploration};
  const source=(await readFile(new URL('../timeline.mjs',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
  const {createTimeline}=await import(`data:text/javascript;base64,${Buffer.from(`const CAMPING_EXPLORATION_MIN=${CAMPING_EXPLORATION_MIN}; const {isSceneAllowedAtExploration,attachCarousel,centerCard,syncCarousel,esc,formatTime,toggleActivity,isSceneInSchoolScope}=globalThis[Symbol.for('datemate.timeline.validation.test')];\n${source}`).toString('base64')}#${++fixtureRound}`);
  const calls=[];
  const timeline=createTimeline({...f,onScene:(...args)=>calls.push(['scene',...args]),onActivities:(...args)=>calls.push(['activity',...args]),onMeal:(...args)=>calls.push(['meal',...args]),...callbacks});
  const plan={ok:true,stages:[{sceneId:'a',activityIds:['a-act'],startMinute:600,endMinute:660,candidates:['a','b'].map(id=>({sceneId:id,activityIds:[`${id}-act`],fitScore:73,q:73,scoreStatus:'evaluated',continuationWitness:{id}}))}]};
  function emit(type,target,key){
    let stopped=false;const event={type,target,key,preventDefault(){this.defaultPrevented=true;},stopImmediatePropagation(){stopped=true;}};
    for(const fn of f.root.listeners[type]||[]){fn(event);if(stopped)break;}return event;
  }
  timeline.render(plan);
  return {...f,timeline,plan,calls,emit,cleanup(){timeline.dispose();globalThis.document=oldDocument;delete globalThis[key];}};
}

const rect=(left,top,width=100,height=100)=>({left,top,right:left+width,bottom:top+height,width,height});
function visibilityFixture(f){
  const listeners=new Map(),observers=[];
  Object.assign(f.doc.defaultView,{
    addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},
    removeEventListener(type,fn){listeners.get(type)?.delete(fn);},
    IntersectionObserver:class{
      constructor(callback){this.callback=callback;this.targets=[];observers.push(this);}
      observe(target){this.targets.push(target);}
      disconnect(){this.targets=[];}
    }
  });
  f.scrollWindow=()=>{for(const fn of listeners.get('scroll')||[])fn();};
  f.intersect=target=>{for(const observer of observers)if(observer.targets.includes(target))observer.callback([{target,isIntersecting:true,intersectionRect:{width:10,height:10}}]);};
}

test('每个 viewKey 的 scene/departure 标明当前 selected，activity 保留 toggle 前语义',async()=>{
  const f=await setup();try{
    f.catalog.departures=[{id:'bye',title:'分别'},{id:'bye2',title:'另一分别'}];
    const next={...f.plan,stages:[f.plan.stages[0],{...f.plan.stages[0],sceneId:'b',activityIds:[],startMinute:660,endMinute:720,mealRole:'breakfast'}],departure:{id:'bye2',startMinute:720,endMinute:730,candidates:[{id:'bye'},{id:'bye2'}]}};
    f.timeline.render(next);
    const actions=f.timeline.getPendingActions(),primary=actions.filter(a=>['scene','departure'].includes(a.actionType));
    assert.deepEqual(primary.filter(a=>a.selected).map(a=>[a.viewKey,a.stageIndex,a.sceneId]),[['stage-0',0,'a'],['meal-breakfast',1,'b'],['departure',2,'bye2']]);
    for(const viewKey of new Set(primary.map(a=>a.viewKey))){
      const group=primary.filter(a=>a.viewKey===viewKey);
      assert.equal(group.filter(a=>a.selected===true).length,1);
      assert.ok(group.filter(a=>!a.selected).every(a=>a.selected===false));
    }
    const selectedActivity=actions.find(a=>a.actionType==='activity'&&a.viewKey==='stage-0');
    assert.equal(selectedActivity.selected,true);assert.deepEqual(selectedActivity.activityIds,[],'已勾选活动的验证目标仍为取消后的组合');
    const unselectedActivity=actions.find(a=>a.actionType==='activity'&&a.viewKey==='meal-breakfast');
    assert.equal(unselectedActivity.selected,false);assert.deepEqual(unselectedActivity.activityIds,['b-act']);
    primary[0].selected=false;
    assert.equal(f.timeline.getPendingActions().find(a=>a.actionKey===primary[0].actionKey).selected,true,'导出元数据不能修改内部选择');
    f.timeline.render({...next,stages:[{...next.stages[0],sceneId:'c',activityIds:['c-act']},next.stages[1]],departure:{...next.departure,id:'bye'}},{preserveThrough:2,preserveKey:'departure'});
    assert.deepEqual(f.timeline.getPendingActions().filter(a=>['scene','departure'].includes(a.actionType)&&a.selected).map(a=>[a.viewKey,a.sceneId]),[['stage-0','c'],['meal-breakfast','b'],['departure','bye']],'保留 DOM 时 selected 仍跟随最新方案');
  }finally{f.cleanup();}
});

test('底部分别卡按 actual visual viewport 提优，IO 和滚动扫描均跳过屏幕外及隐藏动作',async()=>{
  const visible=[],f=await setup({prepareFixture:visibilityFixture,onCandidateVisible:action=>visible.push(action)});try{
    f.doc.defaultView.visualViewport={offsetLeft:50,offsetTop:80,width:300,height:250,addEventListener(){},removeEventListener(){}};
    f.catalog.departures=[{id:'bye',title:'分别'},{id:'bye2',title:'另一分别'}];
    f.timeline.render({...f.plan,departure:{id:'bye',startMinute:660,endMinute:670,candidates:[{id:'bye'},{id:'bye2'}]}});
    const ordinary=f.root.children[0],departure=f.root.children.at(-1),strip=departure.querySelector('.scene-strip'),[selected,hidden]=strip.children;
    ordinary.querySelector('.scene-strip').getBoundingClientRect=()=>rect(0,0,500,70);
    ordinary.querySelector('input[data-activity]').getBoundingClientRect=()=>rect(50,500);
    let stripRect=rect(0,500,500,100),cardRect=rect(70,510);
    strip.getBoundingClientRect=()=>stripRect;selected.getBoundingClientRect=()=>cardRect;
    hidden.getBoundingClientRect=()=>rect(180,300);
    f.flush();assert.deepEqual(visible,[],'分别在屏幕下方时不能提前提优');
    f.intersect(selected);assert.deepEqual(visible,[],'IO 可见标记仍须通过实际 viewport 检查');
    stripRect=rect(0,300,500,100);cardRect=rect(350,310);
    f.scrollWindow();f.flush();assert.deepEqual(visible,[],'只接触 viewport 右边界不算可见');
    cardRect=rect(70,310);
    f.scrollWindow();f.flush();
    assert.deepEqual(visible.map(a=>[a.viewKey,a.actionType,a.departureId,a.selected]),[['departure','departure','bye',true]]);
    assert.equal(hidden.hidden,true,'未验证分别动作继续隐藏');
    assert.equal(hidden.classList.contains('is-unselectable'),true);
    f.intersect(selected);f.scrollWindow();f.flush();assert.equal(visible.length,1,'普通事件每轮去重');
    departure.hidden=true;f.timeline.refreshVisibleCandidates();f.flush();assert.equal(visible.length,1);
    departure.hidden=false;cardRect=rect(70,80,100,20);stripRect=rect(0,70,500,50);
    f.intersect(selected);assert.equal(visible.length,2,'IO 路径支持上边界内的实际交集');
    assert.equal(f.timeline.updateActionValidation({...visible[0],validationStatus:'verified',continuationWitness:{bye:true}}),true);
    f.timeline.refreshVisibleCandidates();f.flush();assert.equal(visible.length,2,'已验证动作不再提优');
  }finally{f.cleanup();}
});

test('动作注册后可见消息带新 actionKey，Worker 就绪后 refresh 重发 pending 且排除隐藏页面',async()=>{
  let workerJobs=null;
  const early=[],accepted=[],f=await setup({onCandidateVisible:action=>{
    (workerJobs?accepted:early).push(action);
    if(workerJobs)assert.ok(workerJobs.has(action.actionKey),'Worker 必须收到当前注册动作的优先 key');
  }});try{
    f.flush();assert.ok(early.length>0);assert.ok(early.every(a=>a.actionKey&&a.viewKey));
    workerJobs=new Map(f.timeline.getPendingActions().map(a=>[a.actionKey,a]));
    f.timeline.refreshVisibleCandidates();f.flush();
    assert.deepEqual(accepted.map(a=>a.actionKey),early.map(a=>a.actionKey),'初始化前被丢弃的可见 key 能在初始化后重发');
    const count=accepted.length;
    f.timeline.refreshVisibleCandidates();f.doc.hidden=true;f.flush();assert.equal(accepted.length,count);
    f.doc.hidden=false;f.root.hidden=true;f.timeline.refreshVisibleCandidates();f.flush();assert.equal(accepted.length,count);
    f.root.hidden=false;f.timeline.refreshVisibleCandidates();f.flush();assert.equal(accepted.length,count*2);
    f.timeline.pending({fromStage:0,preserveThrough:0});f.timeline.refreshVisibleCandidates();f.flush();assert.equal(accepted.length,count*2,'重算时不重发旧轮动作');
    f.timeline.render(f.plan);
    workerJobs=new Map(f.timeline.getPendingActions().map(a=>[a.actionKey,a]));
    f.flush();assert.ok(accepted.slice(count*2).every(a=>!early.some(old=>old.actionKey===a.actionKey)));
  }finally{f.cleanup();}
});

test('活动整卡可见时即使 checkbox 在 viewport 外仍提优，隐藏整卡不通知',async()=>{
  const visible=[],f=await setup({onCandidateVisible:action=>visible.push(action)});try{
    const input=f.root.querySelector('input[data-activity]'),label=f.doc.createElement('label');
    label.className='activity-card';input.parentElement.append(label);label.append(input);
    label.getBoundingClientRect=()=>rect(20,450,200,100);
    input.getBoundingClientRect=()=>rect(30,520,14,14);
    f.flush();assert.ok(visible.some(a=>a.actionType==='activity'&&a.selected===true));
    const count=visible.filter(a=>a.actionType==='activity').length;
    label.hidden=true;f.timeline.refreshVisibleCandidates();f.flush();
    assert.equal(visible.filter(a=>a.actionType==='activity').length,count);
  }finally{f.cleanup();}
});

test('每个 scene 和当前活动 toggle 都门控，verified 才传 witness；旧轮结果被拒绝',async()=>{
  const f=await setup();try{
    const actions=f.timeline.getPendingActions();assert.equal(actions.length,5);
    assert.deepEqual(actions.filter(a=>a.actionType==='scene').map(a=>a.sceneId),['a','b','c','d'],'未进入旧搜索结果的目录场景仍重新验证');
    const scene=actions.find(a=>a.sceneId==='b'),activity=actions.find(a=>a.actionType==='activity');
    assert.deepEqual(scene.activityIds,['b-act']);assert.deepEqual(scene.continuationWitness,{id:'b'});
    assert.deepEqual(activity.activityIds,[]);
    const card=f.root.querySelector('.scene-strip').children[1],input=f.root.querySelector('input[data-activity]');
    assert.equal(input.checked,true);assert.equal(input.disabled,true);
    assert.equal(card.getAttribute('aria-disabled'),'true');assert.equal(card.hidden,true);
    f.emit('click',card);assert.equal(f.calls.length,0);
    assert.equal(f.emit('keydown',card,'Enter').defaultPrevented,true);
    assert.equal(f.emit('keydown',card,'ArrowRight').defaultPrevented,undefined);
    input.checked=false;f.emit('change',input);assert.equal(input.checked,true);assert.equal(f.calls.length,0);
    assert.equal(f.timeline.updateActionValidation({...scene,stageIndex:9,validationStatus:'verified'}),false);
    assert.equal(f.timeline.updateActionValidation({actionKey:scene.actionKey,validationStatus:'verified'}),false);
    assert.equal(f.timeline.updateActionValidation({...scene,validationStatus:'verified',continuationWitness:{full:true}}),true);
    f.emit('click',card);assert.deepEqual(f.calls[0],['scene',0,'b',['b-act'],{knownPlan:{full:true}}]);
    assert.equal(card.dataset.fitScore,'73');assert.match(card.querySelector('.scene-score').innerHTML,/<b>73<\/b>/);
    assert.equal(f.timeline.getPendingActions().some(a=>a.actionKey===scene.actionKey),false);
    f.timeline.updateActionValidation({...activity,validationStatus:'verified',continuationWitness:{withoutActivity:true}});
    assert.equal(input.disabled,false);input.checked=false;f.emit('change',input);
    assert.deepEqual(f.calls[1],['activity',0,'a',[],{knownPlan:{withoutActivity:true}}]);
    f.timeline.render(f.plan);assert.equal(f.timeline.updateActionValidation({...scene,validationStatus:'verified'}),false);
    assert.equal(f.root.querySelector('input[data-activity]').disabled,true);
  }finally{f.cleanup();}
});

test('冲突卡隐藏；有限搜索失败可浏览且不可选；已选活动不会被非法取消',async()=>{
  const f=await setup();try{
    const pending=f.timeline.getPendingActions(),b=pending.find(a=>a.sceneId==='b'),a=pending.find(a=>a.actionType==='scene'&&a.sceneId==='a'),toggle=pending.find(a=>a.actionType==='activity');
    f.timeline.updateActionValidation({...b,validationStatus:'hard_rejected'});
    const card=f.root.querySelector('.scene-strip').children[1];assert.equal(card.hidden,true);
    f.timeline.updateActionValidation({...a,validationStatus:'unresolved'});
    const selected=f.root.querySelector('.scene-strip').children[0];assert.equal(selected.hidden,false);assert.match(selected.getAttribute('aria-label'),/有限搜索/);
    f.timeline.updateActionValidation({...toggle,validationStatus:'hard_rejected'});
    const input=f.root.querySelector('input[data-activity]');assert.equal(input.checked,true);assert.equal(input.disabled,true);
    f.emit('click',selected);assert.equal(f.calls.length,0);
    f.timeline.updateCandidate({stageIndex:0,sceneId:'a',candidate:{fitScore:99,scoreStatus:'evaluated'}});
    f.emit('click',selected);assert.equal(f.calls.length,0);assert.match(selected.getAttribute('aria-label'),/暂不可选/);
  }finally{f.cleanup();}
});

test('viewport 提优覆盖活动，pending 撤销可选性，特殊餐卡也携带 knownPlan',async()=>{
  const visible=[],f=await setup({onCandidateVisible:action=>visible.push(action)});try{
    f.flush();assert.ok(visible.some(a=>a.actionType==='scene'));assert.ok(visible.some(a=>a.actionType==='activity'));
    const action=f.timeline.getPendingActions().find(a=>a.sceneId==='b');
    f.timeline.updateActionValidation({...action,validationStatus:'verified'});
    f.timeline.pending({fromStage:0,preserveThrough:0});f.emit('click',f.root.querySelector('.scene-strip').children[1]);assert.equal(f.calls.length,0);
    f.timeline.render({...f.plan,stages:[{...f.plan.stages[0],mealRole:'breakfast'}],mealRequirements:[{mealRole:'breakfast',choiceMode:'together',targetMinute:550,insertIndex:0,candidates:f.plan.stages[0].candidates}]},{preserveThrough:-1});
    const special=f.timeline.getPendingActions().find(a=>a.sceneId==='__breakfast_before_meeting');assert.ok(special);
    assert.equal(special.actionType,'meal_mode');assert.deepEqual(special.choice,{mode:'before_meeting'});
    f.timeline.updateActionValidation({...special,validationStatus:'verified',continuationWitness:{meal:true}});
    const meal=f.root.children[0],card=meal.querySelector('.scene-strip').children.find(c=>c.dataset.scene===special.sceneId);
    f.emit('click',card);assert.deepEqual(f.calls[0],['meal','breakfast',{mode:'before_meeting'},{fromStage:0,knownPlan:{meal:true}}]);
  }finally{f.cleanup();}
});

test('分别卡验证后携带 witness，pending 不接收证书，失败规划允许特殊餐恢复',async()=>{
  const f=await setup({onDeparture:(...args)=>f.calls.push(['departure',...args])});try{
    f.catalog.departures=[{id:'bye',title:'分别',description:'分别说明'},{id:'bye2',title:'另一分别',description:'分别说明'}];
    f.timeline.render({...f.plan,departure:{id:'bye',startMinute:660,endMinute:670,candidates:[{id:'bye'},{id:'bye2'}]}});
    const action=f.timeline.getPendingActions().find(a=>a.departureId==='bye2');assert.equal(action.actionType,'departure');
    const card=f.root.children.at(-1).querySelector('.scene-strip').children[1];
    f.emit('click',card);assert.equal(f.calls.length,0);
    f.timeline.updateActionValidation({...action,validationStatus:'verified',continuationWitness:{bye:true}});
    f.emit('click',card);assert.deepEqual(f.calls[0],['departure','bye2',{knownPlan:{bye:true}}]);
    f.timeline.pending({fromStage:0,preserveThrough:0});
    assert.deepEqual(f.timeline.getPendingActions(),[]);
    assert.equal(f.timeline.updateActionValidation({...action,validationStatus:'verified',continuationWitness:{bye:true}}),false);
    f.emit('click',card);assert.equal(f.calls.length,1);
    f.timeline.render({...f.plan,ok:false,mealRequirements:[{mealRole:'supper',choiceMode:'together',targetMinute:700,insertIndex:0,candidates:[]}]},{preserveThrough:-1});
    const button=f.root.querySelector('button[data-skip-supper]');assert.ok(button);
    assert.equal(f.root.querySelectorAll('.scene-card').some(card=>card.dataset.scene==='__supper_skip'),false);
    f.emit('click',button);assert.deepEqual(f.calls[1],['meal','supper',{mode:'skip'},{fromStage:0}]);
  }finally{f.cleanup();}
});

test('未选中的未验证及冲突活动隐藏；重复点击当前场景传已验证 witness',async()=>{
  const f=await setup();try{
    f.catalog.scenes[0].activities.push({id:'extra',title:'额外活动',description:'说明',group:'玩法'});
    f.timeline.render(f.plan);
    const action=f.timeline.getPendingActions().find(a=>a.activityId==='extra'),input=f.root.querySelector('input[data-activity="extra"]');
    const card=f.doc.createElement('label');card.className='activity-card';input.parentElement.append(card);card.append(input);
    f.timeline.updateActionValidation({...action,validationStatus:'unresolved'});assert.equal(card.hidden,true);assert.equal(input.disabled,true);
    f.timeline.updateActionValidation({...action,validationStatus:'hard_rejected'});assert.equal(card.hidden,true);assert.equal(input.checked,false);
    const current=f.timeline.getPendingActions().find(a=>a.actionType==='scene'&&a.sceneId==='a');
    f.timeline.updateActionValidation({...current,validationStatus:'verified',continuationWitness:{current:true}});
    const selected=f.root.querySelector('.scene-strip').children[0];
    f.emit('click',selected);f.emit('click',selected);
    assert.deepEqual(f.calls,[['scene',0,'a',['a-act'],{knownPlan:{current:true}}],['scene',0,'a',['a-act'],{knownPlan:{current:true}}]]);
    f.timeline.pending({fromStage:0,preserveThrough:0});f.emit('click',selected);assert.equal(f.calls.length,2);
  }finally{f.cleanup();}
});

test('verified 点击冻结前段顺序；探索排序与评分值保持确定',async()=>{
  const f=await setup();try{
    const action=f.timeline.getPendingActions().find(a=>a.sceneId==='b');
    f.timeline.updateActionValidation({...action,validationStatus:'verified',continuationWitness:{full:true}});
    f.emit('click',f.root.querySelector('.scene-strip').children[1]);
    f.timeline.updateCandidate({stageIndex:0,sceneId:'b',candidate:{q:99,fitScore:99}});f.flush();
    assert.deepEqual(f.root.querySelector('.scene-strip').children.map(c=>c.dataset.scene),['a','b','c','d']);
    assert.equal(f.root.querySelector('.scene-strip').children[1].dataset.fitScore,'99');
    const plan={...f.plan,stages:[{...f.plan.stages[0],decisionMode:'seeded_exploration',candidates:f.plan.stages[0].candidates.map((c,index)=>({...c,displayOrderIndex:1-index}))}]};
    f.timeline.render(plan,{preserveThrough:-1});f.timeline.updateCandidate({stageIndex:0,sceneId:'a',candidate:{q:999,fitScore:90,displayOrderIndex:-1}});f.flush();
    assert.deepEqual(f.root.querySelector('.scene-strip').children.map(c=>c.dataset.scene),['b','a','c','d']);
    assert.equal(f.root.querySelector('.scene-strip').children[1].dataset.validationStatus,'pending');
  }finally{f.cleanup();}
});

test('centerSelected 居中全部横条，包括保留用餐、当前阶段与分别；同选项仍门控',async()=>{
  const f=await setup({onDeparture:(...args)=>f.calls.push(['departure',...args])});try{
    f.catalog.departures=[{id:'bye',title:'分别',description:'分别说明'}];
    const plan={...f.plan,mealRequirements:[{mealRole:'breakfast',choiceMode:'before_meeting',targetMinute:550,insertIndex:0,candidates:f.plan.stages[0].candidates}],departure:{id:'bye',startMinute:660,endMinute:670,candidates:[{id:'bye'}]}};
    f.timeline.render(plan,{preserveThrough:-1});
    const orders=f.root.children.map(view=>view.querySelector('.scene-strip').children.map(card=>card.dataset.scene));
    const before=f.centers.length;
    f.timeline.render(plan,{preserveThrough:0,preserveKey:'stage-0',centerSelected:true});
    assert.deepEqual(f.centers.slice(before),f.root.children.map((view,index)=>[view.querySelector('.scene-strip'),['__breakfast_before_meeting','a','bye'][index],{smooth:true}]));
    assert.deepEqual(f.root.children.map(view=>view.querySelector('.scene-strip').children.map(card=>card.dataset.scene)),orders);
    for(const [index,id]of [[0,'__breakfast_before_meeting'],[2,'bye']]){
      const card=f.root.children[index].querySelector('.scene-strip').children.find(card=>card.dataset.scene===id);
      f.emit('click',card);assert.equal(f.calls.length,index===0?0:1);
      const action=f.timeline.getPendingActions().find(action=>action.sceneId===id);
      assert.equal(f.timeline.updateActionValidation({...action,validationStatus:'verified',continuationWitness:{selected:id}}),true);
      f.emit('click',card);
    }
    assert.deepEqual(f.calls,[['meal','breakfast',{mode:'before_meeting'},{fromStage:0,knownPlan:{selected:'__breakfast_before_meeting'}}],['departure','bye',{knownPlan:{selected:'bye'}}]]);
  }finally{f.cleanup();}
});

test('utility_best 选择与 seeded_exploration 展示分离，stage/result displayMode 均保探索排名',async()=>{
  const f=await setup();try{
    for(const owner of ['stage','result']){
      const stage={...f.plan.stages[0],decisionMode:'utility_best',choiceMode:'utility_best',candidates:f.plan.stages[0].candidates.map((c,index)=>({...c,displayOrderIndex:1-index,explorationRank:1-index}))};
      const plan={...f.plan,stages:[stage],selectionMode:'utility_best'};
      if(owner==='stage')stage.displayMode='seeded_exploration';else plan.displayMode='seeded_exploration';
      f.timeline.render(plan,{preserveThrough:-1});
      assert.deepEqual(f.root.querySelector('.scene-strip').children.map(card=>card.dataset.scene),['b','a','c','d']);
      const action=f.timeline.getPendingActions().find(action=>action.sceneId==='a'&&action.actionType==='scene');
      f.timeline.updateActionValidation({...action,validationStatus:'verified',continuationWitness:{full:true},candidate:{q:999,fitScore:99,displayOrderIndex:-1,explorationRank:-1}});f.flush();
      assert.deepEqual(f.root.querySelector('.scene-strip').children.map(card=>card.dataset.scene),['b','a','c','d']);
      assert.match(f.root.querySelector('.scene-strip').children[1].querySelector('.scene-score').innerHTML,/<b>99<\/b>/);
    }
  }finally{f.cleanup();}
});
