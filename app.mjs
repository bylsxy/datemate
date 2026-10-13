import {catalog,rules,graph,sources,evidence} from './data/catalog.mjs';
import {createTimeline} from './timeline.mjs';
import {explainStage} from './explanations.mjs';
import {preparationOptions,dietaryOptions} from './data/activities.mjs';
import * as reasoning from './reasoning.mjs';
import {formatTime,costLabel,escapeHTML as esc,interestLabels,defaultContext,toggleActivity,validateReplay} from './planner.mjs';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const sceneById=new Map(catalog.scenes.map(s=>[s.id,s]));
const sourceById=new Map(sources.map(s=>[s.id,s]));
let state={context:defaultContext(),exploration:0,prefix:[]}, result=null, sequence=0, busy=false, pending=null, active=null, lastElapsed=0, sliderTimer;
const clone=x=>structuredClone(x);
const worker=new Worker(new URL('./worker.mjs',import.meta.url),{type:'module'});
const timeline=createTimeline({catalog,onScene:commitStage,onActivities:commitStage,getIntent:snapshot});
let graphRequest=0;
function note(text,error=false){$('#status').textContent=error?'这个组合与当前条件不合适，请换个地点或调整条件。':text;$('#status').classList.toggle('error',error);$('#status').classList.toggle('sr-only',!error);}
function snapshot(){return clone(pending?.next || active?.next || state);}
function dispatch(job){busy=true;active=job;worker.postMessage({id:job.id,state:job.next});}
function compute(next,message='安排已更新。横滑找灵感，点击才会选择。',{expectedDigest=null,fromStage=0,choice=null}={}){
  const id=++sequence;timeline.pending({fromStage,choice});pendingPanels();$('#export').disabled=true;note('正在考虑后续安排…');
  return new Promise(resolve=>{const job={id,next:clone(next),message,expectedDigest,resolve};if(busy){pending?.resolve(null);pending=job;}else dispatch(job);});
}
worker.onmessage=({data})=>{
  const job=active;busy=false;active=null;
  if(job&&job.id===data.id){
    if(data.id===sequence){
      const r=data.result;
      if(data.error||!r?.ok){if(result)render();else $('#stages').innerHTML='<div class=loading-card>暂未找到可交付方案，请调整条件后重试。</div>';note(data.error||r?.errors?.join('；')||'当前搜索未得到可交付安排，请调整条件。',true);syncControls();}
      else if(job.expectedDigest&&r.outputFingerprint!==job.expectedDigest){if(result)render();note('复盘输出校验不一致，当前安排保留。',true);syncControls();}
      else{state=job.next;result=r;lastElapsed=data.elapsed;render();syncControls();note(job.message);}
      $('#stages').setAttribute('aria-busy','false');$('#export').disabled=!result?.ok;job.resolve(r);
    }else job.resolve(null);
  }
  if(pending){const p=pending;pending=null;dispatch(p);}
};
worker.onerror=event=>{note(`计算线程出错：${event.message}。请刷新后重试。`,true);$('#stages').setAttribute('aria-busy','false');active?.resolve(null);pending?.resolve(null);active=pending=null;busy=false;};
function checked(name){return $$(`input[name="${name}"]:checked`).map(x=>x.value);}
function readContext(){
  const c=defaultContext(),duration=Number($('#duration').value),raw=$('#budget').value;
  if(raw!==''&&(!Number.isFinite(Number(raw))||Number(raw)<0))throw Error('请填写0或更大的有效预算。');
  const slots=checked('slots'),timeWindows={morning:[540,720],afternoon:[840,1080],evening:[1080,1260]};
  c.duration=duration;c.budget=$('#saving').checked?50:raw===''?null:Number(raw);
  c.weather=$('#rain').checked?'rain':'unknown';c.area=$('#area').value;c.fatigueA=$('#tired-a').checked?6:2;c.fatigueB=$('#tired-b').checked?6:2;
  c.preferences=[$('#quiet').checked?'quiet':null,$('#indoor').checked?'indoor':null].filter(Boolean);c.quietRequired=$('#quiet-hard').checked;
  c.crowdAvoidance=$('#crowd').checked;c.mealNeed=$('#meal').checked;c.robust=$('#robust').checked;c.theme=$('#theme').value;
  c.preferencesA=checked('preferencesA');c.preferencesB=checked('preferencesB');c.preparedIds=checked('prepared');c.dietaryRestrictions=checked('diet');
  c.bans=$('#exclude').value?[$('#exclude').value]:[];
  c.windows=slots.length?slots.map(id=>({id,startMinute:timeWindows[id][0],endMinute:timeWindows[id][1]})):[{id:'default',startMinute:840,endMinute:840+duration}];
  c.anchors=$('#anchor').value?[{id:'后续安排',choice:{sceneId:$('#anchor').value,activityIds:[]}}]:[];
  c.explicitConsentIds=[...(snapshot().context.explicitConsentIds||[])];
  return c;
}
function syncControls(){
  const c=state.context;
  $('#duration').value=c.duration;$('#budget').value=c.budget===null?'':c.budget;$('#saving').checked=c.budget===50;$('#budget').disabled=$('#saving').checked;
  $('#rain').checked=c.weather==='rain';$('#area').value=c.area;$('#tired-a').checked=c.fatigueA>=6;$('#tired-b').checked=c.fatigueB>=6;
  $('#quiet').checked=c.preferences.includes('quiet');$('#indoor').checked=c.preferences.includes('indoor');$('#quiet-hard').checked=c.quietRequired;
  $('#crowd').checked=c.crowdAvoidance;$('#meal').checked=c.mealNeed;$('#robust').checked=c.robust;$('#theme').value=c.theme;
  for(const [name,values]of [['preferencesA',c.preferencesA],['preferencesB',c.preferencesB],['prepared',c.preparedIds],['diet',c.dietaryRestrictions],['slots',c.windows?.map(x=>x.id)]])$$(`input[name="${name}"]`).forEach(x=>x.checked=(values||[]).includes(x.value));
  $('#exclude').value=c.bans[0]||'';$('#anchor').value=c.anchors?.[0]?.choice?.sceneId||'';$('#exploration').value=state.exploration;$('#exploration-value').innerHTML=`${state.exploration}<small>/ 100</small>`;
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
  $('#ending').textContent=`建议余额 ≥ ${Math.ceil(r.totalCost[1])} rmb`;
  $('#reason-content').innerHTML=r.stages.map(st=>{
    const place=sceneById.get(st.sceneId),lines=explainStage(st,place,state.context);
    return `<div class="reason-item"><h3>${esc(place.title)}</h3>${lines.map(line=>`<p>${esc(line)}</p>`).join('')}</div>`;
  }).join('');
  $('#replay-id').textContent=`输入 ${r.fingerprint} · 输出 ${r.outputFingerprint}`;
  renderReasoning();renderComparison();
  for(const id of ['ending','reason-content','rule-trace','comparison','search-details'])document.getElementById(id).setAttribute('aria-busy','false');
}
async function commitStage(index,sceneId,activityIds){
  if(!result)return false;
  clearTimeout(sliderTimer);
  const intended=snapshot();
  const prefix=result.stages.slice(0,index).map((s,i)=>intended.prefix[i]||{sceneId:s.sceneId,activityIds:[...s.activityIds]});
  prefix.push({sceneId,activityIds});
  const next=snapshot();next.prefix=prefix;delete next.context.endAfterStage;
  next.context.explicitConsentIds=prefix.flatMap(choice=>sceneById.get(choice.sceneId).activities.filter(a=>a.requiresExplicitConsent&&choice.activityIds.includes(a.id)).map(a=>a.id));
  const r=await compute(next,'已按地点和活动重新规划，之前阶段保留。',{fromStage:index,choice:{index,sceneId,activityIds}});
  return !!r?.ok;
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
  for(const [key,label]of Object.entries(interestLabels)){for(const p of ['a','b'])$(`#preferences-${p}`).insertAdjacentHTML('beforeend',`<label class="choice"><input type="checkbox" name="preferences${p.toUpperCase()}" value="${key}">${label}</label>`);}
  const opts=catalog.scenes.filter(s=>s.kind!=='rest').map(s=>`<option value="${s.id}">${esc(s.title)}</option>`).join('');$('#exclude').insertAdjacentHTML('beforeend',opts);$('#anchor').insertAdjacentHTML('beforeend',opts);
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
async function applyConditions(){try{clearTimeout(sliderTimer);const next=snapshot();next.context=readContext();next.prefix=[];delete next.context.endAfterStage;await compute(next,'条件已更新。');}catch(e){note(e.message,true);}}
$('#conditions-form').addEventListener('change',ev=>{if(ev.target.id==='saving'){$('#budget').disabled=ev.target.checked;if(ev.target.checked)$('#budget').value=50;else $('#budget').value='';}applyConditions();});
$('#exploration').addEventListener('input',ev=>{const e=Number(ev.target.value);$('#exploration-value').innerHTML=`${e}<small>/ 100</small>`;clearTimeout(sliderTimer);sliderTimer=setTimeout(()=>{const next=snapshot();next.exploration=e;compute(next,'探索度已更新：固定已选阶段，重新比较可行后续。');},130);});
function closeMenu(){ $('#more-menu').hidden=true;$('#more-menu-toggle').setAttribute('aria-expanded','false'); }
function showView(name){
  closeMenu();$$('.view').forEach(x=>x.hidden=x.id!==`view-${name}`);
  window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  if(name==='about')$('#about-info').innerHTML=`<p>DateMate · 版本 4.0.0</p><p>知识库 · ${esc(catalog.version)}</p>`;
}
$('#more-menu-toggle').addEventListener('click',()=>{const open=$('#more-menu').hidden;$('#more-menu').hidden=!open;$('#more-menu-toggle').setAttribute('aria-expanded',String(open));});
$$('[data-view]').forEach(button=>button.addEventListener('click',()=>showView(button.dataset.view)));
$$('[data-home]').forEach(button=>button.addEventListener('click',()=>showView('plan')));
document.addEventListener('click',event=>{if(!event.target.closest('#more-menu')&&!event.target.closest('#more-menu-toggle'))closeMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMenu();});
$('#query-graph').addEventListener('click',graphQuery);
$('#export').addEventListener('click',()=>{
  closeMenu();
  if(!result?.ok)return;
  if(busy){note('计算完成后再导出，保证输入与输出一致。');return;}
  const payload={format:'datemate-ui-replay-3.0',state:snapshot(),versions:result.versions,search:result.replay?.search,engineReplay:result.replay,outputFingerprint:result.outputFingerprint};
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
