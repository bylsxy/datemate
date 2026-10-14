import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {isSceneInSchoolScope} from '../school-scope.mjs';

// 只替换轮播和格式化依赖；实际执行 timeline 的渲染、事件与后台更新逻辑。
class Element {
  constructor(doc,tag='div',className=''){this.ownerDocument=doc;this.tagName=tag.toUpperCase();this.className=className;this.dataset={};this.children=[];this.attributes={};this.listeners={};this.scrollLeft=0;this.hidden=false;this._html='';}
  get classList(){return {contains:name=>this.className.split(' ').includes(name),add:(...names)=>names.forEach(name=>this.classList.toggle(name,true)),remove:(...names)=>names.forEach(name=>this.classList.toggle(name,false)),toggle:(name,on)=>{const names=new Set(this.className.split(' ').filter(Boolean));on??=!names.has(name);if(on)names.add(name);else names.delete(name);this.className=[...names].join(' ');return on;}};}
  set innerHTML(html){this._html=html;for(const child of this.children)child.parentElement=null;this.children=[];
    const add=(tag,cls)=>{const el=new Element(this.ownerDocument,tag,cls);this.append(el);return el;};
    if(html.includes('class="transfer-bar"'))for(const cls of ['transfer-bar','stage-heading','scene-strip','stage-activities','stage-meta'])add('div',cls);
    else if(html.includes('class="scene-score"')){add('span','scene-score');add('h3','scene-title');add('p','scene-desc');}
    else if(html.includes('class="stage-time"'))add('h2','stage-time');
    else for(const match of html.matchAll(/<input\b([^>]+)>/g)){const input=add('input','');for(const attr of match[1].matchAll(/data-([\w-]+)="([^"]*)"/g))input.dataset[attr[1]]=attr[2];input.checked=match[1].includes('checked');}
  }
  get innerHTML(){return this._html;}
  append(el){this.insertBefore(el,null);}
  insertBefore(el,before){if(el===before)return;el.remove();const at=before?this.children.indexOf(before):this.children.length;this.children.splice(at,0,el);el.parentElement=this;}
  remove(){if(this.parentElement){const siblings=this.parentElement.children;siblings.splice(siblings.indexOf(this),1);this.parentElement=null;}}
  contains(el){return el===this||this.children.some(child=>child.contains(el));}
  matches(selector){if(selector.startsWith('.'))return this.classList.contains(selector.slice(1));if(!selector.startsWith('input')||this.tagName!=='INPUT')return false;return [...selector.matchAll(/\[data-([\w-]+)(?:="([^"]*)")?\]/g)].every(([,key,value])=>value===undefined?key in this.dataset:this.dataset[key]===value);}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  closest(selector){return this.matches(selector)?this:this.parentElement?.closest(selector)||null;}
  setAttribute(name,value){this.attributes[name]=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
  removeAttribute(name){delete this.attributes[name];}
  addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
  removeEventListener(name,fn){this.listeners[name]=(this.listeners[name]||[]).filter(item=>item!==fn);}
  focus(){this.ownerDocument.activeElement=this;}
  getBoundingClientRect(){return {left:0,right:500,top:0,bottom:100,width:500,height:100};}
  get offsetLeft(){return (this.parentElement?.children.indexOf(this)||0)*100;}
}
function fixture(){
  let next=0;const frames=new Map(),timers=new Map(),centers=[];
  const win={requestAnimationFrame:fn=>{frames.set(++next,fn);return next;},cancelAnimationFrame:id=>frames.delete(id),setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id),addEventListener(){},removeEventListener(){},innerWidth:500,innerHeight:500};
  const doc={defaultView:win,documentElement:{clientWidth:500,clientHeight:500},createElement:tag=>new Element(doc,tag)};
  const root=new Element(doc);doc.querySelector=()=>root;doc.activeElement=null;
  const deps={isSceneInSchoolScope,esc:value=>value,formatTime:String,toggleActivity:(_scene,ids,id)=>ids.includes(id)?ids.filter(item=>item!==id):[...ids,id],syncCarousel(){},centerCard:(strip,id,options)=>centers.push([strip,id,options]),attachCarousel:strip=>({update({selectedId}){for(const card of strip.children){card.classList.toggle('selected',card.dataset.scene===selectedId);card.setAttribute('aria-checked',String(card.dataset.scene===selectedId));}},destroy(){}})};
  const scenes=['a','b','c','d'].map(id=>({id,title:id,description:id,activities:[{id:`${id}-act`,title:id,description:id,group:'玩法',mealRoles:['breakfast']}],mealRoles:['breakfast'],default:[`${id}-act`]}));
  let intent={prefix:[],context:{dietaryRestrictions:[]}};
  return {doc,root,deps,centers,catalog:{scenes},getIntent:()=>intent,setIntent:value=>intent=value,flush(){for(const queue of [timers,frames])for(const [id,fn]of [...queue]){queue.delete(id);fn();}},emit(type,target){for(const fn of root.listeners[type]||[])fn({target});}};
}
const candidate=id=>({sceneId:id,activityIds:[`${id}-act`],scoreStatus:'evaluated',fitScore:70,q:70});
const stage=(id,index,ids=['a','b','c'])=>({sceneId:id,activityIds:[`${id}-act`],startMinute:600+index*60,endMinute:650+index*60,candidates:ids.map(candidate)});
const result=stages=>({ok:true,stages});
const order=element=>element.querySelector('.scene-strip').children.map(card=>card.dataset.scene);

test('保留阶段的真实 DOM 顺序、候选集合、评分更新、即时选择和稳定 key',async()=>{
  const f=fixture(),oldDocument=globalThis.document,oldCSS=globalThis.CSS;
  const dependencyKey=Symbol.for('datemate.timeline.order.test');
  globalThis[dependencyKey]=f.deps;globalThis.document=f.doc;globalThis.CSS={escape:value=>value};
  let timeline;
  try{
    const source=(await readFile(new URL('../timeline.mjs',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
    const {createTimeline}=await import(`data:text/javascript;base64,${Buffer.from(`const {attachCarousel,centerCard,syncCarousel,esc,formatTime,toggleActivity,isSceneInSchoolScope}=globalThis[Symbol.for('datemate.timeline.order.test')];\n${source}`).toString('base64')}`);
    timeline=createTimeline({...f,onScene(){},onActivities(){},onMeal(){}});
    const certify=(predicate,candidate)=>{
      const action=timeline.getPendingActions().find(predicate);
      assert.ok(action,'待验证操作必须存在');
      assert.equal(timeline.updateActionValidation({...action,...(candidate?{candidate}:{}),validationStatus:'verified',continuationWitness:[{sceneId:action.sceneId,activityIds:action.activityIds}]}),true);
    };
    timeline.render(result([stage('a',0),stage('a',1),stage('a',2)]));
    const [first,current,later]=f.root.children;
    const firstHeading=first.querySelector('.stage-heading').innerHTML;
    const browsed=current.querySelector('.scene-strip').children[2];browsed.focus();
    // 点击就阻止已排队的后台重排，尚未进入 pending 也受保护。
    timeline.updateCandidate({stageIndex:1,sceneId:'c',candidate:{q:100}});
    certify(action=>action.stageIndex===1&&action.sceneId==='b'&&action.actionType==='scene');
    f.emit('click',current.querySelector('.scene-strip').children[1]);f.flush();
    assert.deepEqual(order(current),['a','b','c','d']);
    timeline.pending({fromStage:1,choice:{index:1,sceneId:'b',activityIds:['b-act']}});
    assert.equal(current.classList.contains('is-recomputing'),false);
    assert.equal(first.querySelector('.stage-heading').innerHTML,firstHeading);
    assert.equal(current.querySelector('.scene-strip').children[1].getAttribute('aria-checked'),'true');
    assert.ok(current.querySelector('input[data-scene="b"][data-activity="b-act"]'));
    assert.equal(later.classList.contains('is-recomputing'),true);
    const centersBefore=f.centers.length;
    timeline.render(result([stage('a',0,['a']),stage('b',1,['b']),stage('c',2,['c','b','a'])]),{preserveThrough:1});
    assert.deepEqual(order(first),['a','b','c','d']);
    assert.equal(first.querySelector('.stage-heading').innerHTML,firstHeading);
    assert.deepEqual(order(current),['a','b','c','d']);
    assert.deepEqual(order(later),['c','b','a','d']);
    assert.equal(f.doc.activeElement,browsed);
    assert.equal(f.centers.slice(centersBefore).some(([strip])=>strip===current.querySelector('.scene-strip')),false);
    certify(action=>action.stageIndex===1&&action.sceneId==='a'&&action.actionType==='scene',{q:999,fitScore:99});f.flush();
    assert.deepEqual(order(current),['a','b','c','d']);
    assert.match(current.querySelector('.scene-strip').children[0].querySelector('.scene-score').innerHTML,/99/);
    // 快速连续选择后续阶段时，先前骨架恢复为已有完整内容再保留。
    timeline.pending({fromStage:0,choice:{index:0,sceneId:'a',activityIds:['a-act']}});
    timeline.pending({fromStage:2,choice:{index:2,sceneId:'c',activityIds:['c-act']}});
    assert.equal(current.classList.contains('is-recomputing'),false);
    assert.equal(current.querySelector('.scene-strip').children.some(card=>card.classList.contains('is-pending')),false);
    assert.ok(current.querySelector('input[data-activity="b-act"]'));
    assert.doesNotMatch(current.querySelector('.stage-heading').innerHTML,/skeleton/);
    // 显式解除保留后，新的推荐集合和顺序生效。
    timeline.render(result([stage('d',0,['d']),stage('b',1,['b','a'])]),{preserveThrough:-1});
    assert.deepEqual(order(first),['d','a','b','c']);assert.deepEqual(order(current),['b','a','c','d']);
    timeline.updateCandidate({stageIndex:1,sceneId:'a',candidate:{q:999}});f.flush();
    assert.deepEqual(order(current),['a','b','c','d']);
    // 活动选择也锁住整条候选顺序；render 未显式传保留范围时沿用 pending。
    certify(action=>action.stageIndex===1&&action.activityId==='b-act'&&action.actionType==='activity');
    f.emit('change',current.querySelector('input[data-activity="b-act"]'));
    timeline.pending({fromStage:1,preserveThrough:1,preserveKey:'stage-1',choice:{index:1,sceneId:'b',activityIds:[]}});
    f.setIntent({prefix:[{sceneId:'d',activityIds:['d-act']},{sceneId:'b',activityIds:[]}],context:{dietaryRestrictions:[]}});
    timeline.render(result([stage('d',0,['d']),{...stage('b',1,['b']),activityIds:[]}]));
    assert.deepEqual(order(current),['a','b','c','d']);
    assert.equal(current.querySelector('input[data-activity="b-act"]').checked,false);
    timeline.pending({fromStage:1,preserveThrough:1,preserveKey:'stage-1',choice:{index:1,sceneId:'a',activityIds:['a-act']}});
    // 根回滚旧完整 result 时，选择恢复，但当前浏览列表仍然存在。
    timeline.render(result([stage('d',0,['d']),stage('b',1,['b'])]),{preserveThrough:1,preserveKey:'stage-1'});
    assert.deepEqual(order(current),['a','b','c','d']);
    assert.equal(current.querySelector('.scene-strip').children[1].getAttribute('aria-checked'),'true');
    timeline.updateCandidate({stageIndex:1,sceneId:'a',candidate:{scoreStatus:'pending',fitScore:null}});
    timeline.render(result([stage('d',0,['d']),stage('b',1,['b'])]),{preserveThrough:1,preserveKey:'stage-1'});
    const retainedPending=timeline.getPendingCandidates().find(item=>item.viewKey==='stage-1'&&item.sceneId==='a');
    assert.ok(retainedPending);assert.equal(retainedPending.stageIndex,1);
    retainedPending.candidate.activityIds.push('external-change');
    assert.deepEqual(timeline.getPendingCandidates().find(item=>item.sceneId==='a').candidate.activityIds,['a-act']);
    timeline.updateCandidate({...retainedPending,candidate:{scoreStatus:'evaluated',fitScore:95,q:999}});f.flush();
    assert.equal(timeline.getPendingCandidates().some(item=>item.sceneId==='a'&&item.viewKey==='stage-1'),false);
    assert.deepEqual(order(current),['a','b','c','d']);
    // slider 全局重算显式 -1 优先于已有 prefix 和旧的保留 key。
    timeline.pending({fromStage:0,preserveThrough:-1,preserveKey:'stage-1'});
    timeline.render(result([stage('d',0,['d']),stage('b',1,['b'])]),{preserveThrough:-1,preserveKey:'stage-1'});
    assert.deepEqual(order(current),['b','a','c','d']);
    f.setIntent({prefix:[],exploration:1,context:{dietaryRestrictions:[]}});
    // 排名字段在普通和人工阶段也存在，只有明确探索 mode 才使用展示排名。
    const ranked=id=>({...candidate(id),displayOrderIndex:id==='b'?0:1,explorationRank:id==='b'?0:1});
    for(const mode of ['utility_best','manual']){
      timeline.render({...result([stage('d',0,['d']),{...stage('b',1,['b','a']),decisionMode:mode,candidates:['b','a'].map(ranked)}]),exploration:1},{preserveThrough:-1});
      timeline.updateCandidate({stageIndex:1,sceneId:'a',candidate:{q:999,fitScore:99}});f.flush();
      assert.deepEqual(order(current),['a','b','c','d']);
    }
    for(const field of ['decisionMode','choiceMode']){
      timeline.render({...result([stage('d',0,['d']),{...stage('b',1,['a','b']),[field]:'seeded_exploration',candidates:['a','b'].map(ranked)}]),exploration:0},{preserveThrough:-1});
      assert.deepEqual(order(current),['b','a','c','d']);
      certify(action=>action.stageIndex===1&&action.sceneId==='a'&&action.actionType==='scene',{q:999,fitScore:99,displayOrderIndex:-1,explorationRank:-1});f.flush();
      assert.deepEqual(order(current),['b','a','c','d']);
      assert.match(current.querySelector('.scene-strip').children[1].querySelector('.scene-score').innerHTML,/<b>99<\/b>/);
    }
    timeline.render(result([stage('d',0,['d']),{...stage('b',1,['b','a']),decisionMode:'seeded_exploration'}]),{preserveThrough:-1});
    timeline.updateCandidate({stageIndex:1,sceneId:'a',candidate:{q:999}});f.flush();
    assert.deepEqual(order(current),['b','a','c','d']);
    const virtualMenu={mealRole:'breakfast',choiceMode:'before_meeting',targetMinute:550,insertIndex:0,candidates:['a','b','c'].map((id,index)=>({...candidate(id),displayOrderIndex:2-index,explorationRank:2-index}))};
    timeline.render({...result([{...stage('a',0),decisionMode:'utility_best'}]),exploration:1,mealRequirements:[virtualMenu]},{preserveThrough:-1});
    const virtualView=f.root.children[0];
    assert.deepEqual(order(virtualView),['c','b','a','__breakfast_before_meeting']);
    timeline.updateCandidate({stageIndex:0,mealRole:'breakfast',sceneId:'a',candidate:{q:999,fitScore:99}});f.flush();
    assert.deepEqual(order(virtualView),['c','b','a','__breakfast_before_meeting']);
    const meal={mealRole:'breakfast',choiceMode:'before_meeting',targetMinute:550,insertIndex:0,candidates:['a','b','c'].map(candidate)};
    timeline.render({...result([stage('a',0)]),mealRequirements:[meal]},{preserveThrough:-1});
    const mealView=f.root.children[0];
    const ordinary=f.root.children[1];
    timeline.pending({fromStage:0,preserveThrough:0,preserveKey:'meal-breakfast',mealChoice:{role:'breakfast',choice:{sceneId:'b',activityIds:['b-act']}}});
    assert.equal(mealView.classList.contains('is-recomputing'),false);
    assert.equal(ordinary.classList.contains('is-recomputing'),true);
    const mealInput=mealView.querySelector('input[data-activity="b-act"]');mealInput.focus();
    timeline.render({...result([stage('a',0,['c','b','a']),{...stage('b',1,['b']),mealRole:'breakfast'}]),mealRequirements:[{...meal,choiceMode:'together',candidates:['b'].map(candidate)}]},{preserveThrough:0,preserveKey:'meal-breakfast'});
    assert.equal(f.root.children[0],mealView);
    assert.deepEqual(order(mealView),['a','b','c','__breakfast_before_meeting']);
    assert.equal(mealView.dataset.index,1);
    assert.deepEqual(order(ordinary),['c','b','a','d']);
    assert.equal(f.doc.activeElement.dataset.scene,'b');
    assert.equal(Number(f.doc.activeElement.dataset.stage),1);
    assert.ok(mealView.contains(f.doc.activeElement));
    assert.equal(timeline.updateCandidate({stageIndex:0,viewKey:'meal-breakfast',mealRole:'breakfast',sceneId:'a',candidate:{q:999}}),false);
    assert.equal(timeline.updateCandidate({stageIndex:1,viewKey:'meal-breakfast',mealRole:'breakfast',sceneId:'a',candidate:{q:999}}),true);f.flush();
    assert.deepEqual(order(mealView),['a','b','c','__breakfast_before_meeting']);
    // 连续操作的最新结果必须同步前段真实选择与时间，冻结的仅是候选顺序。
    timeline.render(result([{...stage('a',0),scoreReference:{total:10}},stage('a',1),stage('a',2)]),{preserveThrough:-1});
    const [earlier,middle,last]=f.root.children;
    timeline.updateCandidate({stageIndex:0,sceneId:'a',candidate:{scoreStatus:'pending',fitScore:null}});
    timeline.pending({fromStage:0,preserveThrough:0,preserveKey:'stage-0',choice:{index:0,sceneId:'b',activityIds:['b-act']}});
    timeline.pending({fromStage:2,preserveThrough:2,preserveKey:'stage-2',choice:{index:2,sceneId:'c',activityIds:['c-act']}});
    const latest=result([{...stage('b',0,['b']),activityIds:[],startMinute:625,fixedStartMinute:625,scoreReference:{total:20}},{...stage('a',1,['a']),activityIds:[]},stage('c',2,['c'])]);
    const beforeLatestCenters=f.centers.length;
    timeline.render(latest,{preserveThrough:2,preserveKey:'stage-2'});
    assert.deepEqual(order(earlier),['a','b','c','d']);assert.deepEqual(order(middle),['a','b','c','d']);assert.deepEqual(order(last),['a','b','c','d']);
    assert.equal(earlier.querySelector('.scene-strip').children[1].getAttribute('aria-checked'),'true');
    assert.equal(earlier.querySelector('input[data-activity="b-act"]').checked,false);
    assert.equal(middle.querySelector('input[data-activity="a-act"]').checked,false);
    assert.match(earlier.querySelector('.stage-heading').innerHTML,/625/);
    assert.equal(f.centers.slice(beforeLatestCenters).some(([strip])=>strip===earlier.querySelector('.scene-strip')||strip===middle.querySelector('.scene-strip')),false);
    const extra=timeline.getPendingCandidates().find(item=>item.viewKey==='stage-0'&&item.sceneId==='a');
    assert.deepEqual(extra.reference,{total:20});extra.reference.total=999;
    assert.equal(latest.stages[0].scoreReference.total,20);
    const unchangedInput=earlier.querySelector('input[data-activity="b-act"]');
    timeline.render(structuredClone(latest),{preserveThrough:2,preserveKey:'stage-2'});
    assert.equal(earlier.querySelector('input[data-activity="b-act"]'),unchangedInput);
    // 显式居中也覆盖内容完全未变的前段与当前段，只改变横条滚动。
    const beforeCenter=f.centers.length,retainedOrders=f.root.children.map(order);
    timeline.render(structuredClone(latest),{preserveThrough:2,preserveKey:'stage-2',centerSelected:true});
    assert.deepEqual(f.centers.slice(beforeCenter),f.root.children.map((view,index)=>[view.querySelector('.scene-strip'),latest.stages[index].sceneId,{smooth:true}]));
    assert.deepEqual(f.root.children.map(order),retainedOrders);
    assert.equal(earlier.querySelector('input[data-activity="b-act"]'),unchangedInput);
    // 失败用餐回退和旧候选保留不能泄漏专属校园场景。
    Object.assign(f.catalog.scenes[1],{scauOnly:true,area:'campus',place:{universityId:'scau',campusArea:'taishan'}});
    f.setIntent({prefix:[],context:{area:'near',school:'scau',campusArea:'taishan',dietaryRestrictions:[]}});
    timeline.render({...result([stage('a',0)]),mealRequirements:[meal]},{preserveThrough:-1});
    const scopeMeal=f.root.children[0];assert.ok(order(scopeMeal).includes('b'));
    f.setIntent({prefix:[],context:{area:'near',school:'',campusArea:'',dietaryRestrictions:[]}});
    timeline.render({...result([stage('a',0)]),mealRequirements:[meal]},{preserveThrough:0,preserveKey:'meal-breakfast'});
    assert.ok(!order(scopeMeal).includes('b'));
    timeline.render({ok:false,stages:[],mealRequirements:[{...meal,candidates:[]}]},{preserveThrough:-1});
    assert.ok(!order(f.root.children[0]).includes('b'));
  }finally{timeline?.dispose();globalThis.document=oldDocument;globalThis.CSS=oldCSS;delete globalThis[dependencyKey];}
});
