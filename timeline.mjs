import {attachCarousel,centerCard,syncCarousel} from './carousel.mjs?v=1d081a6265958465';
import {escapeHTML as esc,formatTime,toggleActivity} from './planner.mjs?v=1d081a6265958465';

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
export function scoreMarkup(candidate,{planningFailed=false}={}) {
  if (!planningFailed&&candidate?.scoreStatus==='pending') return '<span class="candidate-spinner" aria-hidden="true"></span><span class="sr-only">后续验证中</span>';
  if (planningFailed||candidate?.scoreStatus==='unresolved'||candidate?.scoreStatus==='error'||!Number.isFinite(candidate?.fitScore)) return '<b>—</b>';
  return `<small>契合分</small><b>${Math.round(candidate.fitScore)}</b>`;
}

/** 卡片按地点 ID 复用；保留阶段按稳定 view.key 关联，只有后续推荐允许重排。 */
export function createTimeline({catalog,onScene,onActivities,onMeal,onDeparture,getIntent,onCandidateVisible}) {
  const root=document.querySelector('#stages');
  const window=root.ownerDocument.defaultView;
  const scenes=new Map(catalog.scenes.map(s=>[s.id,s]));
  const views=new Map(); let result=null, optimistic=null, pendingPreserveThrough=-1, pendingPreservation=null;
  function preservationThrough(preserveThrough,preserveKey){
    const byElement=new Map([...views.values()].map(view=>[view.element,view]));
    const ordered=[...root.children].map(element=>byElement.get(element)).filter(Boolean);
    const boundary=preserveKey!=null?ordered.findIndex(view=>view.key===preserveKey):-1;
    const kept=preserveKey!=null?(boundary<0?[]:ordered.slice(0,boundary+1)):ordered.filter(view=>view.index<=preserveThrough);
    return {keys:kept.map(view=>view.key),key:kept.at(-1)?.key??null};
  }
  const activeChoice=index=>optimistic?.index===index?optimistic:getIntent()?.prefix?.[index]||result?.stages[index];
  function centerSelection(view,smooth){view.strip.classList.remove('is-preserving-scroll');if(smooth)deferSortUntilStill(view);syncCarousel(view.strip);centerCard(view.strip,view.selectedId,{smooth});}
  function updateScore(view,card,candidate) {
    const score=card.querySelector('.scene-score'),title=card.querySelector('.scene-title').textContent;
    if(score.hidden)return;
    const failed=result?.ok===false,pending=!failed&&candidate?.scoreStatus==='pending';
    score.innerHTML=scoreMarkup(candidate,{planningFailed:failed});
    score.classList.toggle('is-validating',pending);
    const description=failed?'当前条件未生成可行方案，请先调整条件':pending?'完整后续正在验证':candidate?.scoreStatus==='error'?'后台验证异常':candidate?.scoreStatus==='unresolved'||candidate?.evaluationStatus==='bounded_no_continuation_found'?'本次搜索未找到完整后续':Number.isFinite(candidate?.fitScore)?`方案契合分${Math.round(candidate.fitScore)}`:'暂无契合分';
    card.setAttribute('aria-label',`${title}，${description}，点击选择`);
    // badge 不接收指针事件；tooltip 同时放在可交互的整张卡片上。
    score.title=failed?'当前条件未生成可行方案，请先调整条件后重新规划。':pending?'正在后台验证该选项的完整后续。':candidate?.scoreStatus==='error'?'后台验证异常，本轮验证已停止；可以点击尝试重新规划。':candidate?.scoreStatus==='unresolved'||candidate?.evaluationStatus==='bounded_no_continuation_found'?'本次有限搜索已结束，未找到完整后续；可以点击尝试重新规划。':Number.isFinite(candidate?.fitScore)?'':'暂无契合分；可以点击尝试重新规划。';
    card.title=[scenes.get(card.dataset.scene)?.description||card.querySelector('.scene-desc').textContent,score.title].filter(Boolean).join('\n');
  }
  function stopVisibility(view) {
    view.visibility?.dispose();view.visibility=null;
    if(view.sortFrame)window.cancelAnimationFrame(view.sortFrame);
    if(view.scrollTimer!=null)window.clearTimeout(view.scrollTimer);
    view.scrollTimer=null;
    view.sortFrame=0;view.needsSort=false;
  }
  function watchVisibility(view) {
    // render 已清理旧轮资源；重新接入可见检测不能清掉刚启动的居中滚动等待。
    view.visibility?.dispose();view.visibility=null;
    if(typeof onCandidateVisible!=='function'||view.departure||result?.ok===false)return;
    const notified=new Set();let stopped=false,frame=0,observer=null;
    function visibleBounds() {
      const bounds=view.strip.getBoundingClientRect(),viewport=window.visualViewport;
      const left=viewport?.offsetLeft||0,top=viewport?.offsetTop||0;
      const width=viewport?.width??(root.ownerDocument.documentElement.clientWidth||window.innerWidth);
      const height=viewport?.height??(root.ownerDocument.documentElement.clientHeight||window.innerHeight);
      const clip={left:Math.max(bounds.left,left),right:Math.min(bounds.right,left+width),top:Math.max(bounds.top,top),bottom:Math.min(bounds.bottom,top+height)};
      return bounds.width>0&&bounds.height>0&&clip.right>clip.left&&clip.bottom>clip.top?clip:null;
    }
    function notify(card,clip=visibleBounds()) {
      const sceneId=card.dataset.scene;
      if(stopped||view.element.classList.contains('is-recomputing')||card.querySelector('.scene-score').hidden||view.candidates.get(sceneId)?.scoreStatus!=='pending'||notified.has(sceneId))return;
      if(!clip)return;
      const rect=card.getBoundingClientRect();
      if(rect.width<=0||rect.height<=0||rect.right<=clip.left||rect.left>=clip.right||rect.bottom<=clip.top||rect.top>=clip.bottom)return;
      // 每轮每张卡只通知一次；先登记，允许回调同步更新评分。
      notified.add(sceneId);
      onCandidateVisible({stageIndex:view.index,viewKey:view.key,sceneId,...(view.mealRole?{mealRole:view.mealRole}:{})});
    }
    function scan() {
      frame=0;if(stopped)return;
      const clip=visibleBounds();if(!clip)return;
      for(const card of view.cards.values())notify(card,clip);
    }
    const queue=()=>{if(!stopped&&!frame)frame=window.requestAnimationFrame(scan);};
    if(window.IntersectionObserver){
      observer=new window.IntersectionObserver(entries=>{
        for(const entry of entries)if(entry.isIntersecting&&entry.intersectionRect.width>0&&entry.intersectionRect.height>0)notify(entry.target);
      },{root:view.strip,threshold:0});
      for(const card of view.cards.values())observer.observe(card);
    }
    // 显式 root 的 IO 不保证纵向滚入屏幕时再次回调；两条路径都补页面滚动扫描。
    view.strip.addEventListener('scroll',queue,{passive:true});
    window.addEventListener('scroll',queue,{passive:true,capture:true});
    window.addEventListener('resize',queue,{passive:true});
    window.visualViewport?.addEventListener('scroll',queue,{passive:true});
    window.visualViewport?.addEventListener('resize',queue,{passive:true});
    queue();
    view.visibility={queue,dispose(){stopped=true;observer?.disconnect();if(frame)window.cancelAnimationFrame(frame);view.strip.removeEventListener('scroll',queue);window.removeEventListener('scroll',queue,true);window.removeEventListener('resize',queue);window.visualViewport?.removeEventListener('scroll',queue);window.visualViewport?.removeEventListener('resize',queue);}};
  }
  function deferSortUntilStill(view) {
    if(view.scrollTimer!=null)window.clearTimeout(view.scrollTimer);
    // 每次原生滚动续期；徽标和可见提优继续，只推迟 DOM 重排。
    view.scrollTimer=window.setTimeout(()=>{
      view.scrollTimer=null;
      if(view.needsSort)queueCandidateSort(view);
    },120);
  }
  function queueCandidateSort(view) {
    // 探索排序由引擎决定，后台补分不能用 q 覆盖已经生成的探索顺序。
    if(view.orderLocked||getIntent()?.exploration>0)return;
    view.needsSort=true;
    if(view.sortFrame||view.scrollTimer!=null)return;
    view.sortFrame=window.requestAnimationFrame(()=>{
      view.sortFrame=0;
      if(view.orderLocked||getIntent()?.exploration>0){view.needsSort=false;return;}
      if(view.scrollTimer!=null||view.strip.classList.contains('is-dragging')||view.activePointers.size)return;
      view.needsSort=false;
      const cards=[...view.strip.children],bounds=view.strip.getBoundingClientRect(),viewport=window.visualViewport;
      const viewportLeft=viewport?.offsetLeft||0,viewportTop=viewport?.offsetTop||0;
      const viewportWidth=viewport?.width??(root.ownerDocument.documentElement.clientWidth||window.innerWidth);
      const viewportHeight=viewport?.height??(root.ownerDocument.documentElement.clientHeight||window.innerHeight);
      const clip={left:Math.max(bounds.left,viewportLeft),right:Math.min(bounds.right,viewportLeft+viewportWidth),top:Math.max(bounds.top,viewportTop),bottom:Math.min(bounds.bottom,viewportTop+viewportHeight)};
      const visible=clip.right>clip.left&&clip.bottom>clip.top?cards.filter(card=>{const rect=card.getBoundingClientRect();return rect.width>0&&rect.height>0&&rect.right>clip.left&&rect.left<clip.right&&rect.bottom>clip.top&&rect.top<clip.bottom;}):[];
      const focus=root.ownerDocument.activeElement,focusCard=focus?.closest?.('.scene-card')||focus;
      const focused=cards.includes(focusCard)?focusCard:null,center=(bounds.left+bounds.right)/2;
      // 键盘浏览优先保住屏幕内焦点；屏幕外焦点不能拉动用户正在看的横条。
      const anchor=visible.includes(focused)?focused:visible.reduce((best,card)=>{
        const rect=card.getBoundingClientRect(),distance=Math.abs((rect.left+rect.right)/2-center);
        return !best||distance<best.distance?{card,distance}:best;
      },null)?.card;
      const offset=anchor?.offsetLeft,scroll=view.strip.scrollLeft;
      const rank=card=>{const c=view.candidates.get(card.dataset.scene);return c?.scoreStatus==='evaluated'&&Number.isFinite(c.q)?c.q:-Infinity;};
      // 同分保留现有顺序；虚拟选择始终排在真实候选之后。
      const ordered=[...cards].sort((a,b)=>Number(!view.candidates.has(a.dataset.scene))-Number(!view.candidates.has(b.dataset.scene))||(rank(b)>rank(a)?1:rank(b)<rank(a)?-1:0));
      if(ordered.every((card,index)=>card===cards[index]))return;
      // 当前焦点卡不搬动，其余节点围绕它移动，避免 DOM 移动丢失焦点。
      // 重排会触发浏览器重新吸附；直到下一次用户滚动意图才恢复 snap，避免覆盖补偿。
      view.strip.classList.add('is-preserving-scroll');
      if(focused){
        const pivot=ordered.indexOf(focused);
        for(let i=0;i<pivot;i++)view.strip.insertBefore(ordered[i],focused);
        for(let i=pivot+1;i<ordered.length;i++)view.strip.append(ordered[i]);
      }else ordered.forEach((card,index)=>{if(view.strip.children[index]!==card)view.strip.insertBefore(card,view.strip.children[index]||null);});
      if(anchor)view.strip.scrollLeft=scroll+anchor.offsetLeft-offset;
      syncCarousel(view.strip);
    });
  }
  /** 只更新已有卡片。可传稳定 viewKey，用餐必须提供 mealRole；调用方过滤旧轮结果。 */
  function updateCandidate({stageIndex,viewKey,sceneId,mealRole,candidate}={}) {
    const view=views.get(viewKey??(mealRole?`meal-${mealRole}`:`stage-${stageIndex}`));
    if(!view||view.index!==stageIndex||view.departure||view.mealRole!==(mealRole||null)||!candidate||typeof candidate!=='object'||view.element.classList.contains('is-recomputing'))return false;
    const card=view.cards.get(sceneId),previous=view.candidates.get(sceneId);
    if(!card||!previous||card.querySelector('.scene-score').hidden||(candidate.sceneId!=null&&candidate.sceneId!==sceneId)||(candidate.id!=null&&candidate.id!==sceneId))return false;
    const next={...previous,...candidate};view.candidates.set(sceneId,next);
    card.dataset.validationPriority=String(!!next.validation?.visiblePriority);
    if(next.validation?.computeMs!=null)card.dataset.validationMs=String(next.validation.computeMs);else delete card.dataset.validationMs;
    if(next.validation?.attempts!=null)card.dataset.validationAttempts=String(next.validation.attempts);else delete card.dataset.validationAttempts;
    updateScore(view,card,next);
    view.visibility?.queue();
    if(result?.ok!==false)queueCandidateSort(view);
    return true;
  }
  /** 含冻结列表中被新 candidates 截断的待验证卡；返回副本，不修改 base result。 */
  function getPendingCandidates(){
    const pending=[];
    for(const view of views.values()){
      if(view.departure)continue;
      for(const [sceneId,candidate]of view.candidates){
        const card=view.cards.get(sceneId);
        if(candidate.scoreStatus!=='pending'||!card||card.querySelector('.scene-score').hidden)continue;
        pending.push({stageIndex:view.index,viewKey:view.key,sceneId,...(view.mealRole?{mealRole:view.mealRole}:{}),candidate:structuredClone(candidate),...(view.entry?.stage.scoreReference!=null?{reference:structuredClone(view.entry.stage.scoreReference)}:{})});
      }
    }
    return pending;
  }
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
    view.activePointers=new Set();view.sortFrame=0;view.needsSort=false;view.scrollTimer=null;
    const releaseSnap=event=>{if(event?.type==='keydown'&&!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;view.strip.classList.remove('is-preserving-scroll');deferSortUntilStill(view);};
    const scrolling=()=>deferSortUntilStill(view);
    const down=event=>{releaseSnap();view.activePointers.add(event.pointerId);};
    const up=event=>{view.activePointers.delete(event.pointerId);if(view.needsSort&&!view.activePointers.size)queueCandidateSort(view);};
    view.strip.addEventListener('pointerdown',down,{passive:true});
    view.strip.addEventListener('wheel',releaseSnap,{passive:true});
    // 捕获导航意图，覆盖 smooth 开始后首个 scroll 事件尚未派发的间隙。
    view.strip.addEventListener('keydown',releaseSnap,true);
    view.strip.addEventListener('scroll',scrolling,{passive:true});
    window.addEventListener('pointerup',up);window.addEventListener('pointercancel',up);
    const blur=()=>{view.activePointers.clear();if(view.needsSort)queueCandidateSort(view);};
    window.addEventListener('blur',blur);
    view.dispose=()=>{stopVisibility(view);view.strip.classList.remove('is-preserving-scroll');view.strip.removeEventListener('pointerdown',down);view.strip.removeEventListener('wheel',releaseSnap);view.strip.removeEventListener('keydown',releaseSnap,true);view.strip.removeEventListener('scroll',scrolling);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',up);window.removeEventListener('blur',blur);view.controller?.destroy();};
    view.strip.dataset.index=index;view.strip.setAttribute('aria-label',`阶段${index+1}地点`);views.set(key,view);return view;
  }
  function updateCards(view,stage,meal=null,{preserve=false,center=false}={}) {
    const incoming=new Map((meal?.candidates?.length?meal.candidates:stage.candidates||[]).map(c=>[c.sceneId||c.id,c]));
    // 新一轮候选可能截断；保留视图必须继续展示用户已经刷到的全部卡片。
    const candidates=preserve?new Map([...view.candidates,...incoming]):incoming;
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
    let ordered=view.departure?(catalog.departures||[]).filter(d=>candidates.has(d.id)).map(d=>({...d,title:d.id==='hotel'?'酒店':d.title,description:departureDescriptions[d.id]})):[...candidates.keys()].map(id=>scenes.get(id)).filter(s=>s&&(!view.mealRole||s.mealRoles?.includes(view.mealRole)));
    const special=specialFor(view.mealRole);if(special)ordered.push(special);
    if(preserve){
      const byId=new Map(ordered.map(scene=>[scene.id,scene]));
      ordered=[...view.strip.children].map(card=>byId.get(card.dataset.scene)).filter(Boolean);
      const existing=new Set(ordered.map(scene=>scene.id));
      ordered.push(...[...byId.values()].filter(scene=>!existing.has(scene.id)));
    }
    const keep=new Set(ordered.map(s=>s.id));
    for(const [id,card]of view.cards)if(!keep.has(id)){card.remove();view.cards.delete(id);}
    ordered.forEach((scene,index)=>{
      let card=view.cards.get(scene.id);
      if(!card){card=document.createElement('div');card.className='scene-card';card.dataset.scene=scene.id;card.dataset.stage=view.index;card.tabIndex=0;card.setAttribute('role','radio');card.innerHTML='<span class="scene-score"></span><h3 class="scene-title"></h3><p class="scene-desc"></p>';view.cards.set(scene.id,card);}
      card.dataset.stage=view.index;card.dataset.view=view.key;
      delete card.dataset.validationPriority;delete card.dataset.validationMs;delete card.dataset.validationAttempts;
      if(view.mealRole)card.dataset.meal=view.mealRole;else delete card.dataset.meal;
      if(view.departure)card.dataset.departure=scene.id;else delete card.dataset.departure;
      card.classList.toggle('meal-card',!!view.mealRole);
      const c=candidates.get(scene.id),isSpecial=scene===special||view.departure;card.querySelector('.scene-title').textContent=scene.title;card.querySelector('.scene-desc').textContent=cardDescription(scene);card.title=scene.description||'';
      card.querySelector('.scene-score').hidden=isSpecial;card.querySelector('.scene-score').classList.remove('is-pending','is-validating');card.classList.remove('is-pending');
      if(isSpecial){card.querySelector('.scene-score').innerHTML='';card.querySelector('.scene-score').title='';card.setAttribute('aria-label',scene.title);}
      else updateScore(view,card,c);
      const at=view.strip.children[index];if(at!==card)view.strip.insertBefore(card,at||null);
    });
    view.selectedId=stage.sceneId;
    if(!view.controller)view.controller=attachCarousel(view.strip,{selectedId:stage.sceneId});
    else view.controller.update({selectedId:stage.sceneId});
    syncCarousel(view.strip);
    if(center)centerSelection(view,true);
  }
  function updateStageContent(view,stage){
    const start=stage.start??stage.startMinute,end=stage.end??stage.endMinute;
    view.heading.innerHTML=`<h2 class="stage-time">${formatTime(start)}${stage.virtualMeal?'':`-${formatTime(end)}`}</h2>`;
    view.transfer.hidden=!stage.transfer;
    view.transfer.innerHTML=`<span>${formatTime(start-(stage.transfer||0))}-${formatTime(start)}</span><span>转场</span>`;
    setActivityContent(view,scenes.get(stage.sceneId),stage.activityIds||[]);
    view.meta.innerHTML='';view.meta.hidden=true;
  }
  function sameStageContent(previous,next){
    if(!previous||previous.sceneId!==next.sceneId)return false;
    const ids=previous.activityIds||[],nextIds=next.activityIds||[];
    return ids.length===nextIds.length&&ids.every((id,index)=>id===nextIds[index])&&
      (previous.start??previous.startMinute)===(next.start??next.startMinute)&&
      (previous.end??previous.endMinute)===(next.end??next.endMinute)&&
      ['fixedStartMinute','fixedEndMinute','mealRole'].every(key=>previous[key]===next[key])&&
      (previous.transfer||0)===(next.transfer||0)&&!!previous.virtualMeal===!!next.virtualMeal&&!!previous.departure===!!next.departure;
  }
  /** preserveKey 按现有 DOM 截到当前视图；未传沿用 pending，preserveThrough:-1 解除保留。 */
  function render(nextResult,{preserveThrough=pendingPreserveThrough,preserveKey}={}) {
    // 必须在 index 更新前冻结范围；虚拟用餐变为真实阶段时索引可能改变。
    const retention=preserveThrough<0?{keys:[],key:null}:pendingPreservation&&preserveThrough===pendingPreserveThrough&&(preserveKey==null||preserveKey===pendingPreservation.key)?pendingPreservation:preservationThrough(preserveThrough,preserveKey);
    const preserved=new Map(retention.keys.filter(key=>views.has(key)).map(key=>[key,{view:views.get(key),full:key!==retention.key}]));
    views.forEach(stopVisibility);
    result=nextResult;optimistic=null;pendingPreserveThrough=-1;pendingPreservation=null;
    const focus=document.activeElement,focusView=[...views.values()].find(view=>view.element.contains(focus));
    const focusData=focus?.dataset?.activity?{...focus.dataset,viewKey:focusView?.key}:null;
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
    for(const [key,{view}]of preserved){
      const at=entries.findIndex(entry=>entry.key===key);
      if(at<0)entries.push(view.entry);
    }
    // 前段节点保持原来相对位置，后续再按新结果排列。
    const prefix=[...root.children].map(element=>[...preserved.values()].find(({view})=>view.element===element)?.view.entry?.key).filter(Boolean);
    const byKey=new Map(entries.map(entry=>[entry.key,entry]));
    const orderedEntries=[...prefix.map(key=>byKey.get(key)),...entries.filter(entry=>!preserved.has(entry.key))];
    const keys=new Set(orderedEntries.map(e=>e.key));
    for(const [key,view]of views)if(!keys.has(key)){view.dispose();view.element.remove();views.delete(key);}
    orderedEntries.forEach((entry,position)=>{
      const {stage,index,key,meal}=entry;
      const view=views.get(key)||createView(index,key);
      const retention=preserved.get(key),wasSelected=view.selectedId;
      const contentUnchanged=sameStageContent(view.entry?.stage,stage)&&wasSelected===stage.sceneId&&!view.element.classList.contains('is-recomputing');
      view.orderLocked=!!retention;view.entry=entry;
      view.index=index;view.mealRole=stage.mealRole||null;view.departure=!!stage.departure;view.element.dataset.index=index;view.strip.dataset.index=index;
      view.element.classList.toggle('departure-stage',view.departure);view.element.setAttribute('aria-label',view.departure?'分别方式':meal?meal.label:`阶段${index+1}`);
      view.element.classList.toggle('meal-stage',!!view.mealRole);view.strip.setAttribute('aria-label',view.departure?'分别方式':meal?`${meal.label}地点`:`阶段${index+1}地点`);
      if(root.children[position]!==view.element)root.insertBefore(view.element,root.children[position]||null);
      view.element.classList.remove('is-recomputing');view.element.removeAttribute('aria-busy');
      if(retention?.full&&contentUnchanged){
        // 只有真实内容一致时保留前段节点；事件索引跟随稳定 key 对应的新阶段。
        for(const card of view.cards.values())card.dataset.stage=index;
        for(const input of view.activities.querySelectorAll('input[data-activity]'))input.dataset.stage=index;
        watchVisibility(view);return;
      }
      updateCards(view,stage,meal,{preserve:!!retention,center:!retention?.full&&wasSelected!==stage.sceneId});updateStageContent(view,stage);
      watchVisibility(view);
    });
    root.setAttribute('aria-busy','false');
    if(focusData?.activity){const el=views.get(focusData.viewKey)?.activities.querySelector(`input[data-scene="${CSS.escape(focusData.scene)}"][data-activity="${CSS.escape(focusData.activity)}"]`);el?.focus({preventScroll:true});}
  }
  function pending({fromStage=0,choice=null,mealChoice=null,departureChoice=null,preserveThrough=choice||mealChoice?fromStage:-1,preserveKey}={}) {
    const focused=document.activeElement,focusData=focused?.dataset?.activity?{...focused.dataset}:null;
    const focusView=[...views.values()].find(view=>view.element.contains(focused));
    pendingPreserveThrough=preserveThrough;
    pendingPreservation=preserveThrough<0?{keys:[],key:null}:preservationThrough(preserveThrough,preserveKey);
    const preservedKeys=new Set(pendingPreservation.keys);
    optimistic=choice;
    root.setAttribute('aria-busy','true');
    if(!result){root.innerHTML=[0,1].map(skeletonStage).join('');return;}
    for(const view of views.values()){
      const i=view.index;
      view.orderLocked=preservedKeys.has(view.key);
      if(view.orderLocked)stopVisibility(view);
      // 连续选到原先的后续阶段时，不能把上一轮骨架锁成前段内容。
      if(view.orderLocked&&view.element.classList.contains('is-recomputing')&&view.entry){
        updateCards(view,view.entry.stage,view.entry.meal,{preserve:true});updateStageContent(view,view.entry.stage);
      }
      // 当前选择立即生效；保留范围不换成骨架，也不等 worker 回来才更新活动。
      if(departureChoice&&view.departure){view.selectedId=departureChoice;view.controller.update({selectedId:departureChoice});centerSelection(view,true);view.activities.innerHTML='';}
      else if(mealChoice&&view.mealRole===mealChoice.role){
        const selected=mealChoice.choice,scene=scenes.get(selected.sceneId),id=scene?.id||specialFor(view.mealRole)?.id;
        view.selectedId=id;view.controller.update({selectedId:id});centerSelection(view,true);setActivityContent(view,scene,selected.activityIds||[]);
      }
      else if(choice&&i===choice.index&&!view.mealRole&&!view.departure){const scene=scenes.get(choice.sceneId);if(scene){view.selectedId=scene.id;view.controller.update({selectedId:scene.id});centerSelection(view,true);setActivityContent(view,scene,choice.activityIds||[]);}}
      const selected=mealChoice&&view.mealRole===mealChoice.role?mealChoice.choice:choice&&i===choice.index&&!view.mealRole&&!view.departure?choice:null;
      if(selected&&view.entry)view.entry={...view.entry,stage:{...view.entry.stage,sceneId:view.selectedId,activityIds:[...(selected.activityIds||[])]}};
      if(view.orderLocked){view.element.classList.remove('is-recomputing');view.element.removeAttribute('aria-busy');continue;}
      if(preserveKey==null&&i<fromStage)continue;
      stopVisibility(view);
      view.element.classList.add('is-recomputing');view.element.setAttribute('aria-busy','true');
      const ownClockKnown=choice&&i===choice.index&&result.stages[i]?.sceneId===choice.sceneId;
      if(!ownClockKnown){
        view.heading.querySelector('.stage-time').innerHTML=skeleton('time');
        if(!view.transfer.hidden)view.transfer.innerHTML=`<span>${skeleton('time')}</span><span>转场</span>`;
      }
      view.cards.forEach(card=>{card.classList.add('is-pending');card.querySelector('.scene-score').classList.remove('is-validating');card.querySelector('.scene-score').classList.add('is-pending');card.querySelector('.scene-score').innerHTML=skeleton('badge');});
      view.meta.innerHTML=skeleton('line');
      if(!(departureChoice&&view.departure)&&!(mealChoice&&view.mealRole===mealChoice.role)&&!(choice&&i===choice.index&&!view.mealRole&&!view.departure))view.activities.innerHTML=`<div class="skeleton-row">${skeleton('activity')}${skeleton('activity')}</div>`;
    }
    if(focusData){focusView?.activities.querySelector(`input[data-scene="${CSS.escape(focusData.scene)}"][data-activity="${CSS.escape(focusData.activity)}"]`)?.focus({preventScroll:true});}
  }
  function lockThrough(view){for(const key of preservationThrough(view.index,view.key).keys){const previous=views.get(key);previous.orderLocked=true;stopVisibility(previous);}}
  root.addEventListener('click',event=>{
    const card=event.target.closest('.scene-card');if(!card||card.dataset.dragged==='1')return;
    const view=views.get(card.dataset.view);if(!view)return;
    lockThrough(view);
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
    lockThrough(view);
    const index=Number(input.dataset.stage);
    const selected=view.mealRole?getIntent()?.context?.mealChoices?.[view.mealRole]||result.stages[index]:activeChoice(index),ids=selected?.sceneId===input.dataset.scene?selected.activityIds:[];
    if(view.mealRole){onMeal(view.mealRole,{sceneId:input.dataset.scene,activityIds:toggleActivity(scenes.get(input.dataset.scene),ids,input.dataset.activity)},{fromStage:index});return;}
    onActivities(index,input.dataset.scene,toggleActivity(scenes.get(input.dataset.scene),ids,input.dataset.activity));
  });
  return {render,pending,updateCandidate,getPendingCandidates,recenter:()=>views.forEach(v=>centerSelection(v,false)),dispose:()=>views.forEach(v=>v.dispose())};
}
