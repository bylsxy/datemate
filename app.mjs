import {catalog,rules,graph,sources,evidence} from './data/catalog.mjs?v=4.1.0';
import {createTimeline} from './timeline.mjs?v=4.1.0';
import {explainStage} from './explanations.mjs?v=4.1.0';
import {preparationOptions,dietaryOptions} from './data/activities.mjs?v=4.1.0';
import * as reasoning from './reasoning.mjs?v=4.1.0';
import {normalizePeriods} from './time-periods.mjs?v=4.1.0';
import {formatTime,costLabel,escapeHTML as esc,interestLabels,defaultContext,toggleActivity,validateReplay} from './planner.mjs?v=4.1.0';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const sceneById=new Map(catalog.scenes.map(s=>[s.id,s]));
const sourceById=new Map(sources.map(s=>[s.id,s]));
let state={context:defaultContext(),exploration:0,prefix:[]}, result=null, sequence=0, busy=false, pending=null, active=null, lastElapsed=0, sliderTimer, conditionTimer, conditionsValid=true;
const clone=x=>structuredClone(x);
const worker=new Worker(new URL('./worker.mjs?v=4.1.0',import.meta.url),{type:'module'});
const timeline=createTimeline({catalog,onScene:commitStage,onActivities:commitStage,onMeal:commitMeal,onDeparture:commitDeparture,getIntent:snapshot});
let graphRequest=0;
function revealError(element){
  if($('#view-plan').hidden)showView('plan');
  requestAnimationFrame(()=>element.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'}));
}
function note(text,error=false){$('#status').textContent=text;$('#status').classList.toggle('error',error);$('#status').classList.toggle('sr-only',!error);if(error)revealError($('#status'));}
function planningError(r,context){
  const errors=(r?.errors||[]).join(' '),departure=catalog.departures?.find(d=>d.id===context.departureChoice);
  const departureHigh=(departure?.costByCityTier?.[context.cityTier]||departure?.cost||[0,0])[1];
  if(errors.includes('H_BUDGET')||(context.budget!==null&&departureHigh>context.budget))return '所选活动和分别方式超出当前预算，可以调整预算、取消活动或改选分别方式。';
  if(errors.includes('H_PREPARATION'))return '这项玩法还缺准备物品或前面的活动，请先准备好，并在高级选项中确认。';
  if(errors.includes('H_FATIGUE'))return '这项玩法接上去会太累，先休息一段或换个轻松的选择。';
  return '当前条件还没有可行安排，请调整条件或用餐选择。';
}
function snapshot(){return clone(pending?.next || active?.next || state);}
function dispatch(job){busy=true;active=job;worker.postMessage({id:job.id,state:job.next});}
function compute(next,message='安排已更新。横滑找灵感，点击才会选择。',{expectedDigest=null,fromStage=0,choice=null,mealChoice=null,departureChoice=null}={}){
  const id=++sequence;timeline.pending({fromStage,choice,mealChoice,departureChoice});pendingPanels();$('#export').disabled=true;note('正在考虑后续安排…');
  return new Promise(resolve=>{const job={id,next:clone(next),message,expectedDigest,resolve};if(busy){pending?.resolve(null);pending=job;}else dispatch(job);});
}
worker.onmessage=({data})=>{
  const job=active;busy=false;active=null;
  if(job&&job.id===data.id){
    if(data.id===sequence){
      const r=data.result;
      if(data.error||!r?.ok){
        state=job.next;
        const mealRequirements=normalizePeriods(state.context.periodIds,state.context.mealChoices).mealRequirements;
        result={...(r||{}),ok:false,stages:[],mealRequirements:r?.mealRequirements||mealRequirements};
        render();note(planningError(r,state.context),true);syncControls();
      }
      else if(job.expectedDigest&&r.outputFingerprint!==job.expectedDigest){if(result)render();note('复盘输出校验不一致，当前安排保留。',true);syncControls();}
      else{state=job.next;result=r;lastElapsed=data.elapsed;conditionsError();render();syncControls();note(job.message);}
      $('#stages').setAttribute('aria-busy','false');$('#export').disabled=!result?.ok;job.resolve(r);
    }else job.resolve(null);
  }
  if(pending){const p=pending;pending=null;dispatch(p);}
};
worker.onerror=event=>{note(`计算线程出错：${event.message}。请刷新后重试。`,true);$('#stages').setAttribute('aria-busy','false');active?.resolve(null);pending?.resolve(null);active=pending=null;busy=false;};
function checked(name){return $$(`input[name="${name}"]:checked`).map(x=>x.value);}
function selectedValue(name,fallback=''){return $(`input[name="${name}"]:checked`)?.value??fallback;}
function readContext({strict=true}={}){
  const c=defaultContext(),ids=checked('slots'),raw=$('#budget').value;let periods;
  try{periods=normalizePeriods(ids);}catch(error){if(strict)throw error;}
  if(strict&&raw!==''&&(!Number.isFinite(Number(raw))||Number(raw)<0))throw Error('请填写0或更大的有效预算。');
  c.periodIds=periods?.periodIds||ids;c.mealChoices=clone(snapshot().context.mealChoices||{});
  if(periods){c.duration=periods.duration;c.windows=periods.windows;}else{delete c.duration;delete c.windows;}
  c.budget=$('#saving').checked?50:raw===''?null:Number(raw);
  c.weather=$('#rain').checked?'rain':'unknown';c.area=selectedValue('area','near');c.fatigueA=$('#tired-a').checked?6:2;c.fatigueB=$('#tired-b').checked?6:2;
  c.preferences=[$('#quiet').checked?'quiet':null,$('#indoor').checked?'indoor':null].filter(Boolean);c.quietRequired=$('#quiet-hard').checked;
  c.crowdAvoidance=$('#crowd').checked;c.robust=$('#robust').checked;c.theme=selectedValue('theme','any');c.cityTier=selectedValue('cityTier','tier1');
  c.departureChoice=snapshot().context.departureChoice||'separate';
  if(periods&&periods.endMinute<=1440&&c.departureChoice==='hotel')c.departureChoice='separate';
  c.preferencesA=checked('preferencesA').filter(Boolean);c.preferencesB=checked('preferencesB').filter(Boolean);c.preparedIds=checked('prepared');c.dietaryRestrictions=checked('diet');
  const exclude=selectedValue('exclude'),anchor=selectedValue('anchor');c.bans=exclude?[exclude]:[];
  c.anchors=anchor?[{id:'必去',sceneOnly:true,choice:{sceneId:anchor,activityIds:[]}}]:[];
  c.explicitConsentIds=[...(snapshot().context.explicitConsentIds||[])];
  return c;
}
function syncControls(){
  const c=state.context;
  $('#budget').value=c.budget===null?'':c.budget;$('#saving').checked=c.budget===50;$('#budget').disabled=$('#saving').checked;
  $('#rain').checked=c.weather==='rain';$('#tired-a').checked=c.fatigueA>=6;$('#tired-b').checked=c.fatigueB>=6;
  $('#quiet').checked=c.preferences.includes('quiet');$('#indoor').checked=c.preferences.includes('indoor');$('#quiet-hard').checked=c.quietRequired;
  $('#crowd').checked=c.crowdAvoidance;$('#robust').checked=c.robust;
  for(const [name,values]of [['preferencesA',c.preferencesA?.length?c.preferencesA:['']],['preferencesB',c.preferencesB?.length?c.preferencesB:['']],['prepared',c.preparedIds],['diet',c.dietaryRestrictions],['slots',c.periodIds],['theme',[c.theme]],['area',[c.area]],['cityTier',[c.cityTier||'tier1']],['exclude',[c.bans[0]||'']],['anchor',[c.anchors?.[0]?.choice?.sceneId||'']]])$$(`input[name="${name}"]`).forEach(x=>x.checked=(values||[]).includes(x.value));
  $('#exploration').value=state.exploration;$('#exploration-value').innerHTML=`${state.exploration}<small>/ 100</small>`;
}
function traceText(t){return t.message||t.text||t.title||rules.find(r=>r.id===t.ruleId)?.title||t.rule||'规则已触发';}
function traceHTML(t){const ins=t.inputFacts||[],outs=t.outputFacts||[];return `<div class="trace-item"><span class="trace-id">${esc(t.ruleId||t.id||t.rule||'状态更新')}</span><p>${esc(traceText(t))}</p>${ins.length?`<p>输入：${esc(ins.map(x=>typeof x==='string'?x:JSON.stringify(x)).join('；'))}</p>`:''}${outs.length?`<p>推导：${esc(outs.map(x=>typeof x==='string'?x:JSON.stringify(x)).join('；'))}</p>`:''}</div>`;}
function metricsHTML(m={}){return `<div class="metrics">${[['我方偏好',m.utilityA??m.satisfactionA??m.preferenceA],['对方偏好',m.utilityB??m.satisfactionB??m.preferenceB],['公平指标',m.fairness],['新鲜度',m.novelty],['占用分钟',m.totalMinutes],['终段负担',Math.max(...Object.values(m.predictedLoadByPerson||{}))]].filter(([,v])=>Number.isFinite(v)).map(([k,v])=>`<div class="metric"><span>${k}</span><strong>${Math.round(v*100)/100}</strong></div>`).join('')}</div>`;}
function pendingPanels(){
  const placeholder='<div class="skeleton-panel" aria-label="正在重新计算"><span class="skeleton skeleton-line"></span><span class="skeleton skeleton-line"></span></div>';
  for(const id of ['ending','reason-content','rule-trace','comparison','search-details']){
    const el=document.getElementById(id);el.setAttribute('aria-busy','true');el.innerHTML=placeholder;
  }
}
function render(){
  timeline.render(result);
  const r=result;
  if(!r.ok){
    $('#ending').textContent='';$('#reason-content').textContent='当前条件还没有可行安排。';
    $('#replay-id').textContent='';$('#comparison').textContent='';$('#search-details').textContent='';$('#rule-trace').textContent='';
    for(const id of ['ending','reason-content','rule-trace','comparison','search-details'])document.getElementById(id).setAttribute('aria-busy','false');
    return;
  }
  $('#ending').textContent=`建议余额 ≥ ${Math.ceil(r.totalCost[1])} rmb`;
  $('#reason-content').innerHTML=r.stages.map(st=>{
    const place=sceneById.get(st.sceneId),lines=explainStage(st,place,state.context);
    return `<div class="reason-item"><h3>${esc(place.title)}</h3>${lines.map(line=>`<p>${esc(line)}</p>`).join('')}</div>`;
  }).join('')+(r.mealRequirements||[]).filter(m=>m.choiceMode!=='together').map(m=>`<div class="reason-item"><h3>${esc(m.label)}</h3><p>${m.choiceMode==='before_meeting'?'你选择了会面前吃早餐，所以早餐不占见面后的时间；见面后直接开始活动。':'你选择了不吃宵夜，去掉这一餐的时间和花费，再把前后的活动接起来。'}</p></div>`).join('')+(r.departure?`<div class="reason-item"><h3>分别</h3><p>${r.departure.id==='hotel'?`你选择了酒店，按${({tier1:'一线',tier2:'二线',tier3:'三线及以下'})[state.context.cityTier||'tier1']}城市的双人房设计区间预留一晚房费，再与其他安排一起检查余额。`:'先为你选的分别方式留好最后一段时间，再安排前面的活动。'}</p></div>`:'');
  $('#replay-id').textContent=`输入 ${r.fingerprint} · 输出 ${r.outputFingerprint}`;
  renderReasoning();renderComparison();
  for(const id of ['ending','reason-content','rule-trace','comparison','search-details'])document.getElementById(id).setAttribute('aria-busy','false');
}
async function commitStage(index,sceneId,activityIds){
  if(!result?.ok||!conditionsValid)return false;
  clearTimeout(sliderTimer);
  const intended=snapshot();
  const prefix=result.stages.slice(0,index).map((s,i)=>intended.prefix[i]||{sceneId:s.sceneId,activityIds:[...s.activityIds],...(s.mealRole?{mealRole:s.mealRole}:{})});
  prefix.push({sceneId,activityIds});
  const next=snapshot();next.prefix=prefix;delete next.context.endAfterStage;
  next.context.explicitConsentIds=prefix.flatMap(choice=>sceneById.get(choice.sceneId).activities.filter(a=>a.requiresExplicitConsent&&choice.activityIds.includes(a.id)).map(a=>a.id));
  const r=await compute(next,'已按地点和活动重新规划，之前阶段保留。',{fromStage:index,choice:{index,sceneId,activityIds}});
  return !!r?.ok;
}
async function commitMeal(role,choice,{fromStage=0}={}){
  if(!result||!conditionsValid)return false;
  clearTimeout(sliderTimer);
  const next=snapshot();
  next.context.mealChoices={...(next.context.mealChoices||{}),[role]:clone(choice)};
  next.prefix=result.stages.slice(0,fromStage).map(s=>({sceneId:s.sceneId,activityIds:[...s.activityIds],...(s.mealRole?{mealRole:s.mealRole}:{})}));
  const consentChoices=[...next.prefix,...(choice.sceneId?[choice]:[])];
  next.context.explicitConsentIds=[...new Set(consentChoices.flatMap(p=>sceneById.get(p.sceneId).activities.filter(a=>a.requiresExplicitConsent&&p.activityIds.includes(a.id)).map(a=>a.id)))];
  delete next.context.endAfterStage;
  const r=await compute(next,'用餐选择已更新。',{fromStage,mealChoice:{role,choice}});
  return !!r?.ok;
}
async function commitDeparture(id){
  if(!result||!conditionsValid)return false;
  clearTimeout(sliderTimer);const next=snapshot();next.context.departureChoice=id;
  const r=await compute(next,'分别方式已更新。',{departureChoice:id});return !!r?.ok;
}
const nodeById=new Map(graph.nodes.map(n=>[n.id,n]));
const predicates={allows_activity:'可包含',has_feature:'具有特征',supported_by:'依据',from_source:'来自',requires:'需要',provides:'提供',consumes:'消耗',governed_by:'受规则约束',depends_on:'前置依赖',derives:'推导'};
async function graphQuery(){
  const id=++graphRequest;
  $('#graph-paths').innerHTML='<div class="skeleton-panel"><span class="skeleton skeleton-line"></span><span class="skeleton skeleton-line"></span></div>';
  $('#graph-paths').setAttribute('aria-busy','true');
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  if(id!==graphRequest)return;
  const paths=reasoning.queryGraph(graph,$('#graph-from').value,$('#graph-to').value,{maxDepth:5,maxPaths:6});
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
function initializeKnowledge(){
  const preparedContainer=$('input[name="prepared"]').closest('.choices');
  preparedContainer.innerHTML=preparationOptions.filter(x=>!['photo_pair','paired_photo','main_meal','meal_done'].includes(x.id)).map(x=>`<label class="choice"><input name="prepared" type="checkbox" value="${esc(x.id)}">${esc(x.label)}</label>`).join('');
  const dietaryContainer=$('input[name="diet"]').closest('.choices');
  dietaryContainer.innerHTML=dietaryOptions.map(x=>`<label class="choice"><input name="diet" type="checkbox" value="${esc(x.id)}">${esc(x.label)}</label>`).join('');
  const interests=[['户外',['nature','exercise','photo']],['体验',['culture','play','creative','learning']],['氛围',['romantic','music','quiet','indoor']],['日常',['food','daily']]];
  for(const p of ['a','b']){
    const name=`preferences${p.toUpperCase()}`;
    $(`#preferences-${p}`).innerHTML=`<label class="choice interest-any"><input type="checkbox" name="${name}" value="" checked>随意</label>`+interests.map(([title,ids])=>`<div class="interest-group"><span class="interest-group-label">${title}</span><div class="choices">${ids.map(id=>`<label class="choice"><input type="checkbox" name="${name}" value="${id}">${interestLabels[id]}</label>`).join('')}</div></div>`).join('');
  }
  for(const [id,name,label]of [['exclude-options','exclude','不排除'],['anchor-options','anchor','不指定']]){
    $(`#${id}`).innerHTML=`<label class="choice"><input type="radio" name="${name}" value="" checked>${label}</label>`+catalog.scenes.filter(s=>s.kind!=='rest').map(s=>`<label class="choice"><input type="radio" name="${name}" value="${s.id}">${esc(s.title)}</label>`).join('');
  }
  const counts=[['场景',catalog.scenes.length],['活动',catalog.activities.length],['规则',rules.length],['图谱边',graph.edges.length]];
$('#knowledge-summary').innerHTML=counts.map(([l,n])=>`<div class="stat-tile"><strong>${n}</strong><span>${l}</span></div>`).join('');
  const byType={scene:'场景',activity:'活动',feature:'特征',tag:'兴趣',preparation:'准备',rule:'规则',evidence:'证据',source:'来源',condition:'条件'};
  const nodes=[...graph.nodes].sort((a,b)=>a.type.localeCompare(b.type)||a.label.localeCompare(b.label,'zh'));
  const options=nodes.map(n=>`<option value="${esc(n.id)}">${byType[n.type]||n.type} · ${esc(n.label.slice(0,40))}</option>`).join('');$('#graph-from').innerHTML=options;$('#graph-to').innerHTML=options;
  $('#graph-from').value='mall';$('#graph-to').value='tag:play';graphQuery();
  const adopted=sources.filter(s=>s.adoptedEvidenceIds?.length);$('#source-audit').innerHTML=`<p class="field-hint">${sources.length}份本地语料登记 · ${adopted.length}份来源形成采用证据 · ${evidence.length}条原创摘要。关键词候选经过局部核对后才能成为证据，模型参数单独标为设计值。</p>`+adopted.map(s=>`<div class="source-item"><strong>${esc(s.title)}</strong><br>${esc(s.category)} · ${s.adoptedEvidenceIds.length}条证据 · SHA-256 ${s.sha256.slice(0,14)}…<br>本地文本已定位；现实信息与作品归属需回源核实。</div>`).join('');
  $('#conditions').open=false;
}
$('#conditions-form').addEventListener('submit',ev=>{ev.preventDefault();applyConditions();});
function conditionsError(message=''){
  conditionsValid=!message;
  const error=$('#condition-error');error.textContent=message;error.hidden=!message;
  $('#stages').hidden=!!message;$('#ending').hidden=!!message;$('#view-plan .explanation').hidden=!!message;
  $('#exploration').disabled=!!message;
  if(message){++sequence;pending?.resolve(null);pending=null;$('#export').disabled=true;note('');$('#conditions').open=true;revealError(error);}
}
async function applyConditions(){
  clearTimeout(sliderTimer);clearTimeout(conditionTimer);conditionTimer=null;
  try{const next=snapshot();next.context=readContext();next.prefix=[];delete next.context.endAfterStage;conditionsError();await compute(next,'条件已更新。');}
  catch(e){conditionsError(e.message.replace(/^H_[A-Z_]+:\s*/,''));}
}
$('#conditions-form').addEventListener('change',ev=>{
  if(ev.target.name==='preferencesA'||ev.target.name==='preferencesB'){
    const inputs=$$(`input[name="${ev.target.name}"]`),neutral=inputs.find(x=>x.value==='');
    if(ev.target.value===''&&ev.target.checked)inputs.filter(x=>x!==neutral).forEach(x=>x.checked=false);
    neutral.checked=!inputs.some(x=>x.value&&x.checked);
  }
  if(ev.target.id==='saving'){$('#budget').disabled=ev.target.checked;if(ev.target.checked)$('#budget').value=50;else $('#budget').value='';}applyConditions();
});
$('#budget').addEventListener('input',()=>{clearTimeout(conditionTimer);$('#export').disabled=true;conditionTimer=setTimeout(applyConditions,160);});
$('#exploration').addEventListener('input',ev=>{const e=Number(ev.target.value);$('#exploration-value').innerHTML=`${e}<small>/ 100</small>`;clearTimeout(sliderTimer);sliderTimer=setTimeout(()=>{const next=snapshot();next.exploration=e;compute(next,'探索度已更新：固定已选阶段，重新比较可行后续。');},130);});
function closeMenu(){ $('#more-menu').hidden=true;$('#more-menu-toggle').setAttribute('aria-expanded','false'); }
function showView(name){
  closeMenu();$$('.view').forEach(x=>x.hidden=x.id!==`view-${name}`);
  window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  if(name==='about')$('#about-info').innerHTML=`<p>DateMate · 版本 4.1.0</p><p>知识库 · ${esc(catalog.version)}</p>`;
}
$('#more-menu-toggle').addEventListener('click',()=>{const open=$('#more-menu').hidden;$('#more-menu').hidden=!open;$('#more-menu-toggle').setAttribute('aria-expanded',String(open));});
$$('[data-view]').forEach(button=>button.addEventListener('click',()=>showView(button.dataset.view)));
$$('[data-home]').forEach(button=>button.addEventListener('click',()=>showView('plan')));
document.addEventListener('click',event=>{if(!event.target.closest('#more-menu')&&!event.target.closest('#more-menu-toggle'))closeMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMenu();});
$('#query-graph').addEventListener('click',graphQuery);
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
  if(JSON.stringify(p.versions)!==JSON.stringify(result?.versions)||JSON.stringify(p.search)!==JSON.stringify(result?.replay?.search))throw Error('数据、规则、评分或搜索版本不匹配，无法保证复现。');
  return compute(p.state,'复盘成功：输入与输出校验一致。',{expectedDigest:p.outputFingerprint});
}
$('#import-file').addEventListener('change',async ev=>{const file=ev.target.files[0];if(!file)return;try{if(file.size>200000)throw Error('复盘文件超过200KB限制。');await loadReplay(JSON.parse(await file.text()));}catch(e){note(`导入失败：${e.message}`,true);}ev.target.value='';});
initializeKnowledge();syncControls();
compute(state,'第一份灵感已生成。横滑浏览，点击场景或勾选活动，让后续跟着改变。',{});
