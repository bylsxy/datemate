import test from 'node:test';
import {CAMPING_EXPLORATION_MIN,isSceneAllowedAtExploration} from '../exploration.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {isSceneInSchoolScope} from '../school-scope.mjs';
import {sceneDurationAt,isSceneOpenDuring} from '../scene-time.mjs';
import {durationBounds,splitDuration,mergeStayOption} from '../duration-policy.mjs';
import {mealModeCard,mealOptions} from '../meal-options.mjs';
import {selectMealIntent} from '../planning-intent.mjs';
import {planDate} from '../engine.mjs';

let round=0;
async function setup({scenes}={}){
  const fixtureSource=await readFile(new URL('./timeline-order.test.mjs',import.meta.url),'utf8');
  const fixture=new Function('isSceneInSchoolScope',`${fixtureSource.slice(fixtureSource.indexOf('class Element'),fixtureSource.indexOf('const candidate='))};return fixture;`)(isSceneInSchoolScope);
  const f=fixture(),previousDocument=globalThis.document,key=Symbol.for('datemate.supper.skip.test');
  f.catalog.mealChoiceRoles=['supper'];
  for(const scene of f.catalog.scenes){scene.mealRoles.push('supper');scene.activities[0].mealRoles.push('supper');scene.mealActivityIds=[`${scene.id}-act`];}
  if(scenes)f.catalog.scenes=scenes;
  globalThis.document=f.doc;globalThis[key]={...f.deps,isSceneAllowedAtExploration,sceneDurationAt,isSceneOpenDuring,durationBounds,splitDuration,mergeStayOption,mealModeCard,mealOptions};
  const source=(await readFile(new URL('../timeline.mjs',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
  const {createTimeline}=await import(`data:text/javascript;base64,${Buffer.from(`const CAMPING_EXPLORATION_MIN=${CAMPING_EXPLORATION_MIN}; const {isSceneAllowedAtExploration,attachCarousel,centerCard,syncCarousel,esc,formatTime,toggleActivity,isSceneInSchoolScope,sceneDurationAt,isSceneOpenDuring,durationBounds,splitDuration,mergeStayOption,mealModeCard,mealOptions}=globalThis[Symbol.for('datemate.supper.skip.test')];\n${source}`).toString('base64')}#${++round}`);
  const calls=[],timeline=createTimeline({...f,onScene(){},onActivities(){},onMeal:(...args)=>calls.push(args)});
  function click(target){let stopped=false;const event={type:'click',target,preventDefault(){},stopImmediatePropagation(){stopped=true;}};for(const fn of f.root.listeners.click||[]){fn(event);if(stopped)break;}}
  return {...f,timeline,calls,click,cleanup(){timeline.dispose();globalThis.document=previousDocument;delete globalThis[key];}};
}
const stage=(sceneId,startMinute,endMinute,extra={})=>({sceneId,activityIds:[`${sceneId}-act`],startMinute,endMinute,candidates:[{sceneId,activityIds:[`${sceneId}-act`],scoreStatus:'pending'}],...extra});
const supperPlan=()=>({ok:true,stages:[stage('c',1320,1380),stage('a',1380,1410,{mealRole:'supper'}),stage('d',1410,1470)],mealRequirements:[{mealRole:'supper',label:'宵夜',choiceMode:'together',targetMinute:1380,stageIndex:1,insertIndex:1,candidates:[{sceneId:'a',activityIds:['a-act'],scoreStatus:'pending'}]}]});
const cards=f=>f.root.querySelectorAll('.scene-card');

test('营地场景DOM只在80出现，79移除旧候选且campus卡继续存在',async()=>{
  const scenes=['campus_walk','camp_day_setup','camp_evening'].map(id=>({id,title:id,description:id,kind:'ordinary',area:'campus',activities:[],default:[]}));
  const f=await setup({scenes});try{
    const plan={ok:true,stages:[{sceneId:'campus_walk',activityIds:[],startMinute:1140,endMinute:1200,candidates:scenes.map(scene=>({sceneId:scene.id,activityIds:[],scoreStatus:'pending'}))}]};
    f.setIntent({exploration:80,prefix:[],context:{}});f.timeline.render(plan);
    assert.deepEqual(cards(f).map(card=>card.dataset.scene).sort(),scenes.map(scene=>scene.id).sort());
    for(const sceneId of ['camp_day_setup','camp_evening']){
      const action=f.timeline.getPendingActions().find(action=>action.sceneId===sceneId);assert.ok(action);
      f.timeline.updateActionValidation({...action,validationStatus:'verified',continuationWitness:{stages:[]}});
      assert.equal(cards(f).find(card=>card.dataset.scene===sceneId).hidden,false);
    }
    f.setIntent({exploration:79,prefix:[],context:{}});f.timeline.render(plan,{preserveThrough:0});
    assert.deepEqual(cards(f).map(card=>card.dataset.scene),['campus_walk'],'保留候选不能复活营地，也不能按camp前缀误删校园');
    assert.equal(f.timeline.getPendingActions().some(action=>action.sceneId==='camp_day_setup'||action.sceneId==='camp_evening'),false);
    f.setIntent({exploration:80,prefix:[],context:{}});f.timeline.render(plan,{preserveThrough:-1});
    assert.deepEqual(cards(f).map(card=>card.dataset.scene).sort(),scenes.map(scene=>scene.id).sort());
  }finally{f.cleanup();}
});

test('分别DOM在探索度79没有露营卡，80验证后显示，降回79移除旧卡',async()=>{
  const f=await setup();try{
    f.catalog.departures=[{id:'separate',title:'各自回去',description:'分别'},{id:'camping',title:'露营',description:'一起露营'}];
    const plan={ok:true,stages:[stage('c',1320,1380)],departure:{id:'separate',startMinute:1380,endMinute:1395,candidates:[{id:'separate'},{id:'camping'}]}};
    f.setIntent({exploration:79,prefix:[],context:{}});f.timeline.render(plan);
    assert.equal(cards(f).some(card=>card.dataset.scene==='camping'),false);
    f.setIntent({exploration:80,prefix:[],context:{}});f.timeline.render(plan);
    const action=f.timeline.getPendingActions().find(action=>action.departureId==='camping');assert.ok(action);
    f.timeline.updateActionValidation({...action,validationStatus:'verified',continuationWitness:{stages:[]}});
    const camping=cards(f).find(card=>card.dataset.scene==='camping');assert.ok(camping);assert.equal(camping.hidden,false);
    f.setIntent({exploration:79,prefix:[],context:{}});f.timeline.render(plan,{preserveThrough:1,preserveKey:'departure'});
    assert.equal(cards(f).some(card=>card.dataset.scene==='camping'),false,'保留横条不得复活门槛以下的露营卡');
  }finally{f.cleanup();}
});

test('真实宵夜标题按钮无需候选witness即可跳过，busy禁用且卡片不含skip',async()=>{
  const f=await setup();try{
    const plan=supperPlan();f.timeline.render(plan);
    const button=f.root.querySelector('.skip-supper-button');assert.ok(button);
    assert.equal(button.closest('.stage-heading')?.querySelector('button[data-skip-supper]'),button);
    assert.equal(button.dataset.view,'meal-supper');assert.equal(button.textContent,'不吃宵夜');assert.equal(button.disabled,false);
    assert.deepEqual(cards(f).filter(card=>card.dataset.meal==='supper').map(card=>card.dataset.scene),['__supper_together']);
    assert.equal(cards(f).some(card=>card.dataset.scene==='__supper_skip'),false);
    assert.equal(f.timeline.getPendingActions().some(action=>action.sceneId==='__supper_skip'),false);
    f.click(button);assert.deepEqual(f.calls,[['supper',{mode:'skip'},{fromStage:1}]]);
    f.timeline.pending({fromStage:0,preserveThrough:1});assert.equal(button.disabled,true);
    f.click(button);assert.equal(f.calls.length,1,'busy期间不能再次提交');
  }finally{f.cleanup();}
});

test('按钮仅未跳过宵夜存在，失败虚拟宵夜可恢复，skip的pending/render立即移除占位',async()=>{
  const f=await setup();try{
    const plan=supperPlan();f.timeline.render(plan);
    const mealView=f.root.querySelector('.skip-supper-button').closest('.meal-stage');
    f.timeline.pending({fromStage:1,preserveThrough:0,mealChoice:{role:'supper',choice:{mode:'skip'}}});
    assert.equal(f.root.contains(mealView),false);assert.equal(f.root.querySelector('.skip-supper-button'),null);
    const skipped={...plan,stages:[plan.stages[0],stage('d',1380,1440)],mealRequirements:[{...plan.mealRequirements[0],choiceMode:'skip',stageIndex:null}]};
    f.timeline.render(skipped,{preserveThrough:1,preserveKey:'meal-supper'});
    assert.equal(f.root.querySelector('.skip-supper-button'),null);assert.equal(f.root.querySelectorAll('.meal-stage').length,0,'保留视图不能回填已经跳过的宵夜');
    f.timeline.render(plan,{preserveThrough:-1});
    f.timeline.render(skipped,{preserveThrough:1,preserveKey:'meal-supper'});
    assert.equal(f.root.querySelectorAll('.meal-stage').length,0,'直接render跳过宵夜时也不能从preserved回填旧视图');
    f.timeline.render({...plan,ok:false,stages:[],mealRequirements:[{...plan.mealRequirements[0],stageIndex:null,insertIndex:0,candidates:[]}]},{preserveThrough:-1});
    const recovery=f.root.querySelector('button[data-skip-supper]');assert.ok(recovery);f.click(recovery);
    assert.deepEqual(f.calls.at(-1),['supper',{mode:'skip'},{fromStage:0}]);
    f.timeline.render({ok:true,stages:[stage('c',600,660)],mealRequirements:[]},{preserveThrough:-1});assert.equal(f.root.querySelector('.skip-supper-button'),null);
    f.timeline.render({ok:true,stages:[stage('a',600,630,{mealRole:'breakfast'})],mealRequirements:[{mealRole:'breakfast',label:'早餐',choiceMode:'together',stageIndex:0,targetMinute:600,insertIndex:0,candidates:[]}]},{preserveThrough:-1});assert.equal(f.root.querySelector('.skip-supper-button'),null);
  }finally{f.cleanup();}
});

test('跳过宵夜保留此前人工prefix和预约，释放当前及后续选择而不锁住自动时间',()=>{
  const plan=supperPlan();plan.stages.splice(1,0,stage('b',1350,1380));plan.mealRequirements[0].stageIndex=2;plan.mealRequirements[0].insertIndex=2;
  const catalog={scenes:['a','b','c','d'].map(id=>({id,activities:[{id:`${id}-act`,requiresExplicitConsent:id==='c'}]}))};
  const state={exploration:7,prefix:[{sceneId:'c',activityIds:['c-act'],startMinute:1320,durationMinutes:30},{sceneId:'b',activityIds:['b-act']},{sceneId:'a',activityIds:['a-act'],mealRole:'supper'},{sceneId:'d',activityIds:['d-act']}],context:{periodIds:['evening','night'],budget:80,requiredSceneIds:['d'],mealChoices:{supper:{sceneId:'a',activityIds:['a-act']}},departureChoice:'hotel',endAfterStage:3,minimumStageCount:4,explicitConsentIds:['stale']}};
  const before=structuredClone(state),next=selectMealIntent(state,plan,'supper',{mode:'skip'},2,catalog);
  assert.deepEqual(next.prefix,state.prefix.slice(0,2));assert.deepEqual(next.context.mealChoices.supper,{mode:'skip'});
  assert.equal(Object.hasOwn(next.prefix[1],'startMinute'),false);assert.equal(next.prefix.some(choice=>choice.mealRole==='supper'),false);
  assert.equal(next.context.departureChoice,'separate');assert.equal(next.context.endAfterStage,undefined);assert.equal(next.context.minimumStageCount,undefined);
  assert.deepEqual(next.context.explicitConsentIds,['c-act']);assert.deepEqual(next.context.requiredSceneIds,['d']);assert.equal(next.context.budget,80);assert.deepEqual(state,before);
});

test('evening/night的skip重规划连接宵夜前后时间，保留前序并无宵夜阶段或额外等待',()=>{
  const ordinary={id:'walk',minutes:90,cost:[0,0],load:0,kind:'ordinary',area:'campus',indoor:true,quiet:true,fit:70,activities:[]};
  const food={...ordinary,id:'food',minutes:30,kind:'meal',mealRoles:['supper'],activities:[{id:'eat',cost:[0,0],load:0,provides:['meal_completed'],mealRoles:['supper']}]};
  const catalog={version:'skip-supper-regression',scenes:[ordinary,food],transfers:{campus:{campus:0}},departures:[{id:'separate',minutes:15,cost:[0,0]}]};
  const state={exploration:0,prefix:[],context:{periodIds:['evening','night'],reserve:0,robust:false,fatigueA:0,fatigueB:0}};
  const original=planDate(state.context,catalog);assert.equal(original.ok,true,original.errors?.join(';'));
  const index=original.stages.findIndex(s=>s.mealRole==='supper');assert.ok(index>=0);
  const next=selectMealIntent(state,original,'supper',{mode:'skip'},index,catalog);
  const result=planDate(next.context,catalog,{fixedPrefix:next.prefix});assert.equal(result.ok,true,result.errors?.join(';'));
  assert.deepEqual(result.stages.slice(0,index).map(s=>[s.sceneId,s.activityIds,s.start]),original.stages.slice(0,index).map(s=>[s.sceneId,s.activityIds,s.start]));
  assert.equal(result.stages.some(s=>s.mealRole==='supper'),false);assert.equal(result.metrics.waitingMinutes,0);
  for(let i=1;i<result.stages.length;i++)assert.equal(result.stages[i].start,result.stages[i-1].end,'宵夜移除后的时间必须连续');
  assert.ok(result.stages.some(s=>s.start<1380&&s.end>1380),'普通活动应连续跨过晚上与夜晚边界');
  assert.equal(result.metrics.periodCoverageSatisfied,true);assert.equal(result.mealRequirements.find(m=>m.mealRole==='supper').choiceMode,'skip');
});
