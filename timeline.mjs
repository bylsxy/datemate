import {attachCarousel,centerCard,syncCarousel} from './carousel.mjs';
import {escapeHTML as esc,formatTime,costLabel,toggleActivity} from './planner.mjs';

const skeleton = (kind='line') => `<span class="skeleton skeleton-${kind}" aria-hidden="true"></span>`;
export function skeletonStage(index=0) {
  return `<section class="skeleton-stage" aria-label="阶段${index+1}正在规划"><div class="stage-heading">${skeleton('number')}${skeleton('line')}${skeleton('time')}</div><div class="skeleton-cards"><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div></div><div class="skeleton-row">${skeleton('activity')}${skeleton('activity')}</div></section>`;
}
export function scoreMarkup(candidate) {
  if (candidate?.scoreStatus==='pending' || !Number.isFinite(candidate?.fitScore)) return '<small>待评估</small>';
  return `<small>契合分</small><b>${Math.round(candidate.fitScore)}</b>`;
}

/** 卡片节点按地点ID复用，选中与评分更新不改变它在横条中的位置。 */
export function createTimeline({catalog,onScene,onActivities,onEnd,getIntent}) {
  const root=document.querySelector('#stages');
  const scenes=new Map(catalog.scenes.map(s=>[s.id,s]));
  const views=new Map(); let result=null, loadingFrom=null, optimistic=null;
  const activeChoice=index=>optimistic?.index===index?optimistic:getIntent()?.prefix?.[index]||result?.stages[index];
  function setActivityContent(view,scene,ids) {
    if(scene.kind==='rest'){view.activities.innerHTML='';return;}
    if(!scene.activities.length){view.activities.innerHTML='';return;}
    view.activities.innerHTML=[...new Set(scene.activities.map(a=>a.group))].map(group=>{
      const acts=scene.activities.filter(a=>a.group===group),single=acts[0].mode==='single';
      return `<div class="activity-row">${acts.map(a=>{
        const selected=ids.includes(a.id);
        return `<label class="activity-card${selected?' selected':''}" title="${esc(a.description)}"><input type="checkbox" data-stage="${view.index}" data-scene="${scene.id}" data-activity="${a.id}" ${selected?'checked':''} aria-label="${esc(a.title)}，${esc(a.description)}"><span>${esc(a.title)}</span></label>`;
      }).join('')}</div>`;
    }).join('');
  }
  function createView(index) {
    const element=document.createElement('section');element.className='stage';element.dataset.index=index;element.setAttribute('aria-label',`阶段${index+1}`);
    element.innerHTML='<div class="transfer-bar" hidden></div><div class="stage-heading"></div><div class="scene-strip" role="radiogroup"></div><div class="stage-activities"></div><div class="stage-meta"></div>';
    const view={index,element,heading:element.querySelector('.stage-heading'),transfer:element.querySelector('.transfer-bar'),strip:element.querySelector('.scene-strip'),activities:element.querySelector('.stage-activities'),meta:element.querySelector('.stage-meta'),cards:new Map(),candidates:new Map(),controller:null,selectedId:null};
    view.strip.dataset.index=index;view.strip.setAttribute('aria-label',`阶段${index+1}地点`);views.set(index,view);return view;
  }
  function updateCards(view,stage) {
    const candidates=new Map((stage.candidates||[]).map(c=>[c.sceneId,c]));
    if(!candidates.has(stage.sceneId))candidates.set(stage.sceneId,stage);
    view.candidates=candidates;
    const ordered=catalog.scenes.filter(s=>candidates.has(s.id));
    for(const [id,card]of view.cards)if(!candidates.has(id)){card.remove();view.cards.delete(id);}
    ordered.forEach((scene,index)=>{
      let card=view.cards.get(scene.id);
      if(!card){card=document.createElement('div');card.className='scene-card';card.dataset.scene=scene.id;card.dataset.stage=view.index;card.tabIndex=0;card.setAttribute('role','radio');card.innerHTML='<span class="scene-score"></span><h3 class="scene-title"></h3><p class="scene-desc"></p>';view.cards.set(scene.id,card);}
      const c=candidates.get(scene.id);card.querySelector('.scene-title').textContent=scene.title;card.querySelector('.scene-desc').textContent=scene.description;
      card.querySelector('.scene-score').innerHTML=scoreMarkup(c);card.querySelector('.scene-score').classList.remove('is-pending');card.classList.remove('is-pending');
      card.setAttribute('aria-label',`${scene.title}，${Number.isFinite(c.fitScore)?`方案契合分${Math.round(c.fitScore)}`:'完整后续待评估'}，点击选择`);
      const at=view.strip.children[index];if(at!==card)view.strip.insertBefore(card,at||null);
    });
    const previous=view.selectedId;view.selectedId=stage.sceneId;
    if(!view.controller)view.controller=attachCarousel(view.strip,{selectedId:stage.sceneId});
    else{view.controller.update({selectedId:stage.sceneId});syncCarousel(view.strip);if(previous!==stage.sceneId)centerCard(view.strip,stage.sceneId,{smooth:true});}
  }
  function render(nextResult) {
    result=nextResult;loadingFrom=null;optimistic=null;
    const focus=document.activeElement,focusData=focus?.dataset?.stage!==undefined?{...focus.dataset}:null;
    root.querySelectorAll('.skeleton-stage').forEach(el=>el.remove());
    for(const [i,view]of views)if(i>=result.stages.length){view.controller?.destroy();view.element.remove();views.delete(i);}
    result.stages.forEach((stage,index)=>{
      const scene=scenes.get(stage.sceneId),view=views.get(index)||createView(index);
      if(view.element.parentNode!==root)root.append(view.element);
      view.element.classList.remove('is-recomputing');view.element.removeAttribute('aria-busy');
      const start=stage.start??stage.startMinute,end=stage.end??stage.endMinute;
      view.heading.innerHTML=`<h2 class="stage-time">${formatTime(start)}-${formatTime(end)}</h2>`;
      view.transfer.hidden=!stage.transfer;
      view.transfer.innerHTML=`<span>${formatTime(start-(stage.transfer||0))}-${formatTime(start)}</span><span>转场</span>`;
      updateCards(view,stage);setActivityContent(view,scene,stage.activityIds);
      view.meta.innerHTML='';view.meta.hidden=true;
    });
    root.setAttribute('aria-busy','false');
    if(focusData?.activity){const el=root.querySelector(`input[data-stage="${focusData.stage}"][data-activity="${CSS.escape(focusData.activity)}"]`);el?.focus({preventScroll:true});}
  }
  function pending({fromStage=0,choice=null}={}) {
    const focused=document.activeElement,focusData=focused?.dataset?.activity?{...focused.dataset}:null;
    loadingFrom=fromStage;optimistic=choice;
    root.setAttribute('aria-busy','true');
    if(!result){root.innerHTML=[0,1].map(skeletonStage).join('');return;}
    for(const [i,view]of views){
      if(i<fromStage)continue;
      view.element.classList.add('is-recomputing');view.element.setAttribute('aria-busy','true');
      const ownClockKnown=choice&&i===choice.index&&result.stages[i]?.sceneId===choice.sceneId;
      if(!ownClockKnown){
        view.heading.querySelector('.stage-time').innerHTML=skeleton('time');
        if(!view.transfer.hidden)view.transfer.innerHTML=`<span>${skeleton('time')}</span><span>转场</span>`;
      }
      view.cards.forEach(card=>{card.classList.add('is-pending');card.querySelector('.scene-score').classList.add('is-pending');card.querySelector('.scene-score').innerHTML=skeleton('badge');});
      view.meta.innerHTML=skeleton('line');
      if(choice&&i===choice.index){const scene=scenes.get(choice.sceneId);view.selectedId=scene.id;view.controller.update({selectedId:scene.id});centerCard(view.strip,scene.id,{smooth:true});setActivityContent(view,scene,choice.activityIds);}
      else view.activities.innerHTML=`<div class="skeleton-row">${skeleton('activity')}${skeleton('activity')}</div>`;
    }
    if(focusData){root.querySelector(`input[data-stage="${focusData.stage}"][data-activity="${CSS.escape(focusData.activity)}"]`)?.focus({preventScroll:true});}
  }
  function allowed(index){return loadingFrom===null||(optimistic&&index===optimistic.index);}
  root.addEventListener('click',event=>{
    const end=event.target.closest('[data-end]');if(end&&loadingFrom===null){onEnd(Number(end.dataset.end));return;}
    const card=event.target.closest('.scene-card');if(!card||card.dataset.dragged==='1')return;
    const index=Number(card.dataset.stage);if(!allowed(index))return;
    const chosen=activeChoice(index),candidate=views.get(index)?.candidates.get(card.dataset.scene);
    onScene(index,card.dataset.scene,chosen?.sceneId===card.dataset.scene?chosen.activityIds:candidate?.activityIds||scenes.get(card.dataset.scene).default||[]);
  });
  root.addEventListener('change',event=>{
    const input=event.target.closest('input[data-activity]');if(!input)return;
    const index=Number(input.dataset.stage);if(!allowed(index))return;
    const selected=activeChoice(index),ids=selected?.sceneId===input.dataset.scene?selected.activityIds:[];
    onActivities(index,input.dataset.scene,toggleActivity(scenes.get(input.dataset.scene),ids,input.dataset.activity));
  });
  return {render,pending,dispose:()=>views.forEach(v=>v.controller?.destroy())};
}
