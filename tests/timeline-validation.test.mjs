import test from 'node:test';
import {CAMPING_EXPLORATION_MIN,isSceneAllowedAtExploration} from '../exploration.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {isSceneInSchoolScope} from '../school-scope.mjs';

// 复用只读 DOM fixture，直接执行 timeline 源码，避免引入浏览器或构建依赖。
let fixtureRound=0;
async function setup(options={}){
  const fixtureSource=await readFile(new URL('./timeline-order.test.mjs',import.meta.url),'utf8');
  const fixture=new Function('isSceneInSchoolScope',`${fixtureSource.slice(fixtureSource.indexOf('class Element'),fixtureSource.indexOf('const candidate='))};return fixture;`)(isSceneInSchoolScope);
  const f=fixture(),oldDocument=globalThis.document;
  globalThis.document=f.doc;
  const key=Symbol.for('datemate.timeline.validation.test');globalThis[key]={...f.deps,isSceneAllowedAtExploration};
  const source=(await readFile(new URL('../timeline.mjs',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
  const {createTimeline}=await import(`data:text/javascript;base64,${Buffer.from(`const CAMPING_EXPLORATION_MIN=${CAMPING_EXPLORATION_MIN}; const {isSceneAllowedAtExploration,attachCarousel,centerCard,syncCarousel,esc,formatTime,toggleActivity,isSceneInSchoolScope}=globalThis[Symbol.for('datemate.timeline.validation.test')];\n${source}`).toString('base64')}#${++fixtureRound}`);
  const calls=[];
  const timeline=createTimeline({...f,onScene:(...args)=>calls.push(['scene',...args]),onActivities:(...args)=>calls.push(['activity',...args]),onMeal:(...args)=>calls.push(['meal',...args]),...options});
  const plan={ok:true,stages:[{sceneId:'a',activityIds:['a-act'],startMinute:600,endMinute:660,candidates:['a','b'].map(id=>({sceneId:id,activityIds:[`${id}-act`],fitScore:73,q:73,scoreStatus:'evaluated',continuationWitness:{id}}))}]};
  function emit(type,target,key){
    let stopped=false;const event={type,target,key,preventDefault(){this.defaultPrevented=true;},stopImmediatePropagation(){stopped=true;}};
    for(const fn of f.root.listeners[type]||[]){fn(event);if(stopped)break;}return event;
  }
  timeline.render(plan);
  return {...f,timeline,plan,calls,emit,cleanup(){timeline.dispose();globalThis.document=oldDocument;delete globalThis[key];}};
}

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
