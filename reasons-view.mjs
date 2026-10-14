import {explainDecision,formatFact} from './explanations.mjs?v=32c9a437a5c51c9d';
import {escapeHTML as esc,formatTime} from './planner.mjs?v=32c9a437a5c51c9d';

const paragraphs = lines => lines.map(line => `<p>${esc(line)}</p>`).join('');
const factLabels = {'context.weather':'天气','context.fatigueA':'我方疲惫值','context.fatigueB':'对方疲惫值','context.budget':'预算','context.prepared':'可用准备项','scene.kind':'地点类型','scene.load':'地点负担','activity.load':'活动负担','derived.needsRecovery':'恢复需求','explicitPreference':'明示偏好','composition':'活动组合','costCents':'费用（分）','minutes':'分钟'};
function factsHTML(facts) {
  if (!facts?.length) return '<p class="reason-empty">无新增事实</p>';
  return `<dl class="reason-facts">${facts.map(fact => {
    if (typeof fact !== 'object' || fact === null) return `<dd>${esc(formatFact(fact))}</dd>`;
    const id = fact.id || fact.fact || fact.path;
    return `<dt>${esc(factLabels[id] || id || '事实')}</dt><dd><pre>${esc(formatFact(Object.hasOwn(fact,'value') ? fact.value : fact))}</pre></dd>`;
  }).join('')}</dl>`;
}

/** 只在用户展开时生成详细记录；每批少量节点，并在新规划开始时废弃旧批次。 */
export function createReasonView({container, scenes, rules}) {
  const outer = container.closest('details'), view = container.ownerDocument.defaultView;
  const sceneById = new Map(scenes.map(s => [s.id,s])), ruleById = new Map(rules.map(r => [r.id,r]));
  let result = null, context = null, revision = 0, rendered = false, decisions = [];
  function render() {
    if (!result || rendered || !outer.open) return;
    rendered = true;
    if (!result.ok) {
      container.innerHTML = '<p>当前条件还没有可行安排。</p>' + paragraphs(result.errors || []);
      return;
    }
    decisions = result.stages.map(stage => explainDecision(stage, sceneById.get(stage.sceneId), context));
    container.innerHTML = result.stages.map((stage,index) => {
      const decision = decisions[index], place = sceneById.get(stage.sceneId);
      return `<section class="reason-item"><h3>${index+1}. ${esc(place.title)} <span class="reason-time">${formatTime(stage.startMinute)}–${formatTime(stage.endMinute)}</span></h3>${paragraphs(decision.summary)}<div class="decision-basis"><h4>决策依据</h4><p>${esc(decision.selection.message)}</p><p>${esc(decision.comparison.message)}</p></div><details data-reason-kind="score" data-stage="${index}"><summary>评分与状态变化</summary><div class="reason-detail-body"></div></details><details data-reason-kind="trace" data-stage="${index}"><summary>原始推理过程（${decision.trace.length} 条）</summary><div class="reason-detail-body"></div></details></section>`;
    }).join('');
    const skipped = (result.mealRequirements || []).filter(meal => meal.choiceMode !== 'together');
    container.insertAdjacentHTML('beforeend', skipped.map(meal => `<section class="reason-item"><h3>${esc(meal.label)}</h3><p>${meal.choiceMode === 'before_meeting' ? '会面前吃早餐：早餐不占见面后的时间，见面后直接安排活动。' : '不吃宵夜：去除这一餐的时间和费用，继续连接前后的活动。'}</p></section>`).join(''));
    if (result.departure) container.insertAdjacentHTML('beforeend', `<section class="reason-item"><h3>分别</h3><p>所选方式：${esc(result.departure.title || result.departure.id)}。预留 ${result.departure.reservedMinutes} 分钟；费用上界 ${result.departure.cost[1]} rmb，已纳入整段时间与预算校验。</p></section>`);
  }
  function scoreHTML(decision) {
    const metrics = decision.metrics;
    return `<p class="score-calculation">${esc(metrics.calculation)}</p><table class="reason-table"><thead><tr><th>特征项</th><th>引擎记录值</th></tr></thead><tbody>${metrics.features.map(feature => `<tr><td>${esc(feature.label)}</td><td>${esc(formatFact(feature.value))}</td></tr>`).join('')}</tbody></table><p class="field-hint">${esc(metrics.featureNote)}</p><details data-reason-kind="stage-raw"><summary>原始阶段与约束数据</summary><pre class="raw-reason">${esc(formatFact({metrics:metrics.stageFacts,constraints:decision.selection.constraints,scoreReference:metrics.scoreReference,candidates:decision.comparison.candidates}))}</pre></details>`;
  }
  function traceHTML(trace,index,stageIndex) {
    const id = trace.ruleId || trace.rule || trace.id;
    const title = ruleById.get(id)?.title || trace.title;
    return `<article class="reason-trace-step"><h4>${index+1}. ${esc(title)} <code>${esc(id)}</code></h4><p>${esc(trace.message || trace.text || '')}</p><div class="reason-trace-columns"><section><h5>输入事实</h5>${factsHTML(trace.inputFacts)}</section><section><h5>推导结果</h5>${factsHTML(trace.outputFacts)}</section></div>${trace.evidenceIds?.length ? `<p class="field-hint">依据：${esc(trace.evidenceIds.join('、'))}</p>` : ''}<details data-reason-kind="raw" data-stage="${stageIndex}" data-trace="${index}"><summary>原始记录</summary><div class="reason-detail-body"></div></details></article>`;
  }
  container.addEventListener('toggle', event => {
    const detail = event.target;
    if (!detail.open || !detail.dataset.reasonKind || detail.dataset.loaded) return;
    const decision = decisions[Number(detail.dataset.stage)];
    if (!decision) return;
    detail.dataset.loaded = 'true';
    const body = detail.querySelector('.reason-detail-body');
    if (detail.dataset.reasonKind === 'score') body.innerHTML = scoreHTML(decision);
    else if (detail.dataset.reasonKind === 'raw') body.innerHTML = `<pre class="raw-reason">${esc(formatFact(decision.trace[Number(detail.dataset.trace)].raw))}</pre>`;
    else if (detail.dataset.reasonKind === 'trace') {
      const token = revision, stageIndex = Number(detail.dataset.stage); let cursor = 0;
      function append() {
        if (token !== revision || !body.isConnected) return;
        const end = Math.min(cursor + 6, decision.trace.length);
        body.insertAdjacentHTML('beforeend', decision.trace.slice(cursor,end).map((trace,i) => traceHTML(trace,cursor+i,stageIndex)).join(''));
        cursor = end;
        if (cursor < decision.trace.length) view.requestAnimationFrame(append);
      }
      append();
    }
  }, true);
  outer.addEventListener('toggle', render);
  return {
    pending() {revision++; result = null; rendered = false; decisions = [];},
    setResult(nextResult, nextContext) {
      revision++; result = nextResult; context = nextContext; rendered = false; decisions = [];
      container.replaceChildren(); render();
    },
  };
}
