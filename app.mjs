import {catalog,rules,graph,sources,evidence} from './data/catalog.mjs';
import {preparationOptions,dietaryOptions} from './data/activities.mjs';
import * as reasoning from './reasoning.mjs';
import {formatTime,costLabel,escapeHTML as esc,interestLabels,defaultContext,toggleActivity,validateReplay} from './planner.mjs';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const sceneById=new Map(catalog.scenes.map(s=>[s.id,s]));
const sourceById=new Map(sources.map(s=>[s.id,s]));
let state={context:defaultContext(),exploration:0,prefix:[]}, result=null, history=[], sequence=0, busy=false, pending=null, active=null, lastElapsed=0, sliderTimer;
const clone=x=>structuredClone(x);
const worker=new Worker(new URL('./worker.mjs',import.meta.url),{type:'module'});
function note(text,error=false){$('#status').textContent=text;$('#status').classList.toggle('error',error);}
function snapshot(){return clone(pending?.next || active?.next || state);}
function dispatch(job){busy=true;active=job;worker.postMessage({id:job.id,state:job.next});}
function compute(next,message='安排已更新。横滑找灵感，点击才会选择。',{record=true,expectedDigest=null}={}){
  const id=++sequence;$('#stages').setAttribute('aria-busy','true');note('正在考虑后续安排…');
  return new Promise(resolve=>{const job={id,next:clone(next),message,record,expectedDigest,resolve};if(busy){pending?.resolve(null);pending=job;}else dispatch(job);});
}
worker.onmessage=({data})=>{
  const job=active;busy=false;active=null;
  if(job&&job.id===data.id){
    if(data.id===sequence){
      const r=data.result;
      if(data.error||!r?.ok){note(data.error||r?.errors?.join('；')||'当前搜索未得到可交付安排，请调整条件。',true);syncControls();}
      else if(job.expectedDigest&&r.outputFingerprint!==job.expectedDigest){note('复盘输出校验不一致，当前安排保留。',true);syncControls();}
      else{if(job.record){history.push(clone(state));if(history.length>30)history.shift();}state=job.next;result=r;lastElapsed=data.elapsed;render();syncControls();note(job.message);}
      $('#stages').setAttribute('aria-busy','false');job.resolve(r);
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
  $('#undo').disabled=!history.length;$('#release').disabled=!state.prefix.length&&!c.endAfterStage;
}
function traceText(t){return t.message||t.text||t.title||rules.find(r=>r.id===t.ruleId)?.title||t.rule||'规则已触发';}
function traceHTML(t){const ins=t.inputFacts||[],outs=t.outputFacts||[];return `<div class="trace-item"><span class="trace-id">${esc(t.ruleId||t.id||t.rule||'状态更新')}</span><p>${esc(traceText(t))}</p>${ins.length?`<p>输入：${esc(ins.map(x=>typeof x==='string'?x:JSON.stringify(x)).join('；'))}</p>`:''}${outs.length?`<p>推导：${esc(outs.map(x=>typeof x==='string'?x:JSON.stringify(x)).join('；'))}</p>`:''}</div>`;}
function metricsHTML(m={}){return `<div class="metrics">${[['我方偏好',m.utilityA??m.satisfactionA??m.preferenceA],['对方偏好',m.utilityB??m.satisfactionB??m.preferenceB],['公平指标',m.fairness],['新鲜度',m.novelty],['占用分钟',m.totalMinutes],['终段负担',Math.max(...Object.values(m.predictedLoadByPerson||{}))]].filter(([,v])=>Number.isFinite(v)).map(([k,v])=>`<div class="metric"><span>${k}</span><strong>${Math.round(v*100)/100}</strong></div>`).join('')}</div>`;}
function render(){
  const focused=document.activeElement;
  const focusTarget=focused?.dataset?.stage!==undefined?{stage:focused.dataset.stage,scene:focused.dataset.scene,activity:focused.dataset.activity}:null;
  const positions=Object.fromEntries($$('.scene-strip').map(x=>[x.dataset.index,x.scrollLeft]));
  $('#stages').innerHTML=result.stages.map(st=>{
    const scene=sceneById.get(st.sceneId),cs=[...(st.candidates||[])];if(!cs.some(c=>c.sceneId===scene.id))cs.unshift({sceneId:scene.id,score:st.score??st.recommendationIndex,activityIds:st.activityIds});
    const cards=cs.map(c=>{const sc=sceneById.get(c.sceneId);if(!sc)return '';const selected=sc.id===scene.id;return `<div class="scene-card${selected?' selected':''}" role="radio" aria-checked="${selected}" tabindex="0" data-stage="${st.index}" data-scene="${sc.id}" aria-label="${esc(sc.title)}，推荐指数${Math.round(c.score??c.recommendationIndex??st.score??50)}%，点击选择"><h3 class="scene-title">${esc(sc.title)}</h3><p class="scene-score">推荐指数：${Math.round(c.score??c.recommendationIndex??st.score??50)}%</p><p class="scene-desc">${esc(sc.description)}</p></div>`;}).join('');
    let acts='';
    if(scene.kind==='rest')acts='<p class="rest-note">这一段只休息，不需要再选活动；恢复一点，再继续出发。</p>';
    else if(!scene.activities.length)acts='<p class="empty-activities">场景已经包含基本体验，可以直接享受这一段。</p>';
    else acts=[...new Set(scene.activities.map(a=>a.group))].map(group=>{const aa=scene.activities.filter(a=>a.group===group),single=aa[0].mode==='single';return `<div class="activity-label">${single?'单选，也可以不选':'可多选，也可以全部取消'}</div><div class="activity-row">${aa.map(a=>{const selected=st.activityIds.includes(a.id);return `<label class="activity-card${selected?' selected':''}" title="${esc(a.description)}"><input type="checkbox" data-stage="${st.index}" data-activity="${a.id}" ${selected?'checked':''} aria-label="${esc(a.title)}，${esc(a.description)}"><span>${esc(a.title)}${a.requiresExplicitConsent?' · 双方同意':''}<small>${a.compositionMode==='included'?'已含于场景':a.compositionMode==='parallel'?'并行':`＋${a.minutes}分钟`} · ${costLabel(a.cost)}</small></span></label>`;}).join('')}</div>`;}).join('');
    return `<section class="stage" aria-label="阶段${st.index+1}"><div class="stage-heading"><span class="stage-number">${String(st.index+1).padStart(2,'0')}</span><span class="stage-name">${st.index===0?'从这里开始':scene.kind==='rest'?'先缓一缓':'接着，去做点什么'}${st.manual?'<span class="chosen-note">已选</span>':''}</span><span class="stage-time">${formatTime(st.start??st.startMinute)}—${formatTime(st.end??st.endMinute)}</span></div>${st.transfer?`<div class="transfer">转场预留 ${st.transfer} 分钟 · 模型估计</div>`:''}<div class="scene-strip" role="radiogroup" aria-label="阶段${st.index+1}场景" data-index="${st.index}">${cards}</div>${acts}<div class="stage-meta">此段预计 <strong>${st.minutes} 分钟 · 两人 ${costLabel(st.cost)}</strong><button class="text-button" data-end="${st.index}">在这里自然结束</button></div></section>`;
  }).join('');
  for(const [i,pos]of Object.entries(positions)){const el=$(`.scene-strip[data-index="${i}"]`);if(el)el.scrollLeft=pos;}
  const r=result;
  $('#ending').innerHTML=`<h2>到这里，刚刚好。</h2><p>留出 ${r.endingBuffer??r.metrics?.endingBuffer??15} 分钟给结束与机动。实际返程请确认。</p><p>双人预计支出 <span class="total-price">${costLabel(r.totalCost)}</span></p>${metricsHTML(r.metrics)}<p>${esc(r.status==='optimal_in_model'?'有限模型内已穷尽，找到最优方案。':'已找到模型内可行方案，搜索范围内保留多种取舍。')} 费用与负担为设计估值。</p>`;
  $('#reason-content').innerHTML=result.stages.map(st=>{const s=sceneById.get(st.sceneId),refs=[...new Set([...(s.evidenceIds||[]),...s.activities.filter(a=>st.activityIds.includes(a.id)).flatMap(a=>a.evidenceIds||[]),...(st.trace||[]).flatMap(t=>t.evidenceIds||[])])].map(id=>evidence.find(e=>e.id===id)).filter(Boolean);const loadBefore=st.before?.fatigue||st.stateBefore?.fatigue||[],loadAfter=st.after?.fatigue||st.stateAfter?.fatigue||[];return `<div class="evidence"><h3>阶段 ${st.index+1} · ${esc(s.title)}</h3><p>模型负担：${esc(loadBefore.join(' / '))} → ${esc(loadAfter.join(' / '))}，按双方分别更新。</p>${(st.trace||[]).slice(0,8).map(traceHTML).join('')}${refs.map(e=>`<p>来源 ${esc(sourceById.get(e.sourceDocumentId||e.sourceId)?.title||e.sourceDocumentId||e.sourceId)} · ${esc(e.sourceLocator||e.locator)} · ${esc(e.id)}：${esc(e.summary)}（${esc(e.assertionKind||e.sourceKind)}）</p>`).join('')}<p>准备：${esc((st.preparationIds||s.preparationIds||[]).map(id=>preparationOptions.find(x=>x.id===id)?.label||id).join('、')||'按场景基本体验，出发前确认开放与可用性。')}</p></div>`;}).join('')+`<p class="field-hint">${esc((r.warnings||[]).join('；'))}</p>`;
  $('#replay-id').textContent=`输入 ${r.fingerprint} · 输出 ${r.outputFingerprint} · ${catalog.version}`;
  renderReasoning();renderComparison();bindCards();
  // 重算替换卡片节点后恢复键盘焦点，避免Tab从页面开头重新开始。
  if(focusTarget){
    const {stage,scene,activity}=focusTarget;
    const selector=activity?`input[data-stage="${stage}"][data-activity="${CSS.escape(activity)}"]`:scene?`.scene-card[data-stage="${stage}"][data-scene="${CSS.escape(scene)}"]`:null;
    const target=(selector?$(selector):null)||$(`.scene-card.selected[data-stage="${stage}"]`);
    target?.focus({preventScroll:true});
  }
}
async function commitStage(index,sceneId,activityIds){
  const intended=snapshot();
  const prefix=result.stages.slice(0,index).map((s,i)=>intended.prefix[i]||{sceneId:s.sceneId,activityIds:[...s.activityIds]});prefix.push({sceneId,activityIds});
  const next=snapshot();next.prefix=prefix;delete next.context.endAfterStage;
  // “双方同意”活动的勾选是用户明确声明，取消后撤销该活动的同意事实。
  next.context.explicitConsentIds=prefix.flatMap(choice=>sceneById.get(choice.sceneId).activities.filter(a=>a.requiresExplicitConsent&&choice.activityIds.includes(a.id)).map(a=>a.id));
  const r=await compute(next,'已保留前面的阶段，并按这段选择重新规划后续。');if(!r?.ok)render();return !!r?.ok;
}
function bindCards(){
  $$('.scene-card').forEach(el=>{const choose=()=>{if(el.dataset.dragged==='1')return;const i=Number(el.dataset.stage),id=el.dataset.scene,c=result.stages[i].candidates?.find(c=>c.sceneId===id);commitStage(i,id,result.stages[i].sceneId===id?result.stages[i].activityIds:c?.activityIds||sceneById.get(id).default||[]);};el.addEventListener('click',choose);el.addEventListener('keydown',ev=>{if(['Enter',' '].includes(ev.key)){ev.preventDefault();choose();}else if(['ArrowRight','ArrowLeft'].includes(ev.key)){ev.preventDefault();const target=ev.key==='ArrowRight'?el.nextElementSibling:el.previousElementSibling;target?.focus();target?.scrollIntoView({block:'nearest',inline:'nearest'});}});});
  $$('input[data-activity]').forEach(el=>el.addEventListener('change',()=>{const i=Number(el.dataset.stage),st=result.stages[i],desired=snapshot().prefix[i];const ids=desired?.sceneId===st.sceneId?desired.activityIds:st.activityIds;commitStage(i,st.sceneId,toggleActivity(sceneById.get(st.sceneId),ids,el.dataset.activity));}));
  $$('[data-end]').forEach(el=>el.addEventListener('click',()=>{const next=snapshot();next.context.endAfterStage=Number(el.dataset.end);next.prefix=result.stages.slice(0,next.context.endAfterStage+1).map(s=>({sceneId:s.sceneId,activityIds:s.activityIds}));compute(next,'已按你的选择自然结束，预算与时间同步重算。');}));
  $$('.scene-strip').forEach(el=>{let down=false,start=0,scroll=0,target;el.addEventListener('pointerdown',ev=>{if(ev.pointerType!=='mouse')return;down=true;start=ev.clientX;scroll=el.scrollLeft;target=ev.target.closest('.scene-card');});el.addEventListener('pointermove',ev=>{if(!down)return;const dx=ev.clientX-start;if(Math.abs(dx)>7){el.scrollLeft=scroll-dx;ev.preventDefault();if(target)target.dataset.dragged='1';}});const up=()=>{down=false;const t=target;if(t)setTimeout(()=>delete t.dataset.dragged,80);};el.addEventListener('pointerup',up);el.addEventListener('pointerleave',up);});
}
const nodeById=new Map(graph.nodes.map(n=>[n.id,n]));
const predicates={allows_activity:'可包含',has_feature:'具有特征',supported_by:'依据',from_source:'来自',requires:'需要',provides:'提供',consumes:'消耗',governed_by:'受规则约束',depends_on:'前置依赖',derives:'推导'};
function graphQuery(){
  const paths=reasoning.queryGraph(graph,$('#graph-from').value,$('#graph-to').value,{maxDepth:5,maxPaths:6});
  $('#graph-paths').innerHTML=paths.length?paths.map(p=>`<div class="graph-path">${p.nodes.map((id,i)=>`${i?`<span class="graph-edge">${esc(predicates[p.edges[i-1].predicate]||p.edges[i-1].predicate)} →</span>`:''}<span class="graph-node" title="${esc(id)}">${esc(nodeById.get(id)?.label||id)}</span>`).join('')}<p class="field-hint">${p.edges.length} 跳 · 证据 ${esc(p.evidenceIds.join('、'))}</p></div>`).join(''):'<p class="field-hint">在最多5跳的有向图中没有找到路径。请更换起点或终点。</p>';
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
  $('#knowledge-counts').innerHTML=counts.map(([l,n])=>`<span>${n} ${l}</span>`).join('');$('#knowledge-summary').innerHTML=counts.map(([l,n])=>`<div class="stat-tile"><strong>${n}</strong><span>${l}</span></div>`).join('');
  const byType={scene:'场景',activity:'活动',feature:'特征',tag:'兴趣',preparation:'准备',rule:'规则',evidence:'证据',source:'来源',condition:'条件'};
  const nodes=[...graph.nodes].sort((a,b)=>a.type.localeCompare(b.type)||a.label.localeCompare(b.label,'zh'));
  const options=nodes.map(n=>`<option value="${esc(n.id)}">${byType[n.type]||n.type} · ${esc(n.label.slice(0,40))}</option>`).join('');$('#graph-from').innerHTML=options;$('#graph-to').innerHTML=options;
  $('#graph-from').value='mall';$('#graph-to').value='tag:play';graphQuery();
  const adopted=sources.filter(s=>s.adoptedEvidenceIds?.length);$('#source-audit').innerHTML=`<p class="field-hint">${sources.length}份本地语料登记 · ${adopted.length}份来源形成采用证据 · ${evidence.length}条原创摘要。关键词候选经过局部核对后才能成为证据，模型参数单独标为设计值。</p>`+adopted.map(s=>`<div class="source-item"><strong>${esc(s.title)}</strong><br>${esc(s.category)} · ${s.adoptedEvidenceIds.length}条证据 · SHA-256 ${s.sha256.slice(0,14)}…<br>本地文本已定位；现实信息与作品归属需回源核实。</div>`).join('');
  if(matchMedia('(max-width:680px)').matches)$('#conditions').open=false;
}
$('#conditions-form').addEventListener('submit',ev=>{ev.preventDefault();applyConditions();});
async function applyConditions(){try{const next=snapshot();next.context=readContext();const r=await compute(next,'条件已更新；未勾选的兴趣仍然是未知。');if(r&&!r.ok&&state.prefix.length)note('新条件与已选阶段或锚点冲突。点击“释放已选”后再应用，或调整限制。',true);}catch(e){note(e.message,true);}}
$('#conditions-form').addEventListener('change',ev=>{if(ev.target.id==='saving'){$('#budget').disabled=ev.target.checked;if(ev.target.checked)$('#budget').value=50;else $('#budget').value='';}applyConditions();});
$('#exploration').addEventListener('input',ev=>{const e=Number(ev.target.value);$('#exploration-value').innerHTML=`${e}<small>/ 100</small>`;clearTimeout(sliderTimer);sliderTimer=setTimeout(()=>{const next=snapshot();next.exploration=e;compute(next,'探索度已更新：固定已选阶段，重新比较可行后续。');},130);});
$('#undo').addEventListener('click',()=>{if(!history.length)return;const prev=history.pop();compute(prev,'已恢复上一次完整状态。',{record:false});});
$('#release').addEventListener('click',()=>{const next=snapshot();next.prefix=[];delete next.context.endAfterStage;compute(next,'已释放手动选择，现在可以探索整场安排。');});
$('#reset').addEventListener('click',()=>compute({context:defaultContext(),exploration:0,prefix:[]},'已回到零输入默认安排。'));
$$('[data-view]').forEach(b=>b.addEventListener('click',()=>{$$('[data-view]').forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-pressed',String(x===b));});$$('.view').forEach(x=>x.hidden=x.id!==`view-${b.dataset.view}`);}));
$('#query-graph').addEventListener('click',graphQuery);
$('#export').addEventListener('click',()=>{
  if(!result?.ok)return;
  if(busy){note('计算完成后再导出，保证输入与输出一致。');return;}
  const payload={format:'datemate-ui-replay-3.0',state:snapshot(),versions:result.versions,search:result.replay?.search,engineReplay:result.replay,outputFingerprint:result.outputFingerprint};
  const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`DateMate_复盘_${result.fingerprint}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);note('已导出复盘；文件包含当前条件，分享前请检查内容。');
});
$('#import').addEventListener('click',()=>$('#import-file').click());
async function loadReplay(obj){
  const p=validateReplay(obj);
  if(JSON.stringify(p.versions)!==JSON.stringify(result?.versions)||JSON.stringify(p.search)!==JSON.stringify(result?.replay?.search))throw Error('数据、规则、评分或搜索版本不匹配，无法保证复现。');
  return compute(p.state,'复盘成功：输入与输出校验一致。',{expectedDigest:p.outputFingerprint});
}
$('#import-file').addEventListener('change',async ev=>{const file=ev.target.files[0];if(!file)return;try{if(file.size>200000)throw Error('复盘文件超过200KB限制。');await loadReplay(JSON.parse(await file.text()));}catch(e){note(`导入失败：${e.message}`,true);}ev.target.value='';});
initializeKnowledge();syncControls();
compute(state,'第一份灵感已生成。横滑浏览，点击场景或勾选活动，让后续跟着改变。',{record:false});
