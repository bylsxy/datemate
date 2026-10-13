import {attachCarousel,centerCard,syncCarousel} from './carousel.mjs?v=4.1.0';
import {escapeHTML as esc,formatTime,toggleActivity} from './planner.mjs?v=4.1.0';

const skeleton = (kind='line') => `<span class="skeleton skeleton-${kind}" aria-hidden="true"></span>`;
const cardDescription=scene=>{
  const full=scene.cardDescription||scene.description||'',short=full.split(/[。；]/)[0];
  return short.length>32?`${short.slice(0,32)}…`:short;
};
const specialFor=role=>role==='breakfast'?{id:'__breakfast_before_meeting',title:'会面前吃早餐',description:'见面前各自吃好早餐，见面后直接开始。',mode:'before_meeting'}:role==='supper'?{id:'__supper_skip',title:'不吃宵夜',description:'这一餐不安排，前后的活动继续相连。',mode:'skip'}:null;
const mealActivityIds=(scene,role)=>(scene.mealActivityIds||[]).filter(id=>scene.activities.some(a=>a.id===id&&a.mealRoles?.includes(role)));
// 特殊用餐选择没有地点对象；先分支处理，再读取真实餐馆的活动。
export function resolveMealCardChoice(role,sceneId,{scene,current,candidate}={}){
  const special=specialFor(role);
  if(sceneId===special?.id)return {mode:special.mode};
  if(!scene||scene.id!==sceneId)throw Error('请选择适用的用餐地点。');
  const ids=current?.sceneId===scene.id?current.activityIds:candidate?.activityIds||mealActivityIds(scene,role).slice(0,1);
  return {sceneId:scene.id,activityIds:[...(ids||[])]};
}
export function skeletonStage(index=0) {
  return `<section class="skeleton-stage" aria-label="阶段${index+1}正在规划"><div class="stage-heading">${skeleton('time')}</div><div class="skeleton-cards"><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div></div><div class="skeleton-row">${skeleton('activity')}${skeleton('activity')}</div></section>`;
}
export function scoreMarkup(candidate) {
  if (candidate?.scoreStatus==='pending' || !Number.isFinite(candidate?.fitScore)) return '<small>待评估</small>';
  return `<small>契合分</small><b>${Math.round(candidate.fitScore)}</b>`;
}

/** 卡片节点按地点ID复用，选中与评分更新不改变它在横条中的位置。 */
export function createTimeline({catalog,onScene,onActivities,onMeal,onDeparture,getIntent}) {
  const root=document.querySelector('#stages');
  const scenes=new Map(catalog.scenes.map(s=>[s.id,s]));
  const views=new Map(); let result=null, optimistic=null;
  const activeChoice=index=>optimistic?.index===index?optimistic:getIntent()?.prefix?.[index]||result?.stages[index];
  function setActivityContent(view,scene,ids) {
    if(!scene||view.departure){view.activities.innerHTML='';return;}
    if(scene.kind==='rest'){view.activities.innerHTML='';return;}
    if(!scene.activities.length){view.activities.innerHTML='';return;}
    const diet=getIntent()?.context?.dietaryRestrictions||[];
    const available=scene.activities.filter(a=>(!view.mealRole||!a.mealRoles?.length||a.mealRoles.includes(view.mealRole))&&!(a.dietaryTags||[]).some(t=>diet.includes(t)));
    view.activities.innerHTML=[...new Set(available.map(a=>a.group))].map(group=>{
      const acts=available.filter(a=>a.group===group);
      return `<div class="activity-row">${acts.map(a=>{
        const selected=ids.includes(a.id);
        return `<label class="activity-card${selected?' selected':''}" title="${esc(a.description)}"><input type="checkbox" data-stage="${view.index}" data-scene="${scene.id}" data-activity="${a.id}" ${selected?'checked':''} aria-label="${esc(a.title)}，${esc(a.description)}"><span>${esc(a.title)}</span></label>`;
      }).join('')}</div>`;
    }).join('');
  }
  function createView(index,key) {
    const element=document.createElement('section');element.className='stage';element.dataset.index=index;element.setAttribute('aria-label',`阶段${index+1}`);
    element.innerHTML='<div class="transfer-bar" hidden></div><div class="stage-heading"></div><div class="scene-strip" role="radiogroup"></div><div class="stage-activities"></div><div class="stage-meta"></div>';
    const view={key,index,element,heading:element.querySelector('.stage-heading'),transfer:element.querySelector('.transfer-bar'),strip:element.querySelector('.scene-strip'),activities:element.querySelector('.stage-activities'),meta:element.querySelector('.stage-meta'),cards:new Map(),candidates:new Map(),controller:null,selectedId:null,mealRole:null};
    view.strip.dataset.index=index;view.strip.setAttribute('aria-label',`阶段${index+1}地点`);views.set(key,view);return view;
  }
  function updateCards(view,stage,meal=null) {
    const candidates=new Map((meal?.candidates?.length?meal.candidates:stage.candidates||[]).map(c=>[c.sceneId||c.id,c]));
    if(meal&&!result.ok&&!candidates.size){
      for(const scene of catalog.scenes.filter(s=>s.mealRoles?.includes(meal.mealRole))){
        const ids=mealActivityIds(scene,meal.mealRole),diet=getIntent()?.context?.dietaryRestrictions||[];
        const activity=scene.activities.find(a=>ids.includes(a.id)&&!(a.dietaryTags||[]).some(t=>diet.includes(t)));
        if(activity)candidates.set(scene.id,{sceneId:scene.id,activityIds:[activity.id],fitScore:null,scoreStatus:'pending'});
      }
    }
    if(scenes.has(stage.sceneId)&&!candidates.has(stage.sceneId))candidates.set(stage.sceneId,stage);
    view.candidates=candidates;
    const departureDescriptions={separate:'各自回去，给今天一个轻松的收尾。',walk_together:'一起走一段，再各自返程。',hotel:'今晚留宿，房费按所选城市档位预留。'};
    const ordered=view.departure?(catalog.departures||[]).filter(d=>candidates.has(d.id)).map(d=>({...d,title:d.id==='hotel'?'酒店':d.title,description:departureDescriptions[d.id]})):catalog.scenes.filter(s=>candidates.has(s.id)&&(!view.mealRole||s.mealRoles?.includes(view.mealRole)));
    const special=specialFor(view.mealRole);if(special)ordered.push(special);
    const keep=new Set(ordered.map(s=>s.id));
    for(const [id,card]of view.cards)if(!keep.has(id)){card.remove();view.cards.delete(id);}
    ordered.forEach((scene,index)=>{
      let card=view.cards.get(scene.id);
      if(!card){card=document.createElement('div');card.className='scene-card';card.dataset.scene=scene.id;card.dataset.stage=view.index;card.tabIndex=0;card.setAttribute('role','radio');card.innerHTML='<span class="scene-score"></span><h3 class="scene-title"></h3><p class="scene-desc"></p>';view.cards.set(scene.id,card);}
      card.dataset.stage=view.index;card.dataset.view=view.key;
      if(view.mealRole)card.dataset.meal=view.mealRole;else delete card.dataset.meal;
      if(view.departure)card.dataset.departure=scene.id;else delete card.dataset.departure;
      card.classList.toggle('meal-card',!!view.mealRole);
      const c=candidates.get(scene.id),isSpecial=scene===special||view.departure;card.querySelector('.scene-title').textContent=scene.title;card.querySelector('.scene-desc').textContent=cardDescription(scene);card.title=scene.description||'';
      card.querySelector('.scene-score').hidden=isSpecial;card.querySelector('.scene-score').innerHTML=isSpecial?'':scoreMarkup(c);card.querySelector('.scene-score').classList.remove('is-pending');card.classList.remove('is-pending');
      card.setAttribute('aria-label',isSpecial?scene.title:`${scene.title}，${Number.isFinite(c?.fitScore)?`方案契合分${Math.round(c.fitScore)}`:'完整后续待评估'}，点击选择`);
      const at=view.strip.children[index];if(at!==card)view.strip.insertBefore(card,at||null);
    });
    const previous=view.selectedId;view.selectedId=stage.sceneId;
    if(!view.controller)view.controller=attachCarousel(view.strip,{selectedId:stage.sceneId});
    else{view.controller.update({selectedId:stage.sceneId});syncCarousel(view.strip);if(previous!==stage.sceneId)centerCard(view.strip,stage.sceneId,{smooth:true});}
  }
  function render(nextResult) {
    result=nextResult;optimistic=null;
    const focus=document.activeElement,focusData=focus?.dataset?.stage!==undefined?{...focus.dataset}:null;
    root.querySelectorAll('.skeleton-stage').forEach(el=>el.remove());
    const meals=new Map((result.mealRequirements||[]).map(m=>[m.mealRole,m]));
    const entries=result.stages.map((stage,index)=>({stage,index,key:stage.mealRole?`meal-${stage.mealRole}`:`stage-${index}`,meal:meals.get(stage.mealRole),time:stage.startMinute}));
    for(const meal of meals.values())if(meal.choiceMode!=='together'||!result.ok){
      const special=specialFor(meal.mealRole),selected=meal.choiceMode==='together'?meal.sceneId:special?.id;
      entries.push({stage:{sceneId:selected,activityIds:meal.activityIds||[],startMinute:meal.targetMinute,endMinute:meal.targetMinute,transfer:0,mealRole:meal.mealRole,virtualMeal:true},index:meal.insertIndex||0,key:`meal-${meal.mealRole}`,meal,time:meal.targetMinute});
    }
    const departure=result.departure;
    if(departure){
      const end=departure.endMinute??getIntent().context.windows.at(-1).endMinute,start=departure.startMinute??end-departure.minutes;
      entries.push({stage:{sceneId:departure.id,activityIds:[],startMinute:start,endMinute:end,transfer:0,departure:true,candidates:departure.candidates},index:result.stages.length,key:'departure',time:start});
    }
    entries.sort((a,b)=>a.time-b.time||Number(Boolean(b.stage.virtualMeal))-Number(Boolean(a.stage.virtualMeal)));
    const keys=new Set(entries.map(e=>e.key));
    for(const [key,view]of views)if(!keys.has(key)){view.controller?.destroy();view.element.remove();views.delete(key);}
    entries.forEach(({stage,index,key,meal})=>{
      const scene=scenes.get(stage.sceneId),view=views.get(key)||createView(index,key);
      view.index=index;view.mealRole=stage.mealRole||null;view.departure=!!stage.departure;view.element.dataset.index=index;view.strip.dataset.index=index;
      view.element.classList.toggle('departure-stage',view.departure);view.element.setAttribute('aria-label',view.departure?'分别方式':meal?meal.label:`阶段${index+1}`);
      view.element.classList.toggle('meal-stage',!!view.mealRole);view.strip.setAttribute('aria-label',view.departure?'分别方式':meal?`${meal.label}地点`:`阶段${index+1}地点`);
      root.append(view.element);
      view.element.classList.remove('is-recomputing');view.element.removeAttribute('aria-busy');
      const start=stage.start??stage.startMinute,end=stage.end??stage.endMinute;
      view.heading.innerHTML=`<h2 class="stage-time">${formatTime(start)}${stage.virtualMeal?'':`-${formatTime(end)}`}</h2>`;
      view.transfer.hidden=!stage.transfer;
      view.transfer.innerHTML=`<span>${formatTime(start-(stage.transfer||0))}-${formatTime(start)}</span><span>转场</span>`;
      updateCards(view,stage,meal);setActivityContent(view,scene,stage.activityIds);
      view.meta.innerHTML='';view.meta.hidden=true;
    });
    root.setAttribute('aria-busy','false');
    if(focusData?.activity){const el=root.querySelector(`input[data-stage="${focusData.stage}"][data-activity="${CSS.escape(focusData.activity)}"]`);el?.focus({preventScroll:true});}
  }
  function pending({fromStage=0,choice=null,mealChoice=null,departureChoice=null}={}) {
    const focused=document.activeElement,focusData=focused?.dataset?.activity?{...focused.dataset}:null;
    optimistic=choice;
    root.setAttribute('aria-busy','true');
    if(!result){root.innerHTML=[0,1].map(skeletonStage).join('');return;}
    for(const view of views.values()){
      const i=view.index;
      if(i<fromStage)continue;
      view.element.classList.add('is-recomputing');view.element.setAttribute('aria-busy','true');
      const ownClockKnown=choice&&i===choice.index&&result.stages[i]?.sceneId===choice.sceneId;
      if(!ownClockKnown){
        view.heading.querySelector('.stage-time').innerHTML=skeleton('time');
        if(!view.transfer.hidden)view.transfer.innerHTML=`<span>${skeleton('time')}</span><span>转场</span>`;
      }
      view.cards.forEach(card=>{card.classList.add('is-pending');card.querySelector('.scene-score').classList.add('is-pending');card.querySelector('.scene-score').innerHTML=skeleton('badge');});
      view.meta.innerHTML=skeleton('line');
      if(departureChoice&&view.departure){view.selectedId=departureChoice;view.controller.update({selectedId:departureChoice});centerCard(view.strip,departureChoice,{smooth:true});view.activities.innerHTML='';}
      else if(mealChoice&&view.mealRole===mealChoice.role){
        const selected=mealChoice.choice,scene=scenes.get(selected.sceneId),id=scene?.id||specialFor(view.mealRole)?.id;
        view.selectedId=id;view.controller.update({selectedId:id});centerCard(view.strip,id,{smooth:true});setActivityContent(view,scene,selected.activityIds||[]);
      }
      else if(choice&&i===choice.index&&!view.mealRole){const scene=scenes.get(choice.sceneId);view.selectedId=scene.id;view.controller.update({selectedId:scene.id});centerCard(view.strip,scene.id,{smooth:true});setActivityContent(view,scene,choice.activityIds);}
      else view.activities.innerHTML=`<div class="skeleton-row">${skeleton('activity')}${skeleton('activity')}</div>`;
    }
    if(focusData){root.querySelector(`input[data-stage="${focusData.stage}"][data-activity="${CSS.escape(focusData.activity)}"]`)?.focus({preventScroll:true});}
  }
  root.addEventListener('click',event=>{
    const card=event.target.closest('.scene-card');if(!card||card.dataset.dragged==='1')return;
    const view=views.get(card.dataset.view);if(!view)return;
    const index=view.index,chosen=activeChoice(index),candidate=view.candidates.get(card.dataset.scene);
    if(view.departure){onDeparture(card.dataset.departure);return;}
    if(view.mealRole){
      const scene=scenes.get(card.dataset.scene);
      const current=getIntent()?.context?.mealChoices?.[view.mealRole]||result.stages.find(s=>s.mealRole===view.mealRole);
      const choice=resolveMealCardChoice(view.mealRole,card.dataset.scene,{scene,current,candidate});
      onMeal(view.mealRole,choice,{fromStage:index});return;
    }
    onScene(index,card.dataset.scene,chosen?.sceneId===card.dataset.scene?chosen.activityIds:candidate?.activityIds||scenes.get(card.dataset.scene).default||[]);
  });
  root.addEventListener('change',event=>{
    const input=event.target.closest('input[data-activity]');if(!input)return;
    const view=views.get(input.closest('.stage').querySelector('.scene-card').dataset.view);if(!view)return;
    const index=Number(input.dataset.stage);
    const selected=view.mealRole?getIntent()?.context?.mealChoices?.[view.mealRole]||result.stages[index]:activeChoice(index),ids=selected?.sceneId===input.dataset.scene?selected.activityIds:[];
    if(view.mealRole){onMeal(view.mealRole,{sceneId:input.dataset.scene,activityIds:toggleActivity(scenes.get(input.dataset.scene),ids,input.dataset.activity)},{fromStage:index});return;}
    onActivities(index,input.dataset.scene,toggleActivity(scenes.get(input.dataset.scene),ids,input.dataset.activity));
  });
  return {render,pending,dispose:()=>views.forEach(v=>v.controller?.destroy())};
}
