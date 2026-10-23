import {catalog,rules,graph,sources,evidence} from './data/catalog.mjs?v=43ea07b0521b5869';
import {createTimeline} from './timeline.mjs?v=43ea07b0521b5869';
import {buildActionJobs,candidateKey} from './candidate-validation.mjs?v=43ea07b0521b5869';
import {createReasonView} from './reasons-view.mjs?v=43ea07b0521b5869';
import {defaultPreparationResources,planPreparations} from './preparation.mjs?v=43ea07b0521b5869';
import {createPlacePicker} from './place-picker.mjs?v=43ea07b0521b5869';
import {createLibraryView} from './library-view.mjs?v=43ea07b0521b5869';
import {createSchoolScopeControls,normalizeUIScope,isSceneInUIScope,filterUIResult,filterUIGraph,filterScopedMealChoices} from './scope-ui.mjs?v=43ea07b0521b5869';
import {dietaryOptions} from './data/activities.mjs?v=43ea07b0521b5869';
import * as reasoning from './reasoning.mjs?v=43ea07b0521b5869';
import {normalizePeriods} from './time-periods.mjs?v=43ea07b0521b5869';
import {escapeHTML as esc,interestLabels,defaultContext,validateReplay,excludedKeywordIds} from './planner.mjs?v=43ea07b0521b5869';
import {selectStageIntent,selectMealIntent,selectDepartureIntent,exploreIntent,setStageDurationIntent,splitStageIntent,mergeStageIntent,restartIntent,updateContextIntent} from './planning-intent.mjs?v=43ea07b0521b5869';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const sceneById=new Map(catalog.scenes.map(s=>[s.id,s]));
const activityById=new Map(catalog.activities.map(a=>[a.id,a]));
const resourceLabelById=new Map((graph.nodes||[]).filter(n=>n.type==='resource').map(n=>[n.id.replace(/^resource:/,''),n.label]));
const preparationDefaults=defaultPreparationResources(catalog);
const newContext=()=>normalizeUIScope({...defaultContext(),school:'',campusArea:'',...structuredClone(preparationDefaults)});
let state={context:newContext(),exploration:0,prefix:[]}, result=null, sequence=0, busy=false, pending=null, active=null, lastElapsed=0, sliderTimer, conditionTimer, conditionsValid=true;
const clone=x=>structuredClone(x);
const createWorker=()=>new Worker(new URL('./worker.mjs?v=43ea07b0521b5869',import.meta.url),{type:'module'});
const worker=createWorker();
let validationWorker=null,validationGeneration=null,validationJobs=new Map();
const timeline=createTimeline({catalog,onScene:commitStage,onActivities:commitStage,onMeal:commitMeal,onDeparture:commitDeparture,onDuration:commitDuration,onSplit:commitSplit,onMerge:commitMerge,getIntent:snapshot,onCandidateVisible:prioritizeCandidate,onActionsChanged:startValidation});
const placePicker=createPlacePicker({root:$('.place-choice'),scenes:catalog.scenes,onChange:applyConditions});
const scopeControls=createSchoolScopeControls($('#conditions-form'));
const reasonView=createReasonView({container:$('#reason-content'),scenes:catalog.scenes,rules});
const libraryView=createLibraryView({container:$('#library-content'),catalog,sources,evidence,rules});

const ATLAS_STORAGE_KEY='datemate_atlas_v1';
const FEATURED_SCENE_META={
  scau_orchid_firefly:{badge:'时段与天气限定',clue:'华农校内 · 晴朗天气 · 傍晚 18:00–20:00 开放窗口',preset:'scau_firefly'},
  faculty_rooftop_stars:{badge:'夜间限定',clue:'晚间 19:00 至次日 06:00 开放 · 晴天或待确认天气',preset:'zero_budget'},
  campus_picnic:{badge:'图谱物资联动',clue:'需先在【泰山超市】完成【采购一份野餐包】（provides → requires）',preset:'scau_firefly'},
  scau_arboretum_day:{badge:'华农限定',clue:'华农校内 · 白天 08:00–17:30 · 晴天自然观察与人像'},
  quiet_confession_corner:{badge:'情境专属',clue:'傍晚 16:00–21:00 · 晴天 · 适合准备表白与安静交流'},
  photo_printing:{badge:'图谱前序联动',clue:'需先完成含【共同拍照 (photo_pair)】的前序活动（follows 边）'},
  dream_balloon_trip:{badge:'探索度 100 限定',clue:'将探索度滑块拉至 100 开启梦幻模式，且活动范围不限',preset:'dream_100'},
  dream_island_day:{badge:'探索度 100 限定',clue:'探索度 100 梦幻模式专属全天跨城海岛线',preset:'dream_100'},
  dream_concert_trip:{badge:'探索度 100 限定',clue:'探索度 100 梦幻模式 · 晚间演出行程',preset:'dream_100'},
  seaside_sunrise:{badge:'跨午夜/黎明限定',clue:'需先完成海边去程，在清晨窗口衔接日出观察'},
  astronomy_session:{badge:'夜间观星限定',clue:'晚间至凌晨窗口开放 · 适合安静与自然偏好'},
  open_air_cinema:{badge:'晚间限定',clue:'晚间时段开放 · 晴朗或干爽天气下的露天放映'},
  cross_district_day:{badge:'半日探索',clue:'下午连续时段 · 适合高探索度或纪念日跨区漫游',preset:'dream_100'},
  campus_exam_short_meet:{badge:'时期规则触发',clue:'时期选择【临考】时由 R-exam-campus-short 规则优先推荐',preset:'exam_short'}
};
let unlockedAtlas={scenes:new Set(),activities:new Set()};
let currentAtlasFilter='featured';
let toastTimer=null;
function loadAtlasState(){
  try{
    const raw=localStorage.getItem(ATLAS_STORAGE_KEY);
    if(raw){
      const parsed=JSON.parse(raw);
      unlockedAtlas.scenes=new Set(Array.isArray(parsed.scenes)?parsed.scenes:[]);
      unlockedAtlas.activities=new Set(Array.isArray(parsed.activities)?parsed.activities:[]);
    }
  }catch{}
}
function saveAtlasState(){
  try{
    localStorage.setItem(ATLAS_STORAGE_KEY,JSON.stringify({scenes:[...unlockedAtlas.scenes],activities:[...unlockedAtlas.activities]}));
  }catch{}
}
loadAtlasState();

function updateAtlasCounters(){
  const total=catalog.scenes.length+catalog.activities.length;
  const count=unlockedAtlas.scenes.size+unlockedAtlas.activities.size;
  const h=$('#header-atlas-count');if(h)h.textContent=`${count} / ${total}`;
  const i=$('#inline-atlas-count');if(i)i.textContent=`${count}/${total}`;
}
function fmtWindow(w){
  const f=m=>`${String(Math.floor((m%1440)/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
  return `${f(w.startMinute)}–${w.endMinute===1440?'24:00':f(w.endMinute)}`;
}
function sceneClueText(scene){
  if(FEATURED_SCENE_META[scene.id]?.clue)return FEATURED_SCENE_META[scene.id].clue;
  const parts=[];
  if(scene.scauOnly)parts.push(scene.place?.campusArea==='taishan'?'华农泰山区专属':'华农校内专属');
  if(scene.dreamOnly)parts.push('探索度 = 100（梦幻模式）');
  if(scene.dailyWindows?.length&&!(scene.dailyWindows.length===1&&scene.dailyWindows[0].startMinute===0&&scene.dailyWindows[0].endMinute===1440)){
    parts.push(`开放时段 ${scene.dailyWindows.map(fmtWindow).join(' / ')}`);
  }
  const reqs=[...(scene.requires||[]),...(scene.preconditions||[])];
  if(reqs.length)parts.push(`前置条件：${reqs.map(r=>resourceLabelById.get(r)||r).join('、')}`);
  if(scene.weather?.length===1&&scene.weather[0]==='clear')parts.push('仅限晴天');
  return parts.join(' · ')||'常规条件即可在对应时段匹配';
}
function recordPlanUnlocks(r){
  if(!r?.ok||!Array.isArray(r.stages))return;
  let newlyFeatured=null;
  for(const stage of r.stages){
    if(stage.sceneId){
      const wasUnlocked=unlockedAtlas.scenes.has(stage.sceneId);
      unlockedAtlas.scenes.add(stage.sceneId);
      if(!wasUnlocked&&FEATURED_SCENE_META[stage.sceneId]&&!newlyFeatured){
        newlyFeatured={scene:sceneById.get(stage.sceneId),meta:FEATURED_SCENE_META[stage.sceneId],fit:stage.fitScore};
      }
    }
    for(const aid of stage.activityIds||[])unlockedAtlas.activities.add(aid);
  }
  saveAtlasState();
  updateAtlasCounters();
  if(newlyFeatured?.scene)showUnlockToast(newlyFeatured.scene,newlyFeatured.meta,newlyFeatured.fit);
}
function showUnlockToast(scene,meta,fit){
  const toast=$('#unlock-toast');if(!toast)return;
  $('#unlock-toast-title').textContent=`${scene.title}（${meta.badge}）`;
  $('#unlock-toast-desc').textContent=`${meta.clue}${Number.isFinite(fit)?` · 本次契合度 ${fit}`:''}`;
  toast.hidden=false;
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>{toast.hidden=true;},6500);
}
function renderAtlasView(){
  const summaryEl=$('#atlas-summary'),gridEl=$('#atlas-grid');
  if(!summaryEl||!gridEl)return;
  const total=catalog.scenes.length+catalog.activities.length;
  const unlockedTotal=unlockedAtlas.scenes.size+unlockedAtlas.activities.size;
  const scauScenes=catalog.scenes.filter(s=>s.scauOnly);
  const scauUnlocked=scauScenes.filter(s=>unlockedAtlas.scenes.has(s.id)).length;
  summaryEl.innerHTML=[
    ['已点亮总计',`${unlockedTotal} / ${total}`],
    ['场景图鉴',`${unlockedAtlas.scenes.size} / ${catalog.scenes.length}`],
    ['活动图鉴',`${unlockedAtlas.activities.size} / ${catalog.activities.length}`],
    ['华农专属地点',`${scauUnlocked} / ${scauScenes.length}`]
  ].map(([label,val])=>`<div class="stat-tile"><strong>${esc(val)}</strong><span>${esc(label)}</span></div>`).join('');

  let items=[];
  if(currentAtlasFilter==='featured'){
    items=catalog.scenes.filter(s=>FEATURED_SCENE_META[s.id]||s.dreamOnly||s.scauOnly).map(s=>({kind:'scene',item:s}));
  }else if(currentAtlasFilter==='scau'){
    items=catalog.scenes.filter(s=>s.scauOnly).map(s=>({kind:'scene',item:s}));
  }else if(currentAtlasFilter==='linked'){
    const linkedScenes=catalog.scenes.filter(s=>(s.requires?.length||s.provides?.length||s.predecessorIds?.length||s.activities?.some(a=>a.requires?.length||a.provides?.length||a.predecessorIds?.length)));
    items=linkedScenes.map(s=>({kind:'scene',item:s}));
  }else if(currentAtlasFilter==='scenes'){
    items=catalog.scenes.map(s=>({kind:'scene',item:s}));
  }else{
    items=catalog.activities.map(a=>({kind:'activity',item:a}));
  }

  gridEl.innerHTML=items.map(({kind,item})=>{
    const isScene=kind==='scene';
    const unlocked=isScene?unlockedAtlas.scenes.has(item.id):unlockedAtlas.activities.has(item.id);
    const meta=isScene?FEATURED_SCENE_META[item.id]:null;
    const badge=meta?.badge||(isScene?(item.dreamOnly?'探索度 100':item.scauOnly?(item.place?.campusArea==='taishan'?'华农泰山区':'华农校内'):'常规场景'):'可选活动');
    const cost=item.cost?`¥${item.cost[0]}–${item.cost[1]}`:'';
    const duration=isScene&&item.minutes?`${item.minutes} 分钟`:'场景内活动';
    const clue=isScene?sceneClueText(item):((item.requires?.length||item.provides?.length)?`图谱关联：${[...(item.requires||[]).map(r=>`需 ${resourceLabelById.get(r)||r}`),...(item.provides||[]).map(r=>`产出 ${resourceLabelById.get(r)||r}`)].join(' · ')}`:'挂载于对应场景卡内勾选触发');
    const presetAttr=meta?.preset?`<button type="button" class="atlas-try-btn" data-try-preset="${esc(meta.preset)}">载入此情境</button>`:'';
    return `<article class="atlas-card${unlocked?' is-unlocked':' is-locked'}">
      <div class="atlas-card-top">
        <span class="atlas-badge">${esc(badge)}</span>
        <span class="atlas-status">${unlocked?'● 已点亮':'○ 待探索'}</span>
      </div>
      <h3 class="atlas-title">${esc(item.title)}</h3>
      <p class="atlas-desc">${esc(unlocked?item.description:`尚未在当前行程中点亮。可通过下方知识图谱条件线索触发该${isScene?'场景':'活动'}。`)}</p>
      <div class="atlas-clue"><strong>图谱线索：</strong>${esc(clue)}</div>
      <div class="atlas-footer">
        <span>${esc(duration)} · ${esc(cost)}</span>
        ${presetAttr}
      </div>
    </article>`;
  }).join('');
}

function updateConditionsSummary(){
  const pillsEl=$('#conditions-summary-pills'),ctaEl=$('.conditions-summary-cta'),detailsEl=$('#conditions');
  if(!pillsEl)return;
  const c=state.context||{};
  const slotNames={morning:'上午',afternoon:'下午',evening:'晚上',night:'夜晚'};
  const slots=(c.periodIds||['afternoon']).map(id=>slotNames[id]||id).join('+');
  const areaNames={all:'范围不限',near:'校内及周边',campus:c.school==='scau'?(c.campusArea==='taishan'?'华农泰山区':'华农校内'):'校内'};
  const weatherNames={clear:'晴天',cloudy:'阴天',rain:'雨天',unknown:'阴天'};
  const parts=[slots,areaNames[c.area]||'校内及周边',weatherNames[c.weather]||'阴天'];
  if(c.budget!==null&&c.budget!==undefined)parts.push(`预算 ≤ ¥${c.budget}`);
  if(c.fatigueA>=6||c.fatigueB>=6)parts.push('疲惫恢复');
  if(c.season==='exam')parts.push('临考短会');
  if(c.occasion==='confession')parts.push('准备表白');
  else if(c.occasion==='anniversary')parts.push('纪念日');
  pillsEl.textContent=parts.join(' · ');
  if(ctaEl&&detailsEl)ctaEl.textContent=detailsEl.open?'收起参数':'展开 18 项参数';
}

function stopValidation(){validationWorker?.terminate();validationWorker=null;validationGeneration=null;validationJobs.clear();}
function prioritizeCandidate(choice){
  const key=choice.actionKey||choice.key||candidateKey(choice);
  if(validationWorker&&validationGeneration===sequence&&validationJobs.has(key))validationWorker.postMessage({type:'prioritize',key});
}
function startValidation(){
  stopValidation();
  const jobs=buildActionJobs(result,state,catalog,timeline.getPendingActions());if(!jobs.length)return;
  validationGeneration=sequence;validationJobs=new Map(jobs.map(job=>[job.key,job]));
  const currentWorker=createWorker();validationWorker=currentWorker;
  currentWorker.onmessage=({data})=>{
    // 旧线程和旧轮次都不能把评分写入新条件；基准规划输出始终保持不可变。
    if(currentWorker!==validationWorker||data.type!=='candidate'||data.generation!==sequence||data.generation!==validationGeneration||!validationJobs.has(data.key))return;
    timeline.updateActionValidation(data);validationJobs.delete(data.key);
    if(!validationJobs.size)stopValidation();
  };
  currentWorker.onerror=()=>{
    if(currentWorker!==validationWorker)return;
    for(const job of validationJobs.values())timeline.updateActionValidation({...job,validationStatus:'error',candidate:{...job.candidate,scoreStatus:'error',fitScore:null,evaluationStatus:'validation_error'}});
    stopValidation();
  };
  currentWorker.postMessage({type:'validate',generation:sequence,jobs});
  currentWorker.postMessage({type:'pauseValidation',paused:document.hidden||$('#view-plan').hidden});
  timeline.refreshVisibleCandidates();
}
document.addEventListener('visibilitychange',()=>{validationWorker?.postMessage({type:'pauseValidation',paused:document.hidden||$('#view-plan').hidden});if(!document.hidden)timeline.refreshVisibleCandidates();});
window.addEventListener('pagehide',stopValidation);
let graphRequest=0;
let scopedGraph=graph;
function revealError(element){
  if($('#view-plan').hidden)showView('plan');
  requestAnimationFrame(()=>element.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'}));
}
function note(text,error=false){$('#status').textContent=text;$('#status').classList.toggle('error',error);$('#status').classList.toggle('sr-only',!error);if(error)revealError($('#status'));}
function planningError(r,context){
  const errors=(r?.errors||[]).join(' '),departure=catalog.departures?.find(d=>d.id===context.departureChoice);
  const unavailable=(context.requiredSceneIds||[]).map(id=>sceneById.get(id)).filter(scene=>scene&&!isSceneInUIScope(scene,context));
  if(unavailable.length)return `${unavailable.map(scene=>scene.title).join('、')}在这个时段或范围不可用，请调整条件或移除必去。`;
  const departureHigh=(departure?.costByCityTier?.[context.cityTier]||departure?.cost||[0,0])[1];
  if(errors.includes('H_BUDGET')||(context.budget!==null&&departureHigh>context.budget))return '所选活动和分别方式超出当前预算，可以调整预算、取消活动或改选分别方式。';
  if(errors.includes('H_PREPARATION')||errors.includes('H_PREDECESSOR'))return '这项玩法还缺前序活动产生的物品或成果，请先安排前面的活动。';
  if(errors.includes('H_REQUIRED'))return '当前条件无法满足全部必去地点，请调整时段或减少必去地点。';
  if(errors.includes('H_FATIGUE'))return '这项玩法接上去会太累，先休息一段或换个轻松的选择。';
  if(errors.includes('H_SCENE_HOURS'))return '所选地点在这个时间不允许安排，请换一个开放地点或调整时段。';
  return '当前条件还没有可行安排，请调整条件或用餐选择。';
}
function snapshot(){return clone(pending?.next || active?.next || state);}
function displayedIntent(){
  const current=snapshot(),exploration=Number($('#exploration').value);
  // 提交表单时立即承接滑块草稿，不等待130ms防抖完成。
  return exploration===current.exploration?current:exploreIntent(current,exploration,crypto.getRandomValues(new Uint32Array(1))[0],catalog);
}
function dispatch(job){busy=true;active=job;worker.postMessage({id:job.id,state:job.next,search:job.search,knownPlan:job.knownPlan,selectionMode:job.selectionMode});}
function compute(next,message='安排已更新。横滑找灵感，点击才会选择。',{expectedDigest=null,search=null,selectionMode=search?.selectionMode??'utility_best',knownPlan=null,fromStage=0,choice=null,mealChoice=null,departureChoice=null,preserveThrough=-1,preserveKey=null}={}){
  next={...next,context:normalizeUIScope(next.context)};
  const id=++sequence;stopValidation();timeline.pending({fromStage,choice,mealChoice,departureChoice,preserveThrough,preserveKey});pendingPanels();$('#export').disabled=true;note('正在考虑后续安排…');
  return new Promise(resolve=>{const job={id,next:clone(next),message,expectedDigest,search:clone(search),selectionMode,knownPlan:clone(knownPlan),preserveThrough,preserveKey,resolve};if(busy){pending?.resolve(null);pending=job;}else dispatch(job);});
}
worker.onmessage=({data})=>{
  const job=active;busy=false;active=null;
  if(job&&job.id===data.id){
    if(data.id===sequence){
      const r=data.result?filterUIResult(data.result,catalog.scenes,job.next.context):data.result;
      if(data.error||!r?.ok){
        if(result?.ok&&(job.preserveThrough>=0||job.expectedDigest)){
          render(job);syncControls();note(`${planningError(r,job.next.context)} 已保留原安排。`,true);
        }else{
          state=job.next;
          const mealRequirements=normalizePeriods(state.context.periodIds,state.context.mealChoices).mealRequirements;
          result={...(r||{}),ok:false,stages:[],mealRequirements:r?.mealRequirements||mealRequirements};
          const chooseBreakfast=state.context.periodIds?.includes('morning')&&!state.context.mealChoices?.breakfast;
          render(job);note(chooseBreakfast?'先选一下早餐怎么安排，再继续调整后面的行程。':planningError(r,state.context),!chooseBreakfast);syncControls();
          if(chooseBreakfast)$('#status').classList.remove('sr-only');
        }
      }
      else if(job.expectedDigest&&r.outputFingerprint!==job.expectedDigest){if(result)render(job);note('复盘输出校验不一致，当前安排保留。',true);syncControls();}
      else{state=job.next;result=r;lastElapsed=data.elapsed;conditionsError();render(job);syncControls();note(job.message);}
      $('#stages').setAttribute('aria-busy','false');$('#export').disabled=!result?.ok;job.resolve(r);
    }else job.resolve(null);
  }
  if(pending){const p=pending;pending=null;dispatch(p);}
  else if(result?.ok&&conditionsValid&&data.id===sequence)startValidation();
};
worker.onerror=event=>{note(`计算线程出错：${event.message}。请刷新后重试。`,true);$('#stages').setAttribute('aria-busy','false');active?.resolve(null);pending?.resolve(null);active=pending=null;busy=false;};
function checked(name){return $$(`input[name="${name}"]:checked`).map(x=>x.value);}
function selectedValue(name,fallback=''){return $(`input[name="${name}"]:checked`)?.value??fallback;}
const contextSelects=['weather','weekPart','relationship','occasion','mood','energy','season','planStyle','mentalDemand','cyclePhase','personalityA','personalityB'];
function paintExploration(value){
  $('#exploration-value').innerHTML=`${value}<small>/ 100</small>`;
  $('#dream-badge').hidden=value!==100;
  $('.exploration').classList.toggle('dream-mode',value===100);
  $('#exploration-note').textContent=value===100?'把今天借给一点不寻常。':'保留已选，为后面找灵感';
}
function readContext({strict=true}={}){
  const c=newContext(),ids=checked('slots'),raw=$('#budget').value;let periods;
  try{periods=normalizePeriods(ids);}catch(error){if(strict)throw error;}
  if(strict&&raw!==''&&(!Number.isFinite(Number(raw))||Number(raw)<0))throw Error('请填写0或更大的有效预算。');
  c.periodIds=periods?.periodIds||ids;c.mealChoices=clone(snapshot().context.mealChoices||{});
  if(periods){c.duration=periods.duration;c.windows=periods.windows;}else{delete c.duration;delete c.windows;}
  c.saving=$('#saving').checked;c.budget=c.saving?50:raw===''?null:Number(raw);
  for(const id of contextSelects)c[id]=$(`#${id}`).value;
  c.reunion=$('#reunion').checked;c.themes=checked('themes');
  Object.assign(c,scopeControls.read());placePicker.setScope(c);c.fatigueA=$('#tired-a').checked?6:2;c.fatigueB=$('#tired-b').checked?6:2;
  c.mealChoices=filterScopedMealChoices(c.mealChoices,catalog.scenes,c);
  c.preferences=[$('#quiet').checked?'quiet':null,$('#indoor').checked?'indoor':null].filter(Boolean);c.quietRequired=false;
  c.crowdAvoidance=$('#crowd').checked;c.robust=c.planStyle==='steady';c.theme='any';c.cityTier=selectedValue('cityTier','tier1');
  c.departureChoice=snapshot().context.departureChoice||'separate';
  if(periods&&periods.endMinute<=1440&&['hotel','camping'].includes(c.departureChoice))c.departureChoice='separate';
  c.preferencesA=checked('preferencesA').filter(Boolean);c.preferencesB=checked('preferencesB').filter(Boolean);c.dietaryRestrictions=checked('diet');
  Object.assign(c,placePicker.getChoices());
  c.placeBans=[...c.bans];
  c.banKeywords=$('#ban-keywords').value.trim();
  c.bans=[...new Set([...c.bans,...excludedKeywordIds(catalog,c.banKeywords)])];
  c.explicitConsentIds=[...(snapshot().context.explicitConsentIds||[])];
  c.explorationSeed=snapshot().context.explorationSeed??0;
  return c;
}
function syncControls(){
  // 用户正在输入的草稿优先，旧计算结果不能在防抖期间把文字擦掉。
  if(conditionTimer!=null||sliderTimer!=null)return;
  const c=state.context=normalizeUIScope(state.context);
  $('#budget').value=c.budget===null?'':c.budget;$('#saving').checked=c.saving===true;$('#budget').disabled=$('#saving').checked;
  for(const id of contextSelects)$(`#${id}`).value=(id==='weather'&&c[id]==='unknown')?'cloudy':c[id]??defaultContext()[id];
  $('#reunion').checked=!!c.reunion;$('#ban-keywords').value=c.banKeywords||'';
  $('#tired-a').checked=c.fatigueA>=6;$('#tired-b').checked=c.fatigueB>=6;
  $('#quiet').checked=c.preferences.includes('quiet');$('#indoor').checked=c.preferences.includes('indoor');
  $('#crowd').checked=c.crowdAvoidance;
  for(const [name,values]of [['preferencesA',c.preferencesA?.length?c.preferencesA:['']],['preferencesB',c.preferencesB?.length?c.preferencesB:['']],['diet',c.dietaryRestrictions],['slots',c.periodIds],['themes',c.themes],['area',[c.area]],['cityTier',[c.cityTier||'tier1']]])$$(`input[name="${name}"]`).forEach(x=>x.checked=(values||[]).includes(x.value));
  scopeControls.set(c);placePicker.setChoices({...c,bans:c.placeBans??c.bans});refreshGraphScope(c);
  $('#exploration').value=state.exploration;paintExploration(state.exploration);
  updateConditionsSummary();
}
function traceText(t){return t.message||t.text||t.title||rules.find(r=>r.id===t.ruleId)?.title||t.rule||'规则已触发';}
function traceHTML(t){const ins=t.inputFacts||[],outs=t.outputFacts||[];return `<div class="trace-item"><span class="trace-id">${esc(t.ruleId||t.id||t.rule||'状态更新')}</span><p>${esc(traceText(t))}</p>${ins.length?`<p>输入：${esc(ins.map(x=>typeof x==='string'?x:JSON.stringify(x)).join('；'))}</p>`:''}${outs.length?`<p>推导：${esc(outs.map(x=>typeof x==='string'?x:JSON.stringify(x)).join('；'))}</p>`:''}</div>`;}
function metricsHTML(m={}){return `<div class="metrics">${[['我方偏好',m.utilityA??m.satisfactionA??m.preferenceA],['对方偏好',m.utilityB??m.satisfactionB??m.preferenceB],['公平指标',m.fairness],['新鲜度',m.novelty],['占用分钟',m.totalMinutes],['终段负担',Math.max(...Object.values(m.predictedLoadByPerson||{}))]].filter(([,v])=>Number.isFinite(v)).map(([k,v])=>`<div class="metric"><span>${k}</span><strong>${Math.round(v*100)/100}</strong></div>`).join('')}</div>`;}
function pendingPanels(){
  reasonView.pending();
  const placeholder='<div class="skeleton-panel" aria-label="正在重新计算"><span class="skeleton skeleton-line"></span><span class="skeleton skeleton-line"></span></div>';
  for(const id of ['ending','reason-content','rule-trace','comparison','search-details']){
    const el=document.getElementById(id);el.setAttribute('aria-busy','true');el.innerHTML=placeholder;
  }
  $('#preparation-items').innerHTML=placeholder;$('#preparation-summary').setAttribute('aria-busy','true');
}
function render({preserveThrough=-1,preserveKey=null}={}){
  $('#weather-note').hidden=!(result.ok&&state.context.weather==='clear'&&result.stages.some(stage=>{const scene=sceneById.get(stage.sceneId);return scene&&!scene.indoor&&!scene.sheltered;}));
  const preparations=result.ok?planPreparations(result.stages,catalog):[];
  $('#preparation-summary').hidden=!preparations.length;
  $('#preparation-summary').setAttribute('aria-busy','false');
  $('#preparation-items').innerHTML=preparations.length?`<div class="preparation-list">${preparations.map(item=>`<span class="preparation-item">${esc(item.label.replace(/^已(?:准备)?|^可用|^一份/g,''))}${item.quantity>1?` × ${esc(item.quantity)}`:''}</span>`).join('')}</div>`:'';
  timeline.render(result,{preserveThrough,preserveKey,centerSelected:true});
  const r=result;
  reasonView.setResult(r,state.context);
  const shareBar=$('#plan-Share-bar');
  if(!r.ok){
    $('#ending').textContent='';$('#ending').hidden=true;
    if(shareBar)shareBar.hidden=true;
    $('#replay-id').textContent='';$('#comparison').textContent='';$('#search-details').textContent='';$('#rule-trace').textContent='';
    for(const id of ['ending','reason-content','rule-trace','comparison','search-details'])document.getElementById(id).setAttribute('aria-busy','false');
    return;
  }
  recordPlanUnlocks(r);
  if(shareBar)shareBar.hidden=false;
  const balance=Math.ceil(r.totalCost[1]);$('#ending').hidden=balance===0;
  $('#ending').innerHTML=balance?`建议<strong>余额 ≥ ${balance} rmb</strong>`:'';
  $('#replay-id').textContent=`输入 ${r.fingerprint} · 输出 ${r.outputFingerprint}`;
  renderReasoning();renderComparison();
  for(const id of ['ending','reason-content','rule-trace','comparison','search-details'])document.getElementById(id).setAttribute('aria-busy','false');
}
async function commitStage(index,sceneId,activityIds,{knownPlan=null}={}){
  if(!result?.ok||!conditionsValid||busy||!knownPlan?.length)return false;
  if(!isSceneInUIScope(sceneById.get(sceneId),snapshot().context))return false;
  clearTimeout(sliderTimer);sliderTimer=null;
  const next=selectStageIntent(snapshot(),result,index,sceneId,activityIds,catalog,{durationMinutes:knownPlan[index]?.durationMinutes});
  const r=await compute(next,'当前及之前阶段的卡片顺序保留，后续安排已更新。',{knownPlan,fromStage:index,choice:{index,sceneId,activityIds},preserveThrough:index,preserveKey:`stage-${index}`});
  return !!r?.ok;
}
async function commitMeal(role,choice,{fromStage=0,knownPlan=null}={}){
  const skipSupper=role==='supper'&&choice.mode==='skip';
  if(!result||!conditionsValid||busy||(result.ok&&!knownPlan?.length&&!skipSupper))return false;
  if(choice.sceneId&&!isSceneInUIScope(sceneById.get(sceneId),snapshot().context))return false;
  clearTimeout(sliderTimer);sliderTimer=null;
  if(choice.sceneId&&knownPlan?.[fromStage]?.sceneId===choice.sceneId&&Number.isInteger(knownPlan[fromStage].durationMinutes))choice={...choice,durationMinutes:knownPlan[fromStage].durationMinutes};
  const next=selectMealIntent(snapshot(),result,role,choice,fromStage,catalog);
  // 取消宵夜只保留之前的选择，不把旧餐段及其后续作为可行证书重带入搜索。
  const r=await compute(next,skipSupper?'已移除宵夜，前后时间已连接并重新规划。':'餐卡顺序保留，后续用餐安排已更新。',{knownPlan:skipSupper?null:knownPlan,fromStage,mealChoice:{role,choice},preserveThrough:skipSupper?fromStage-1:fromStage,...(skipSupper?{}:{preserveKey:`meal-${role}`})});
  return !!r?.ok;
}
async function commitAdjustment(index,next,message,knownPlan){
  if(!result?.ok||!conditionsValid||busy||!knownPlan?.length)return false;
  const stage=result.stages[index];
  const r=await compute(next,message,{knownPlan,fromStage:index,preserveThrough:index,preserveKey:stage.mealRole?`meal-${stage.mealRole}`:`stage-${index}`});
  return !!r?.ok;
}
async function commitDuration(index,minutes,{knownPlan=null}={}){
  if(!result?.ok||busy)return false;
  return commitAdjustment(index,setStageDurationIntent(snapshot(),result,index,minutes,catalog),'停留时间已调整，前面的选择保留。',knownPlan);
}
async function commitSplit(index,{knownPlan=null}={}){
  if(!result?.ok||busy)return false;
  return commitAdjustment(index,splitStageIntent(snapshot(),result,index,catalog),'已拆成两段，可以为后面那段换个安排。',knownPlan);
}
async function commitMerge(index,{knownPlan=null}={}){
  if(!result?.ok||busy)return false;
  return commitAdjustment(index,mergeStageIntent(snapshot(),result,index,catalog),'已合并，保留前一段的地点与活动，后面重新安排。',knownPlan);
}
async function commitDeparture(id,{knownPlan=null}={}){
  if(!result||!conditionsValid||busy||(result.ok&&!knownPlan?.length))return false;
  clearTimeout(sliderTimer);sliderTimer=null;const next=selectDepartureIntent(snapshot(),result,id,catalog);
  const r=await compute(next,'分别方式已更新。',{knownPlan,departureChoice:id,preserveThrough:result.stages.length,preserveKey:'departure'});return !!r?.ok;
}
const nodeById=new Map(graph.nodes.map(n=>[n.id,n]));
const predicates={allows_activity:'可包含',has_feature:'具有特征',supported_by:'依据',from_source:'来自',requires:'需要',provides:'提供',consumes:'消耗',governed_by:'受规则约束',depends_on:'前置依赖',derives:'推导'};
async function graphQuery(){
  const id=++graphRequest;
  $('#graph-paths').innerHTML='<div class="skeleton-panel"><span class="skeleton skeleton-line"></span><span class="skeleton skeleton-line"></span></div>';
  $('#graph-paths').setAttribute('aria-busy','true');
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  if(id!==graphRequest)return;
  const paths=reasoning.queryGraph(scopedGraph,$('#graph-from').value,$('#graph-to').value,{maxDepth:5,maxPaths:6});
  $('#graph-paths').innerHTML=paths.length?paths.map(p=>`<div class="graph-path">${p.nodes.map((id,i)=>`${i?`<span class="graph-edge">${esc(predicates[p.edges[i-1].predicate]||p.edges[i-1].predicate)} →</span>`:''}<span class="graph-node" title="${esc(id)}">${esc(nodeById.get(id)?.label||id)}</span>`).join('')}<p class="field-hint">${p.edges.length} 跳 · 证据 ${esc(p.evidenceIds.join('、'))}</p></div>`).join(''):'<p class="field-hint">在最多5跳的有向图中没有找到路径。请更换起点或终点。</p>';
  $('#graph-paths').setAttribute('aria-busy','false');
}
function renderReasoning(){
  const unique=new Map();for(const t of result.trace||result.stages.flatMap(s=>s.trace||[])){if(!unique.has(t.ruleId||t.rule))unique.set(t.ruleId||t.rule,t);}
  $('#rule-trace').innerHTML=[...unique.values()].map(traceHTML).join('')||'<p class="field-hint">当前条件没有额外触发规则。</p>';
}
function renderComparison(){
  const plans=[{stages:result.stages,metrics:result.metrics,current:true},...(result.paretoPlans||[])];const signatures=new Set();
  $('#comparison').innerHTML=plans.filter(p=>{const k=JSON.stringify(p.stages.map(s=>[s.sceneId,s.activityIds]));if(signatures.has(k))return false;signatures.add(k);return true;}).slice(0,6).map((p,i)=>`<section class="compare-card${p.current?' current':''}"><h3>${p.current?'当前安排':`另一种取舍 ${i}`}</h3><p>${p.stages.map(s=>esc(sceneById.get(s.sceneId)?.title||s.sceneId)).join(' → ')}</p><p>费用上界 ¥${p.metrics.totalCost?.[1]??(p.metrics.totalCostCents?.[1]!==undefined?p.metrics.totalCostCents[1]/100:'—')} · ${p.stages.length} 个阶段</p>${metricsHTML(p.metrics)}<div class="fair-bar" aria-hidden="true"><span style="width:${Math.round((p.metrics.utilityA||0)/((p.metrics.utilityA||0)+(p.metrics.utilityB||0)||1)*100)}%"></span><span style="flex:1"></span></div></section>`).join('');
  const s=result.search||{};$('#search-details').innerHTML=`<p class="method-details">${esc(result.searchStatus||result.status)} · ${s.expandedNodes??result.evaluated} 个展开节点 · ${s.evaluations??s.checkedCandidates??'已记录'} 次候选校验 · ${Math.round(lastElapsed)} ms 本次后台演算。固定搜索配置与稳定排序保证复盘；性能数值仅代表当前设备本次测量。</p><p class="method-details">${esc(JSON.stringify(s))}</p>`;
}
function refreshGraphScope(context){
  scopedGraph=filterUIGraph(graph,catalog.scenes,context);
  const byType={scene:'场景',activity:'活动',feature:'特征',tag:'兴趣',preparation:'准备',rule:'规则',evidence:'证据',source:'来源',condition:'条件'};
  const nodes=[...scopedGraph.nodes].sort((a,b)=>a.type.localeCompare(b.type)||a.label.localeCompare(b.label,'zh'));
  const options=nodes.map(n=>`<option value="${esc(n.id)}">${byType[n.type]||n.type} · ${esc(n.label.slice(0,40))}</option>`).join('');
  for(const [id,fallback] of [['graph-from','mall'],['graph-to','tag:play']]){
    const select=$(`#${id}`),previous=select.value;select.innerHTML=options;
    select.value=nodes.some(n=>n.id===previous)?previous:nodes.some(n=>n.id===fallback)?fallback:nodes[0]?.id||'';
  }
  graphQuery();
}
function initializeKnowledge(){
  const types=['INTJ','INTP','ENTJ','ENTP','INFJ','INFP','ENFJ','ENFP','ISTJ','ISFJ','ESTJ','ESFJ','ISTP','ISFP','ESTP','ESFP'];
  for(const id of ['personalityA','personalityB'])$(`#${id}`).innerHTML='<option value="">不填写</option>'+types.map(type=>`<option value="${type}">${type}</option>`).join('');
  const dietaryContainer=$('input[name="diet"]').closest('.choices');
  dietaryContainer.innerHTML=dietaryOptions.map(x=>`<label class="choice"><input name="diet" type="checkbox" value="${esc(x.id)}">${esc(x.label)}</label>`).join('');
  const interests=[['户外',['nature','exercise','photo']],['体验',['culture','play','creative','learning']],['氛围',['romantic','music','quiet','indoor']],['日常',['food','daily']]];
  for(const p of ['a','b']){
    const name=`preferences${p.toUpperCase()}`;
    $(`#preferences-${p}`).innerHTML=`<label class="choice interest-any"><input type="checkbox" name="${name}" value="" checked>随意</label>`+interests.map(([title,ids])=>`<div class="interest-group"><span class="interest-group-label">${title}</span><div class="choices">${ids.map(id=>`<label class="choice"><input type="checkbox" name="${name}" value="${id}">${interestLabels[id]}</label>`).join('')}</div></div>`).join('');
  }
  const counts=[['场景',catalog.scenes.length],['活动',catalog.activities.length],['规则',rules.length],['图谱边',graph.edges.length]];
$('#knowledge-summary').innerHTML=counts.map(([l,n])=>`<div class="stat-tile"><strong>${n}</strong><span>${l}</span></div>`).join('');
  const adopted=sources.filter(s=>s.adoptedEvidenceIds?.length);$('#source-audit').innerHTML=`<p class="field-hint">${sources.length}份本地语料登记 · ${adopted.length}份来源形成采用证据 · ${evidence.length}条原创摘要。关键词候选经过局部核对后才能成为证据，模型参数单独标为设计值。</p>`+adopted.map(s=>`<div class="source-item"><strong>${esc(s.title)}</strong><br>${esc(s.category)} · ${s.adoptedEvidenceIds.length}条证据 · SHA-256 ${s.sha256.slice(0,14)}…<br>本地文本已定位；现实信息与作品归属需回源核实。</div>`).join('');
  $('#conditions').open=false;
  updateAtlasCounters();
}
$('#conditions').addEventListener('toggle',updateConditionsSummary);
$('#conditions-form').addEventListener('submit',ev=>{ev.preventDefault();applyConditions({restart:true});});
function conditionsError(message=''){
  conditionsValid=!message;
  const error=$('#condition-error');error.textContent=message;error.hidden=!message;
  $('#stages').hidden=!!message;$('#ending').hidden=!!message||!result?.ok||result.totalCost?.[1]===0;$('#view-plan .explanation').hidden=!!message;
  if(message)$('#preparation-summary').hidden=true;
  $('#exploration').disabled=!!message;
  if(message){++sequence;stopValidation();pending?.resolve(null);pending=null;$('#export').disabled=true;note('');$('#conditions').open=true;revealError(error);}
}
async function applyConditions({restart=false}={}){
  clearTimeout(sliderTimer);sliderTimer=null;clearTimeout(conditionTimer);conditionTimer=null;
  try{const updated=updateContextIntent(displayedIntent(),readContext()),next=restart?restartIntent(updated.next,crypto.getRandomValues(new Uint32Array(1))[0]):updated.next;const reset=restart||updated.hardChanged;conditionsError();await compute(next,restart?'已按当前条件重新择优规划。':updated.hardChanged?'条件已更新。':'偏好已更新，你选好的安排保留。',{preserveThrough:reset?-1:next.prefix.length-1,knownPlan:reset?null:result?.continuationWitness,selectionMode:next.exploration>0?'seeded_exploration':'utility_best'});}
  catch(e){conditionsError(e.message.replace(/^H_[A-Z_]+:\s*/,''));}
}
$('#conditions-form').addEventListener('change',ev=>{
  if(ev.target.closest('.place-choice'))return;
  if(['area','school','campusArea'].includes(ev.target.name)){
    const scope=readContext({strict:false});placePicker.setScope(scope);refreshGraphScope(scope);
  }
  if(ev.target.name==='preferencesA'||ev.target.name==='preferencesB'){
    const inputs=$$(`input[name="${ev.target.name}"]`),neutral=inputs.find(x=>x.value==='');
    if(ev.target.value===''&&ev.target.checked)inputs.filter(x=>x!==neutral).forEach(x=>x.checked=false);
    neutral.checked=!inputs.some(x=>x.value&&x.checked);
  }
  if(ev.target.id==='saving'){$('#budget').disabled=ev.target.checked;if(ev.target.checked)$('#budget').value=50;else $('#budget').value='';}applyConditions();
});
$('#budget').addEventListener('input',()=>{clearTimeout(conditionTimer);$('#export').disabled=true;conditionTimer=setTimeout(applyConditions,160);});
$('#ban-keywords').addEventListener('input',()=>{clearTimeout(conditionTimer);$('#export').disabled=true;conditionTimer=setTimeout(applyConditions,160);});
$('#exploration').addEventListener('input',ev=>{const e=Number(ev.target.value);paintExploration(e);clearTimeout(sliderTimer);sliderTimer=null;sliderTimer=setTimeout(()=>{sliderTimer=null;const seed=crypto.getRandomValues(new Uint32Array(1))[0];const next=exploreIntent(snapshot(),e,seed,catalog);compute(next,'已保留你的选择，为后面换些灵感。',{selectionMode:'seeded_exploration',preserveThrough:next.prefix.length-1});},130);});
$('#restart-plan').addEventListener('click',()=>{if(!conditionsValid||busy)return;clearTimeout(sliderTimer);sliderTimer=null;const next=restartIntent(displayedIntent(),crypto.getRandomValues(new Uint32Array(1))[0]);compute(next,'已重新推荐，仍可从上往下慢慢选。',{selectionMode:next.exploration>0?'seeded_exploration':'utility_best'});});

const PRESET_CONFIGS={
  scau_firefly:()=>{
    const periods=normalizePeriods(['afternoon','evening']);
    return {
      context:normalizeUIScope({...newContext(),...periods,weather:'clear',weekPart:'weekend',relationship:'flirting',occasion:'confession',area:'campus',school:'scau',campusArea:'taishan',budget:100,preferencesA:['nature','photo'],preferencesB:['romantic','night'],preparedIds:['venue_checked','phone_camera','picnic_mat','water']}),
      exploration:0,
      prefix:[
        {sceneId:'supermarket',activityIds:['purchase_picnic'],durationMinutes:30},
        {sceneId:'campus_picnic',activityIds:['picnic_share','picnic_cloud'],durationMinutes:180},
        {sceneId:'canteen',activityIds:['campus_budget_meal'],durationMinutes:45},
        {sceneId:'scau_orchid_firefly',activityIds:['firefly_observe','firefly_evening_notes'],durationMinutes:40},
        {sceneId:'bridge_walk',activityIds:['bridge_view']}
      ],
      message:'已载入【华农泰山 · 野餐物资链与兰园傍晚观萤】完整链路。'
    };
  },
  rain_fatigue:()=>{
    const periods=normalizePeriods(['afternoon']);
    return {
      context:normalizeUIScope({...newContext(),...periods,weather:'rain',fatigueA:6,fatigueB:6,area:'near'}),
      exploration:0,
      prefix:[],
      message:'已载入【雨天疲惫】情境：触发两轮产生式推导（R-fatigue-derive → R-fatigue-rest）。'
    };
  },
  exam_short:()=>{
    const periods=normalizePeriods(['evening']);
    return {
      context:normalizeUIScope({...newContext(),...periods,season:'exam',area:'campus',school:'scau'}),
      exploration:0,
      prefix:[],
      message:'已载入【临考间隙】情境：触发 R-exam-campus-short 短会规则。'
    };
  },
  zero_budget:()=>{
    const periods=normalizePeriods(['evening']);
    return {
      context:normalizeUIScope({...newContext(),...periods,budget:0,weather:'clear',themes:['romantic'],area:'campus',school:'scau',campusArea:'taishan'}),
      exploration:0,
      prefix:[
        {sceneId:'scau_orchid_firefly',activityIds:['firefly_observe','firefly_evening_notes'],durationMinutes:40},
        {sceneId:'dorm_downstairs_shelter',activityIds:['talk_next']}
      ],
      message:'已载入【零预算校园夜游】情境：0 元硬约束下的傍晚观萤与夜谈。'
    };
  },
  dream_100:()=>{
    const periods=normalizePeriods(['morning','afternoon','evening']);
    return {
      context:normalizeUIScope({...newContext(),...periods,occasion:'anniversary',area:'all',mealChoices:{breakfast:{sceneId:'campus_canteen',activityIds:['breakfast_eat']}}}),
      exploration:100,
      prefix:[],
      message:'已载入【纪念日 · 探索度 100】梦幻模式行程。'
    };
  }
};
async function applyPreset(presetKey){
  const builder=PRESET_CONFIGS[presetKey];if(!builder)return;
  clearTimeout(sliderTimer);sliderTimer=null;clearTimeout(conditionTimer);conditionTimer=null;
  $$('.preset-chip').forEach(btn=>btn.classList.toggle('active',btn.dataset.preset===presetKey));
  if($('#view-plan').hidden)showView('plan');
  const cfg=builder();
  state={context:cfg.context,exploration:cfg.exploration,prefix:cfg.prefix};
  syncControls();
  await compute(state,cfg.message,{selectionMode:cfg.exploration>0?'seeded_exploration':'utility_best'});
}
$$('[data-preset]').forEach(btn=>btn.addEventListener('click',()=>applyPreset(btn.dataset.preset)));
$$('[data-atlas-filter]').forEach(btn=>btn.addEventListener('click',()=>{
  currentAtlasFilter=btn.dataset.atlasFilter;
  $$('[data-atlas-filter]').forEach(x=>x.classList.toggle('active',x===btn));
  renderAtlasView();
}));
$('#atlas-grid')?.addEventListener('click',ev=>{
  const btn=ev.target.closest('[data-try-preset]');
  if(btn)applyPreset(btn.dataset.tryPreset);
});

function closeMenu(){ $('#more-menu').hidden=true;$('#more-menu-toggle').setAttribute('aria-expanded','false'); }
function showView(name){
  closeMenu();$$('.view').forEach(x=>x.hidden=x.id!==`view-${name}`);
  $('#menu-home').hidden=name==='plan';$('.sidebar').hidden=name!=='plan';
  const presetBar=$('.preset-bar');if(presetBar)presetBar.hidden=name!=='plan';
  if(name==='library')libraryView.render();
  if(name==='atlas')renderAtlasView();
  if(name==='plan')timeline.recenter();
  validationWorker?.postMessage({type:'pauseValidation',paused:name!=='plan'||document.hidden});
  if(name==='plan')timeline.refreshVisibleCandidates();
  window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  if(name==='about')$('#about-info').innerHTML=`<p>DateMate · 版本 5.0.0</p><p>知识库 · ${esc(catalog.version)}（${sources.length} 份语料 / ${graph.nodes.length} 节点 / ${graph.edges.length} 边）</p><h3>小组成员</h3><p>徐阳、廖信同、黎欣欣、周艳雯、殷浚峰</p>`;
}
$('#more-menu-toggle').addEventListener('click',()=>{const open=$('#more-menu').hidden;$('#more-menu').hidden=!open;$('#more-menu-toggle').setAttribute('aria-expanded',String(open));});
$$('[data-view]').forEach(button=>button.addEventListener('click',()=>showView(button.dataset.view)));
$$('[data-home]').forEach(button=>button.addEventListener('click',()=>showView('plan')));
document.addEventListener('click',event=>{if(!event.target.closest('#more-menu')&&!event.target.closest('#more-menu-toggle'))closeMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeMenu();if($('#poster-modal'))$('#poster-modal').hidden=true;}});
$('#query-graph').addEventListener('click',graphQuery);

function drawItineraryPoster(){
  if(!result?.ok)return;
  const canvas=$('#poster-canvas');if(!canvas)return;
  const ctx=canvas.getContext('2d');
  const W=760,H=Math.max(960,360+result.stages.length*118);
  canvas.width=W;canvas.height=H;
  ctx.fillStyle='#fbf9f6';ctx.fillRect(0,0,W,H);
  ctx.strokeStyle='#e8e4e0';ctx.lineWidth=2;ctx.strokeRect(24,24,W-48,H-48);

  ctx.fillStyle='#b54869';
  ctx.fillRect(56,56,44,44);
  ctx.fillStyle='#ffffff';
  ctx.font='bold 30px Georgia, serif';
  ctx.fillText('d.',66,88);

  ctx.fillStyle='#252736';
  ctx.font='600 28px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillText('DateMate · 约会行程单',116,84);
  ctx.fillStyle='#737582';
  ctx.font='400 14px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillText($('#conditions-summary-pills')?.textContent||'确定性知识图谱与产生式推理生成',116,108);

  ctx.strokeStyle='#e8e4e0';ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(56,132);ctx.lineTo(W-56,132);ctx.stroke();

  const fmt=m=>`${String(Math.floor((m%1440)/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
  let y=168;
  result.stages.forEach((st,idx)=>{
    const sc=sceneById.get(st.sceneId);
    const title=sc?.title||st.sceneId;
    const acts=(st.activityIds||[]).map(aid=>sc?.activities?.find(a=>a.id===aid)?.title||activityById.get(aid)?.title||aid).join(' / ')||'自由停留与交流';
    const meta=FEATURED_SCENE_META[st.sceneId];

    ctx.fillStyle='#ffffff';
    ctx.fillRect(56,y,W-112,96);
    ctx.strokeStyle=meta?'#b54869':'#e8e4e0';
    ctx.lineWidth=meta?1.5:1;
    ctx.strokeRect(56,y,W-112,96);

    ctx.fillStyle='#b54869';
    ctx.font='600 15px ui-monospace,Consolas,monospace';
    ctx.fillText(`${String(idx+1).padStart(2,'0')}  ${fmt(st.start ?? st.startMinute)}–${fmt(st.end ?? st.endMinute)}`,76,y+32);

    ctx.fillStyle='#252736';
    ctx.font='600 20px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillText(title,230,y+33);

    if(meta){
      ctx.fillStyle='#fae7ee';
      ctx.fillRect(W-210,y+14,136,24);
      ctx.fillStyle='#b54869';
      ctx.font='600 12px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillText(meta.badge,W-198,y+30);
    }

    ctx.fillStyle='#737582';
    ctx.font='400 14px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillText(`活动：${acts.slice(0,36)}`,76,y+66);
    const costArr=st.cost||(st.costCents?st.costCents.map(v=>v/100):[0,0]);
    ctx.fillText(`费用 ¥${costArr[0]}–${costArr[1]} · 契合指数 ${st.fitScore ?? '—'}`,W-260,y+66);
    y+=114;
  });

  y+=14;
  ctx.strokeStyle='#e8e4e0';ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(56,y);ctx.lineTo(W-56,y);ctx.stroke();
  y+=34;

  const cost=result.totalCost||[0,0];
  const m=result.metrics||{};
  ctx.fillStyle='#252736';
  ctx.font='600 18px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillText(`预计双人总费用：¥${cost[0]}–${cost[1]}`,56,y);
  ctx.fillStyle='#737582';
  ctx.font='400 13px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillText(`双人效用 ${Math.round(m.utilityA||0)} / ${Math.round(m.utilityB||0)} · 公平度 ${Math.round((m.fairness||1)*100)}% · 已点亮图鉴 ${unlockedAtlas.scenes.size+unlockedAtlas.activities.size}/236`,56,y+28);
  ctx.font='400 12px ui-monospace,Consolas,monospace';
  ctx.fillText(`输出校验指纹 #${result.outputFingerprint} · 788 节点知识图谱 + 59 条产生式规则驱动`,56,y+54);
  ctx.fillText('在线体验：bylsxy.github.io/datemate（《人工智能》第 17 组开源项目）',56,y+78);

  const qx=W-152,qy=y-18,qs=96,cells=11,cs=qs/cells;
  ctx.fillStyle='#ffffff';ctx.fillRect(qx-6,qy-6,qs+12,qs+12);
  ctx.strokeStyle='#e8e4e0';ctx.strokeRect(qx-6,qy-6,qs+12,qs+12);
  const seedStr=result.outputFingerprint||'datemate';
  ctx.fillStyle='#252736';
  for(let r=0;r<cells;r++){
    for(let c=0;c<cells;c++){
      const finder=(r<3&&c<3)||(r<3&&c>=cells-3)||(r>=cells-3&&c<3);
      const bit=finder||((seedStr.charCodeAt((r*cells+c)%seedStr.length)+r*7+c*13)%3===0);
      if(bit)ctx.fillRect(qx+c*cs,qy+r*cs,cs-0.8,cs-0.8);
    }
  }
}
$('#share-poster-btn')?.addEventListener('click',()=>{
  if(!result?.ok)return;
  drawItineraryPoster();
  $('#poster-modal').hidden=false;
});
$('#poster-close-btn')?.addEventListener('click',()=>{$('#poster-modal').hidden=true;});
$('#poster-modal')?.addEventListener('click',ev=>{if(ev.target===$('#poster-modal'))$('#poster-modal').hidden=true;});
$('#poster-download-btn')?.addEventListener('click',()=>{
  const canvas=$('#poster-canvas');if(!canvas)return;
  const a=document.createElement('a');
  a.href=canvas.toDataURL('image/png');
  a.download=`DateMate_行程单_${result?.outputFingerprint||'plan'}.png`;
  a.click();
});

async function copyText(text){
  if(navigator.clipboard?.writeText){try{await navigator.clipboard.writeText(text);return;}catch{}}
  const textarea=document.createElement('textarea'),focus=document.activeElement;
  textarea.value=text;textarea.readOnly=true;textarea.style.cssText='position:fixed;left:0;top:0;opacity:0';document.body.append(textarea);textarea.select();
  const copied=document.execCommand('copy');textarea.remove();focus?.focus({preventScroll:true});
  if(!copied)throw Error('copy unavailable');
}
$('#copy-options').addEventListener('click',async()=>{
  const button=$('#copy-options'),current=snapshot(),context=readContext({strict:false});
  button.disabled=true;button.textContent='复制中…';
  const output=!busy&&!conditionTimer&&conditionsValid&&result?.ok?{fingerprint:result.outputFingerprint,stages:result.stages.map(s=>({sceneId:s.sceneId,activityIds:s.activityIds,mealRole:s.mealRole,startMinute:s.startMinute,endMinute:s.endMinute})),departure:result.departure}:null;
  try{await copyText(JSON.stringify({format:'datemate-options-4.1',state:{...current,context},output},null,2));button.textContent='已复制';}
  catch{button.textContent='复制当前选项';note('复制未完成，请允许复制或使用菜单导出JSON。',true);}
  finally{button.disabled=false;setTimeout(()=>button.textContent='复制当前选项',1800);}
});
$('#export').addEventListener('click',()=>{
  closeMenu();
  if(!result?.ok)return;
  if(busy){note('计算完成后再导出，保证输入与输出一致。');return;}
  const payload={format:'datemate-ui-replay-4.1',state:snapshot(),versions:result.versions,search:result.replay?.search,engineReplay:result.replay,outputFingerprint:result.outputFingerprint};
  const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`DateMate_复盘_${result.fingerprint}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);note('已导出复盘；文件包含当前条件，分享前请检查内容。');
});
$('#import').addEventListener('click',()=>{closeMenu();$('#import-file').click();});
async function loadReplay(obj){
  const p=validateReplay(obj);
  if(JSON.stringify(p.versions)!==JSON.stringify(result?.versions))throw Error('数据、规则或评分版本不匹配，无法保证复现。');
  return compute(p.state,'复盘成功：输入与输出校验一致。',{expectedDigest:p.outputFingerprint,search:p.search,knownPlan:p.engineReplay?.knownPlan??null});
}
$('#import-file').addEventListener('change',async ev=>{const file=ev.target.files[0];if(!file)return;try{if(file.size>200000)throw Error('复盘文件超过200KB限制。');await loadReplay(JSON.parse(await file.text()));}catch(e){note(`导入失败：${e.message}`,true);}ev.target.value='';});
initializeKnowledge();syncControls();
compute(state,'第一份灵感已生成。横滑浏览，点击场景或勾选活动，让后续跟着改变。',{});
