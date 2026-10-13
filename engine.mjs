import { canonical, digest, forwardChain, buildKnowledgeGraph, queryGraph, DEFAULT_RULES, REASONING_VERSION } from './reasoning.mjs';

export { canonical, digest } from './reasoning.mjs';
export const VERSION = 'datemate-engine-3.0.4';
export const CONFIG = Object.freeze({ method: 'bounded', maxStages: 8, beamWidth: 24, maxExpandedNodes: 18000, maxCandidateExpandedNodes: 6000, activitySubsetLimit: 64, candidateLimit: 20, scoreVersion: 'planning-fit-3.0.2', tieBreak: 'stable-id' });
const cmp = (a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const copy = value => JSON.parse(JSON.stringify(value));
const list = value => [...new Set(Array.isArray(value) ? value.filter(x => typeof x === 'string') : [])].sort(cmp);
const number = (value, fallback) => value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback;
const integer = (value, fallback, low, high) => clamp(Math.round(number(value, fallback)), low, high);
const cents = value => Math.round(number(value, 0) * 100);
const money = value => value / 100;
const fail = (code, message) => `${code}:${message}`;

function range(value, fallback = 0) {
  if (Array.isArray(value)) return [number(value[0], fallback), number(value[1], value[0] ?? fallback)];
  if (value && typeof value === 'object') return [number(value.low, fallback), number(value.high, value.low ?? fallback)];
  return [number(value, fallback), number(value, fallback)];
}
function inventory(value) {
  if (Array.isArray(value)) return Object.fromEntries(list(value).map(id => [id, 1]));
  return Object.fromEntries(Object.entries(value || {}).filter(([, n]) => Number.isFinite(Number(n)) && Number(n) > 0).map(([id, n]) => [id, Number(n)]).sort(([a], [b]) => cmp(a, b)));
}
function normalizeWindows(raw, duration) {
  if (!Array.isArray(raw) || !raw.length) return [{ id: 'window-0', startMinute: 0, endMinute: duration }];
  const windows = raw.map((w, i) => ({ id: w.id || `window-${i}`, startMinute: number(w.startMinute ?? w.start, NaN), endMinute: number(w.endMinute ?? w.end, NaN) })).sort((a, b) => a.startMinute - b.startMinute || cmp(a.id, b.id));
  if (windows.some(w => !Number.isInteger(w.startMinute) || !Number.isInteger(w.endMinute) || w.startMinute < 0 || w.endMinute <= w.startMinute)) throw Error(fail('H_WINDOWS', '时间窗需使用非负整数分钟，结束必须晚于开始。'));
  if (new Set(windows.map(w => w.id)).size !== windows.length || windows.some((w, i) => i > 0 && w.startMinute < windows[i - 1].endMinute)) throw Error(fail('H_WINDOWS', '时间窗ID不得重复，时间窗不得重叠。'));
  return windows;
}

export function normalize(input = {}) {
  const raw = input.context ? { ...input.context, ...input } : input;
  const windowTotal = Array.isArray(raw.windows) && raw.windows.length ? raw.windows.reduce((sum, w) => sum + number(w.endMinute ?? w.end, 0) - number(w.startMinute ?? w.start, 0), 0) : 180;
  const duration = integer(raw.duration ?? raw.minutes, windowTotal, 1, 2880);
  const budget = raw.budgetHighCents !== undefined && raw.budgetHighCents !== null ? raw.budgetHighCents / 100 : raw.budget;
  const preparedIds = list(raw.preparedIds ?? raw.prepared);
  const resources = { ...inventory(preparedIds), ...inventory(raw.resources) };
  const ctx = {
    duration, budget: budget === undefined || budget === null || budget === '' ? null : number(budget, NaN),
    reserve: integer(raw.reserve, 15, 0, 240), robust: raw.robust !== false,
    weather: ['clear', 'rain', 'unknown'].includes(raw.weather) ? raw.weather : 'unknown',
    area: raw.area === 'nearby' ? 'near' : ['campus', 'near', 'all'].includes(raw.area) ? raw.area : 'all',
    fatigueA: clamp(number(raw.fatigueA, 2), 0, 10), fatigueB: clamp(number(raw.fatigueB, 2), 0, 10),
    goals: list(raw.goals), preferences: list(raw.preferences), preferencesA: list(raw.preferencesA), preferencesB: list(raw.preferencesB),
    bans: list(raw.bans), excludedSceneTypes: list(raw.excludedSceneTypes), excludedActivityTypes: list(raw.excludedActivityTypes),
    quietRequired: raw.quietRequired === true, mentalLow: raw.mentalLow === true, crowdAvoidance: raw.crowdAvoidance === true,
    mealNeed: raw.mealNeed === true || raw.requireMeal === true, requireMeal: raw.mealNeed === true || raw.requireMeal === true,
    theme: ['any', 'daily', 'romantic', 'fresh'].includes(raw.theme) ? raw.theme : 'any',
    dietaryRestrictions: list(raw.dietaryRestrictions), preparedIds, prepared: Object.keys(resources).sort(cmp), resources,
    explicitConsentIds: list(raw.explicitConsentIds ?? raw.consentIds), availability: { ...(raw.availability || {}) },
    windows: normalizeWindows(raw.windows, duration), initialArea: raw.initialArea === 'nearby' ? 'near' : raw.initialArea || 'campus',
    maxLoad: clamp(number(raw.maxLoad, 10), 0, 10), endAfterStage: raw.endAfterStage === undefined || raw.endAfterStage === null ? null : integer(raw.endAfterStage, 0, 0, 23),
    facts: copy(raw.facts || {}), energy: raw.energy ?? ((Math.max(number(raw.fatigueA, 2), number(raw.fatigueB, 2)) >= 6) ? 'low' : 'normal'),
  };
  if (ctx.budget !== null && (!Number.isFinite(ctx.budget) || ctx.budget < 0)) throw Error(fail('H_BUDGET', '预算必须为非负金额或未指定。'));
  ctx.budgetHigh = ctx.budget;
  ctx.budgetHighCents = ctx.budget === null ? null : cents(ctx.budget);
  ctx.minutes = ctx.duration;
  return ctx;
}

function normalizeAction(action, scene) {
  const costs = action.costCents ? range(action.costCents).map(Math.round) : range(action.cost ?? action.baseline?.cost).map(cents);
  const load = range(action.load ?? action.baseline?.load)[1];
  if (!action.id || costs.some(n => n < 0) || costs[1] < costs[0] || !Number.isFinite(load)) throw Error(fail('H_DATA', `活动${action.id || '(无ID)'}的资源字段无效。`));
  return { ...action, id: String(action.id), minutes: 0, costCents: costs, load, group: action.group || 'optional', mode: action.compositionMode === 'exclusive' ? 'single' : action.mode || 'multiple', tags: list(action.tags), compositionMode: 'within_scene', predecessorIds: list(action.predecessorIds), preparationIds: list(action.preparationIds), requires: inventory(action.requires ?? action.preconditions), provides: inventory(action.provides), consumes: inventory(action.consumes), sceneId: scene.id };
}

function compileCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.scenes) || !catalog.scenes.length) throw Error(fail('H_DATA', '场景目录为空。'));
  const flat = new Map((catalog.activities || []).map(a => [a.id, a]));
  const scenes = [...catalog.scenes].sort((a, b) => cmp(a.id, b.id)).map(raw => {
    const scene = { ...raw, area: raw.area === 'nearby' ? 'near' : raw.area || raw.areaClass || 'campus', kind: raw.kind || raw.typeId || 'ordinary', tags: list(raw.tags) };
    scene.minutes = range(raw.minutes ?? raw.baseline?.duration)[1];
    scene.costCents = raw.costCents ? range(raw.costCents).map(Math.round) : range(raw.cost ?? raw.baseline?.cost).map(cents);
    scene.load = range(raw.load)[1];
    scene.loadByPerson = raw.loadByPerson || raw.loadBySubject || raw.baseline?.loadBySubject;
    scene.preparationIds = list(raw.preparationIds);
    scene.requires = inventory(raw.requires ?? raw.preconditions);
    scene.provides = inventory(raw.provides); scene.consumes = inventory(raw.consumes);
    scene.fit = number(raw.fit ?? raw.featureValues?.comfort, 70);
    scene.novelty = number(raw.novelty ?? raw.featureValues?.novelty, 40);
    if (!scene.id || !Number.isInteger(scene.minutes) || scene.minutes <= 0 || scene.costCents.some(n => n < 0) || scene.costCents[1] < scene.costCents[0]) throw Error(fail('H_DATA', `场景${scene.id || '(无ID)'}必须有正整数时长与有效费用区间。`));
    let acts = raw.activities || raw.activityIds?.map(id => flat.get(id)) || [];
    if (!acts.length && raw.activityGroups) acts = list(raw.activityGroups.flatMap(g => g.activityIds || [])).map(id => ({ ...flat.get(id), group: raw.activityGroups.find(g => g.activityIds?.includes(id)).id, mode: raw.activityGroups.find(g => g.activityIds?.includes(id)).mode }));
    if (acts.some(a => !a || (typeof a === 'string' && !flat.has(a)))) throw Error(fail('H_DATA', '场景引用了不存在的活动。'));
    scene.activities = acts.map(a => normalizeAction(typeof a === 'string' ? flat.get(a) : a, scene)).sort((a, b) => cmp(a.id, b.id));
    if (new Set(scene.activities.map(a => a.id)).size !== scene.activities.length) throw Error(fail('H_DATA', '同一场景中的活动ID重复。'));
    if (scene.kind === 'rest' && scene.activities.length) throw Error(fail('H_DATA', '独立休息场景不得包含活动卡。'));
    return scene;
  });
  if (new Set(scenes.map(s => s.id)).size !== scenes.length) throw Error(fail('H_DATA', '场景ID重复。'));
  return { scenes, byId: new Map(scenes.map(s => [s.id, s])), graph: buildKnowledgeGraph({ ...catalog, scenes }), rules: [...DEFAULT_RULES, ...(catalog.rules || [])], version: catalog.version || 'unversioned' };
}

export function normalizePrefix(prefix = [], catalog) {
  const compiled = compileCatalog(catalog);
  if (!Array.isArray(prefix) || prefix.length > 24) throw Error(fail('H_PREFIX', '固定前缀必须为最多24个阶段的数组。'));
  return prefix.map(p => normalizeChoice(p, compiled));
}
function normalizeChoice(choice, compiled) {
  const scene = compiled.byId.get(choice?.sceneId);
  if (!scene) throw Error(fail('H_SCENE', '固定选择或锚点引用了不存在的场景。'));
  const ids = list(choice.activityIds || []);
  if (ids.some(id => !scene.activities.some(a => a.id === id))) throw Error(fail('H_ACTIVITY', '活动不属于当前场景。'));
  return { sceneId: scene.id, activityIds: ids, ...(choice.startMinute !== undefined ? { startMinute: choice.startMinute } : {}) };
}
function normalizeAnchors(raw, compiled, ctx) {
  if (!Array.isArray(raw)) throw Error(fail('H_ANCHOR', '锚点必须为数组。'));
  return raw.map((a, i) => {
    const anchor = { id: a.id || `anchor-${i}`, choice: normalizeChoice(a.choice || a, compiled), ...(a.index !== undefined ? { index: a.index } : {}), ...(a.startMinute !== undefined ? { startMinute: a.startMinute } : {}), ...(a.windowId ? { windowId: a.windowId } : {}) };
    if (anchor.index !== undefined && (!Number.isInteger(anchor.index) || anchor.index < 0 || anchor.index > 23)) throw Error(fail('H_ANCHOR', '锚点阶段序号无效。'));
    if (anchor.startMinute !== undefined && (!Number.isInteger(anchor.startMinute) || anchor.startMinute < 0)) throw Error(fail('H_ANCHOR', '预约开始需为非负整数分钟。'));
    if (anchor.windowId && !ctx.windows.some(w => w.id === anchor.windowId)) throw Error(fail('H_ANCHOR', '锚点引用了不存在的时间窗。'));
    return anchor;
  }); // 无位置锚点按输入顺序逐个保留，不悄悄排序用户意图。
}

function initial(ctx) {
  return { time: ctx.windows[0].startMinute, elapsed: 0, usedMinutes: 0, windowIndex: 0, uncertaintyByWindow: {}, uncertaintyTotal: 0, costCents: [0, 0], cost: [0, 0], fatigue: [ctx.fatigueA, ctx.fatigueB], resources: { ...ctx.resources }, completed: [], visited: [], kinds: [], mealWindows: [], meal: false, hasRest: false, last: null, lastKind: null, area: ctx.initialArea, anchorIndex: 0, utilities: [0, 0], novelty: 0, variety: 0, ruleUtility: 0, stages: [] };
}
function stateSnapshot(st, ctx) {
  return { elapsed: st.elapsed, elapsedMinutes: st.elapsed, absoluteMinute: st.time, usedMinutes: st.usedMinutes, windowIndex: st.windowIndex, uncertaintyByWindow: st.uncertaintyByWindow, uncertaintyMinutes: st.uncertaintyTotal, cost: st.cost, costCents: st.costCents, costLowCents: st.costCents[0], costHighCents: st.costCents[1], fatigue: st.fatigue, predictedLoadByPerson: { A: st.fatigue[0], B: st.fatigue[1] }, resources: st.resources, preparationRemaining: Object.keys(st.resources).filter(k => st.resources[k] > 0).sort(cmp), completedActionIds: st.completed, satisfiedGoalTags: list(st.stages.flatMap(s => s.tags || [])), visited: st.visited, kinds: st.kinds, last: st.last, area: st.area, meal: st.meal, hasRest: st.hasRest, remainingBudgetCents: ctx.budgetHighCents === null ? null : ctx.budgetHighCents - st.costCents[1] };
}

function transfer(st, scene, catalog) {
  if (scene.kind === 'rest' || scene.area === 'current') return 0;
  const configured = catalog.transfers?.[st.area]?.[scene.area];
  if (configured !== undefined) return integer(configured, 0, 0, 240);
  if (st.last === null) return scene.area === 'campus' ? 10 : scene.area === 'near' ? 20 : 40;
  if (scene.area === st.area) return 10;
  return scene.area === 'off' || st.area === 'off' ? 40 : 20;
}
function permittedGroups(scene, acts) {
  const groupCounts = new Map(), exclusive = new Set();
  for (const a of acts) {
    const group = scene.activityGroups?.find(g => g.id === a.group);
    const max = group?.max ?? (a.mode === 'single' ? 1 : Infinity);
    const count = (groupCounts.get(a.group) || 0) + 1;
    groupCounts.set(a.group, count);
    if (count > max) return false;
    if (a.exclusiveKey) { if (exclusive.has(a.exclusiveKey)) return false; exclusive.add(a.exclusiveKey); }
  }
  return true;
}
function enumerateSubsets(scene, limit, stats) {
  const out = [], acts = scene.activities;
  function visit(i, selected) {
    if (out.length >= limit) { stats.activitySubsetsTruncated = true; return; }
    if (i === acts.length) { if (permittedGroups(scene, selected)) out.push(selected.map(a => a.id)); return; }
    visit(i + 1, selected);
    if (permittedGroups(scene, [...selected, acts[i]])) visit(i + 1, [...selected, acts[i]]);
  }
  visit(0, []);
  return out;
}

function orderActivities(acts, completed) {
  const selected = new Map(acts.map(a => [a.id, a])), ordered = [], pending = new Set(selected.keys());
  for (const a of acts) if (a.predecessorIds.some(id => !selected.has(id) && !completed.includes(id))) return { error: fail('H_PREDECESSOR', `活动${a.id}缺少前置活动。`) };
  while (pending.size) {
    const ready = [...pending].filter(id => selected.get(id).predecessorIds.every(p => !pending.has(p))).sort(cmp);
    if (!ready.length) return { error: fail('H_PREDECESSOR_CYCLE', '活动前置关系存在循环。') };
    for (const id of ready) { ordered.push(selected.get(id)); pending.delete(id); }
  }
  return { ordered };
}
function scheduleWithinScene(scene, acts) {
  // 活动只在场景内执行，顺序记录依赖关系；阶段时长仅由场景决定，不分配活动耗时。
  return acts.map((a, order) => ({ activityId: a.id, order, predecessorIds: a.predecessorIds, startOffset: 0, endOffset: scene.minutes, compositionMode: 'within_scene' }));
}
function resourceCheck(item, resources, completed) {
  const required = { ...inventory(item.preparationIds), ...item.requires };
  for (const [id, count] of Object.entries(required)) if ((resources[id] || 0) < count && !completed.includes(id)) return fail('H_PREPARATION', `缺少准备或前置资源：${id}。`);
  for (const [id, count] of Object.entries(item.consumes)) if ((resources[id] || 0) < count) return fail('H_RESOURCE', `资源${id}不足。`);
  for (const [id, count] of Object.entries(item.consumes)) resources[id] -= count;
  for (const [id, count] of Object.entries(item.provides)) resources[id] = (resources[id] || 0) + count;
  return null;
}

function createEvaluator(ctx, compiled, catalog, exploration) {
  const reasoningCache = new Map(), preferenceCache = new Map();
  function infer(st, scene, activity) {
    const key = canonical([scene.id, activity?.id, st.fatigue, Object.keys(st.resources).filter(k => st.resources[k] > 0)]);
    if (!reasoningCache.has(key)) {
      const facts = { context: { ...ctx, fatigueA: st.fatigue[0], fatigueB: st.fatigue[1], prepared: Object.keys(st.resources).filter(k => st.resources[k] > 0).sort(cmp) }, scene, ...(activity ? { activity } : {}), state: { maxLoad: Math.max(...st.fatigue), predictedLoadByPerson: { A: st.fatigue[0], B: st.fatigue[1] } } };
      reasoningCache.set(key, forwardChain(facts, compiled.rules));
    }
    return reasoningCache.get(key);
  }
  function graphFeatures(scene, acts) {
    const key = canonical([scene.id, acts.map(a => a.id)]);
    if (preferenceCache.has(key)) return preferenceCache.get(key);
    const endpoints = list([...ctx.preferencesA, ...ctx.preferencesB, ...ctx.preferences, ...ctx.goals]);
    const matches = new Set(), trace = [], selected = new Set(acts.map(a => a.id));
    for (const tag of endpoints) {
      const paths = queryGraph(compiled.graph, scene.id, `preference:${tag}`, { maxDepth: 4, maxPaths: 12 }).filter(path => !path.nodes.some(id => scene.activities.some(a => a.id === id) && !selected.has(id)));
      if (paths.length) { matches.add(tag); const path = paths[0]; trace.push({ ruleId: 'KG_PREFERENCE_PATH', rule: 'KG_PREFERENCE_PATH', message: `沿场景—体验属性—明示偏好路径匹配${tag}`, path: path.nodes, edges: path.edges.map(e => e.id), inputFacts: [{ id: 'explicitPreference', value: tag }], outputFacts: [{ id: `feature.preference.${tag}`, value: true }], evidenceIds: path.evidenceIds, evidence: path.evidenceIds, assertionKind: 'designed' }); }
    }
    const result = { matches, trace };
    preferenceCache.set(key, result); return result;
  }
  function evaluate(st, choice, anchor, manual = false) {
    const scene = compiled.byId.get(choice.sceneId);
    if (!scene) return { errors: [fail('H_SCENE', '场景不存在。')] };
    const ids = list(choice.activityIds), acts = scene.activities.filter(a => ids.includes(a.id));
    const errors = [];
    if (acts.length !== ids.length) errors.push(fail('H_ACTIVITY', '活动不属于当前场景。'));
    if (!permittedGroups(scene, acts)) errors.push(fail('H_EXCLUSIVE', '单选组或互斥活动发生冲突。'));
    if (ctx.bans.includes(scene.id) || ctx.bans.includes(`kind:${scene.kind}`) || ctx.excludedSceneTypes.includes(scene.typeId || scene.kind)) errors.push(fail('H_EXCLUDED', '场景或场景类型已排除。'));
    if (scene.publicAllowed === false || scene.reviewStatus === 'rejected' || scene.reviewStatus === 'draft') errors.push(fail('H_REVIEW', '场景未通过公开使用审核。'));
    if (ctx.availability[scene.id] === 'unavailable') errors.push(fail('H_AVAILABILITY', '场景明确不可用。'));
    if (ctx.area === 'campus' && !['campus', 'current'].includes(scene.area) || ctx.area === 'near' && scene.area === 'off') errors.push(fail('H_RANGE', '超出本次地点范围。'));
    if (ctx.quietRequired && scene.quiet !== true) errors.push(fail('H_QUIET', '与明示安静要求不符。'));
    if (ctx.mentalLow && number(scene.mental, 0) >= 4) errors.push(fail('H_MENTAL', '超过本次认知负担上限。'));
    if (ctx.crowdAvoidance && (scene.crowded === true || scene.uncrowded === false)) errors.push(fail('H_CROWD', '与避开拥挤要求不符。'));
    if (scene.kind === 'rest' && st.lastKind === 'rest') errors.push(fail('H_REST_LOOP', '不连续安排重复休息。'));
    const dietary = list([...(scene.dietaryTags || []), ...acts.flatMap(a => a.dietaryTags || [])]);
    if (ctx.dietaryRestrictions.some(tag => dietary.includes(tag))) errors.push(fail('H_DIET', '具体食物或活动与明示饮食限制冲突。'));
    const sceneInference = infer(st, scene), inferences = [sceneInference];
    if (sceneInference.excludedSceneIds.includes(scene.id)) errors.push(fail('H_RULE_SCENE', '产生式规则排除了当前场景。'));
    for (const a of acts) {
      if (ctx.bans.includes(a.id) || ctx.excludedActivityTypes.includes(a.typeId || a.kind) || a.publicAllowed === false || a.reviewStatus === 'rejected') errors.push(fail('H_ACTIVITY_EXCLUDED', `活动${a.id}不可选。`));
      if (a.requiresExplicitConsent === true && !ctx.explicitConsentIds.includes(a.id)) errors.push(fail('H_CONSENT', `活动${a.id}需要单独明确同意。`));
      const inferred = infer(st, scene, a); inferences.push(inferred);
      if (inferred.excludedActivityIds.includes(a.id) || inferred.excludedSceneIds.includes(scene.id)) errors.push(fail('H_RULE_ACTIVITY', `规则排除了活动${a.id}。`));
    }
    if (errors.length) return { errors };
    const ordering = orderActivities(acts, st.completed);
    if (ordering.error) return { errors: [ordering.error] };
    const schedule = scheduleWithinScene(scene, ordering.ordered);
    const resources = { ...st.resources }, completed = [...st.completed];
    let resourceError = resourceCheck(scene, resources, completed);
    if (resourceError) return { errors: [resourceError] };
    for (const a of ordering.ordered) {
      resourceError = resourceCheck(a, resources, completed);
      if (resourceError) return { errors: [resourceError] };
      completed.push(a.id);
    }
    for (const inferred of inferences) for (const id of inferred.requiredPreparations) if (!(st.resources[id] > 0) && !(resources[id] > 0)) return { errors: [fail('H_PREPARATION', `规则要求准备${id}。`)] };
    const costCents = scene.costCents.map((n, i) => n + acts.reduce((sum, a) => sum + a.costCents[i], 0));
    if (ctx.budgetHighCents !== null && st.costCents[1] + costCents[1] > ctx.budgetHighCents) return { errors: [fail('H_BUDGET', '按整数分核算的双人费用上界超过预算。')] };
    const load = [0, 1].map(i => range(scene.loadByPerson?.[i === 0 ? 'A' : 'B'] ?? scene.load)[1] + acts.reduce((sum, a) => sum + range(a.loadByPerson?.[i === 0 ? 'A' : 'B'] ?? a.load)[1], 0));
    const fatigueAfter = st.fatigue.map((f, i) => Math.max(0, f + load[i]));
    if (fatigueAfter.some(f => f > ctx.maxLoad)) return { errors: [fail('H_LOAD', '预计负担超过本次双方上限。')] };
    const transit = transfer(st, scene, catalog);
    const uncertainty = ctx.robust ? integer(scene.uncertaintyMinutes, scene.indoor === false && ctx.weather === 'unknown' ? 5 : scene.reliable === false ? 10 : 0, 0, 120) : 0;
    const exactStart = anchor?.startMinute ?? choice.startMinute;
    const isMeal = scene.kind === 'meal' || acts.some(a => a.exclusiveKey === 'main_meal' || a.provides.meal_completed > 0);
    let slot = null;
    for (let wi = st.windowIndex; wi < ctx.windows.length; wi++) {
      const window = ctx.windows[wi];
      if (anchor?.windowId && window.id !== anchor.windowId) continue;
      const depart = Math.max(st.time, window.startMinute), earliest = depart + transit;
      const priorUncertainty = st.uncertaintyByWindow[window.id] || 0;
      const openWindows = scene.windows || scene.openWindows;
      const sceneWindows = Array.isArray(openWindows) && openWindows.length ? [...openWindows].sort((a, b) => (a.startMinute ?? a.start) - (b.startMinute ?? b.start)) : [{ startMinute: window.startMinute, endMinute: window.endMinute }];
      const possible = sceneWindows.map(w => ({ start: exactStart ?? Math.max(earliest, w.startMinute ?? w.start), openEnd: w.endMinute ?? w.end, openStart: w.startMinute ?? w.start })).find(s => s.start >= earliest && (exactStart === undefined || s.start >= earliest + priorUncertainty) && s.start >= s.openStart && s.start + scene.minutes <= s.openEnd && s.start + scene.minutes + ctx.reserve + Math.max(0, priorUncertainty - (s.start - earliest)) + uncertainty <= window.endMinute);
      if (!possible) continue;
      const start = possible.start, end = start + scene.minutes;
      const uncertaintyCarry = Math.max(0, priorUncertainty - (start - earliest)) + uncertainty;
      const uncertaintyTotal = st.uncertaintyTotal - priorUncertainty + uncertaintyCarry;
      const reserve = ctx.reserve + uncertaintyCarry;
      if (acts.some(a => a.windows?.length && !a.windows.some(w => {
        const scheduled = schedule.find(s => s.activityId === a.id);
        return start + scheduled.startOffset >= (w.startMinute ?? w.start) && start + scheduled.endOffset <= (w.endMinute ?? w.end);
      }))) continue;
      const used = start - depart + scene.minutes;
      if (st.usedMinutes + used + ctx.reserve + uncertaintyTotal > ctx.duration) continue;
      if (isMeal && st.mealWindows.includes(window.id)) continue;
      slot = { start, end, windowIndex: wi, windowId: window.id, wait: start - earliest, used, reserve, uncertainty, uncertaintyCarry, uncertaintyTotal }; break;
    }
    if (!slot) return { errors: [fail('H_TIME_WINDOW', '阶段、转场、预约时间和必要缓冲无法放入可用时间窗。')] };
    const pendingAnchor = ctx.anchors?.[st.anchorIndex];
    if (!anchor && pendingAnchor?.startMinute !== undefined && slot.end > pendingAnchor.startMinute) return { errors: [fail('H_ANCHOR_TIME', '当前阶段会越过后续固定预约。')] };
    if (!manual && scene.kind === 'rest' && Math.max(...st.fatigue) < 3) return { errors: [fail('H_REST_USE', '当前预计负担下优先留白，不自动补休息。')] };
    const graph = graphFeatures(scene, acts), tags = list([...scene.tags, ...acts.flatMap(a => a.tags)]);
    const matchA = ctx.preferencesA.filter(p => graph.matches.has(p)).length, matchB = ctx.preferencesB.filter(p => graph.matches.has(p)).length;
    const sharedInterest = ctx.preferencesA.filter(p => ctx.preferencesB.includes(p) && graph.matches.has(p)).length * 8;
    const generalPreference = ctx.preferences.filter(p => graph.matches.has(p)).length * 5;
    const goalBonus = ctx.goals.filter(p => graph.matches.has(p) || tags.includes(p)).length * 6;
    const comfortPenalty = fatigueAfter.map(f => Math.max(0, f - 5) * 9);
    const restBase = Math.max(...st.fatigue) >= 3 ? 14 + Math.max(0, Math.max(...st.fatigue) - 3) * 12 : 2;
    const themeBonus = ctx.theme !== 'any' && (tags.includes(ctx.theme) || scene.theme === ctx.theme) ? 7 : 0;
    const fit = scene.kind === 'rest' ? restBase : scene.fit;
    // 地点匹配不能替代实际体验。选中的活动按明示兴趣增益，同类玩法递减，默认勾选不参与效用。
    const activityMatches = new Map();
    for (const a of acts) for (const tag of a.tags) activityMatches.set(tag, (activityMatches.get(tag) || 0) + 1);
    const experienceFor = preferences => preferences.reduce((sum, tag) => sum + (activityMatches.has(tag) ? 20 * (1 + 0.2 * (activityMatches.get(tag) - 1)) : 0), 0);
    const activityExperience = [experienceFor(ctx.preferencesA), experienceFor(ctx.preferencesB)];
    const sharedActivityExperience = ctx.preferencesA.filter(tag => ctx.preferencesB.includes(tag) && activityMatches.has(tag)).length * 8;
    const generalActivityExperience = ctx.preferences.filter(tag => activityMatches.has(tag)).length * 5 + ctx.goals.filter(tag => activityMatches.has(tag)).length * 6;
    const extraActivityPenalty = (2 * acts.length * (acts.length - 1) + acts.reduce((sum, a) => sum + 4 + Math.max(0, a.load) * 2 + a.costCents[1] * 0.003, 0)) * (1 - exploration / 100 * 0.7);
    const resourcePenalty = costCents[1] * 0.001 + scene.minutes * 0.05;
    const values = [matchA, matchB].map((matches, i) => Math.max(0, fit + matches * 18 + sharedInterest + generalPreference + goalBonus + themeBonus + activityExperience[i] + sharedActivityExperience + generalActivityExperience - comfortPenalty[i] - transit * 0.12 - extraActivityPenalty - resourcePenalty));
    const novelty = Math.max(scene.novelty, ...acts.map(a => number(a.novelty, 0)));
    const repeatFunctionPenalty = st.kinds.includes(scene.kind) ? 18 : 0;
    const repeatScenePenalty = st.visited.includes(scene.id) ? 36 : 0;
    const unnecessaryRestPenalty = scene.kind === 'rest' && Math.max(...st.fatigue) < 6 ? 35 : 0;
    const ruleBonus = (sceneInference.scenePreferences[scene.id] || 0) + acts.reduce((sum, a, i) => sum + (inferences[i + 1].activityPreferences[a.id] || 0), 0) - repeatFunctionPenalty - repeatScenePenalty - unnecessaryRestPenalty;
    const newKind = st.kinds.includes(scene.kind) ? 0 : 1;
    const discounted = 0.88 ** st.stages.length;
    const stageComplexityPenalty = 8 * (2 * st.stages.length + 1);
    const features = { preferenceA: matchA * 18, preferenceB: matchB * 18, sharedInterest, generalPreference, goalBonus, themeBonus, activityExperienceA: activityExperience[0], activityExperienceB: activityExperience[1], sharedActivityExperience, generalActivityExperience, comfort: fit - (comfortPenalty[0] + comfortPenalty[1]) / 2, transferPenalty: -transit * 0.12, extraActivityPenalty: -extraActivityPenalty, resourcePenalty: -resourcePenalty, repeatFunctionPenalty: -repeatFunctionPenalty, repeatScenePenalty: -repeatScenePenalty, unnecessaryRestPenalty: -unnecessaryRestPenalty, stageComplexityPenalty: -stageComplexityPenalty, novelty: novelty * exploration / 100 * 0.55, variety: newKind * (4 + exploration * 0.06), ruleBonus, fairnessFloor: Math.min(...values) * 0.3 };
    const stage = { sceneId: scene.id, activityIds: ids, minutes: scene.minutes, transfer: transit, wait: slot.wait, start: slot.start, end: slot.end, startMinute: slot.start, endMinute: slot.end, fixedStartMinute: exactStart ?? null, windowId: slot.windowId, cost: costCents.map(money), costCents, load: Math.max(...load), loadByPerson: { A: load[0], B: load[1] }, schedule: schedule, reserve: slot.reserve, uncertaintyMinutes: uncertainty, tags, featureContributions: features, trace: [...inferences.flatMap(i => i.trace), ...graph.trace, { ruleId: 'RESOURCE_ACCOUNTING', rule: 'RESOURCE_ACCOUNTING', message: '阶段时长固定取场景，活动只改变费用、负担和资源；转场及缓冲照常核算，费用使用整数分', inputFacts: [{ id: 'composition', value: schedule }], outputFacts: [{ id: 'costCents', value: costCents }, { id: 'minutes', value: scene.minutes }], evidenceIds: [], assertionKind: 'designed' }], warnings: list(inferences.flatMap(i => i.warnings)), preparationIds: list([...(scene.preparationIds || []), ...acts.flatMap(a => a.preparationIds)]), manual, ...(anchor ? { anchorId: anchor.id } : {}), realWorldStatus: 'needs_confirmation' };
    const next = { ...st, time: slot.end, elapsed: slot.end - ctx.windows[0].startMinute, usedMinutes: st.usedMinutes + slot.used, windowIndex: slot.windowIndex, uncertaintyByWindow: { ...st.uncertaintyByWindow, [slot.windowId]: slot.uncertaintyCarry }, uncertaintyTotal: slot.uncertaintyTotal, costCents: st.costCents.map((n, i) => n + costCents[i]), cost: st.costCents.map((n, i) => money(n + costCents[i])), fatigue: fatigueAfter, resources, completed: list([...completed, scene.id]), visited: [...st.visited, scene.id], kinds: [...st.kinds, scene.kind], mealWindows: isMeal ? [...st.mealWindows, slot.windowId] : st.mealWindows, meal: st.meal || isMeal, hasRest: st.hasRest || scene.kind === 'rest', last: scene.id, lastKind: scene.kind, area: scene.area === 'current' ? st.area : scene.area, anchorIndex: st.anchorIndex + (anchor ? 1 : 0), utilities: st.utilities.map((v, i) => v + values[i] * discounted), novelty: st.novelty + novelty * discounted, variety: st.variety + newKind, ruleUtility: st.ruleUtility + ruleBonus * discounted, stages: [...st.stages, stage] };
    stage.localUtility = objective(next, exploration) - objective(st, exploration);
    stage.before = stateSnapshot(st, ctx); stage.after = stateSnapshot(next, ctx); stage.stateBefore = stage.before; stage.stateAfter = stage.after;
    return { next, stage, errors: [] };
  }
  return { evaluate, reasoningCache };
}

function objective(st, exploration) {
  const mean = (st.utilities[0] + st.utilities[1]) / 2;
  return mean * (0.7 - exploration * 0.002) + Math.min(...st.utilities) * 0.3 + st.novelty * exploration / 100 * 0.55 + st.variety * (4 + exploration * 0.06) + st.ruleUtility - 8 * st.stages.length ** 2;
}
function planKey(st) { return st.stages.map(s => `${s.sceneId}[${s.activityIds.join(',')}]@${s.start}`).join('/'); }
function stateKey(st) { return `${planKey(st)}#${st.anchorIndex}`; }
function orderStates(a, b, exploration) { return objective(b, exploration) - objective(a, exploration) || a.costCents[1] - b.costCents[1] || a.usedMinutes - b.usedMinutes || cmp(planKey(a), planKey(b)); }
function metrics(st, ctx, exploration) {
  const mean = (st.utilities[0] + st.utilities[1]) / 2, high = Math.max(...st.utilities);
  return { totalMinutes: st.usedMinutes, elapsedMinutes: st.elapsed, totalCost: st.cost, totalCostCents: st.costCents, budgetHighCents: ctx.budgetHighCents, remainingBudgetCents: ctx.budgetHighCents === null ? null : ctx.budgetHighCents - st.costCents[1], utilityA: +st.utilities[0].toFixed(3), utilityB: +st.utilities[1].toFixed(3), meanUtility: +mean.toFixed(3), fairness: high === 0 ? 1 : +((Math.min(...st.utilities) / high)).toFixed(4), novelty: +(st.novelty / Math.max(1, st.stages.length)).toFixed(3), variety: st.variety, objective: +objective(st, exploration).toFixed(3), predictedLoadByPerson: { A: st.fatigue[0], B: st.fatigue[1] }, mealSatisfied: !ctx.mealNeed || st.meal, anchorsSatisfied: st.anchorIndex === ctx.anchors.length, endingBuffer: ctx.windows[st.windowIndex].endMinute - st.time, robustReserve: ctx.reserve + (st.uncertaintyByWindow[ctx.windows[st.windowIndex].id] || 0), totalUncertaintyMinutes: st.uncertaintyTotal, uncertaintyByWindow: st.uncertaintyByWindow, reserveSatisfied: ctx.windows[st.windowIndex].endMinute - st.time >= ctx.reserve + (st.uncertaintyByWindow[ctx.windows[st.windowIndex].id] || 0), preparationsRemaining: Object.keys(st.resources).filter(k => st.resources[k] > 0).sort(cmp) };
}
function pareto(states, ctx, exploration, limit = 8) {
  const distinct = [...new Map(states.map(s => [planKey(s), s])).values()].sort((a, b) => orderStates(a, b, exploration));
  const dominates = (a, b) => a.utilities[0] >= b.utilities[0] && a.utilities[1] >= b.utilities[1] && a.costCents[1] <= b.costCents[1] && a.usedMinutes <= b.usedMinutes && (a.utilities[0] > b.utilities[0] || a.utilities[1] > b.utilities[1] || a.costCents[1] < b.costCents[1] || a.usedMinutes < b.usedMinutes);
  const frontier = [];
  for (const candidate of distinct) {
    if (frontier.some(s => dominates(s, candidate))) continue;
    for (let i = frontier.length - 1; i >= 0; i--) if (dominates(candidate, frontier[i])) frontier.splice(i, 1);
    frontier.push(candidate);
  }
  return frontier.sort((a, b) => orderStates(a, b, exploration)).slice(0, limit).map(s => ({ stages: s.stages.map(stage => ({ sceneId: stage.sceneId, activityIds: stage.activityIds, start: stage.start, end: stage.end })), metrics: metrics(s, ctx, exploration), searchStatus: 'pareto_among_discovered_plans' }));
}

function errorResponse(status, errors, ctx, versions, extra = {}) {
  return { ok: false, status, errors, warnings: [], stages: [], totalCost: [0, 0], trace: [], versions, searchStatus: status === 'invalid_input' || status === 'invalid_data' ? status : 'bounded_no_plan_found_not_proved_infeasible', ...extra, ...(ctx ? { context: ctx } : {}) };
}

/** 有界束搜索；人工固定组合独立精确校验，不受活动枚举Top-K限制。 */
export function planDate(input = {}, catalog, options = {}) {
  let ctx, compiled, prefix, anchors;
  const versions = { engine: VERSION, rules: catalog?.rulesVersion || REASONING_VERSION, knowledge: catalog?.version || 'unversioned', knowledgeRevision: catalog?.contentRevision || digest({scenes:catalog?.scenes,rules:catalog?.rules}), data: catalog?.version || 'unversioned', score: CONFIG.scoreVersion, schema: 'datemate-3.0' };
  const expectedVersions = options.expectedVersions ?? input.expectedVersions;
  if (expectedVersions && Object.entries(expectedVersions).some(([key, value]) => versions[key] !== value)) return errorResponse('invalid_input', [fail('H_VERSION', '复盘的引擎、知识或评分版本与当前版本不一致。')], null, versions);
  try { ctx = normalize(input); } catch (error) { return errorResponse('invalid_input', [error.message], null, versions); }
  try { compiled = compileCatalog(catalog); } catch (error) { return errorResponse('invalid_data', [error.message], ctx, versions); }
  try {
    const rawPrefix = options.fixedPrefix ?? input.fixedPrefix ?? input.prefix ?? [];
    if (!Array.isArray(rawPrefix) || rawPrefix.length > 24) throw Error(fail('H_PREFIX', '前缀格式无效。'));
    prefix = rawPrefix.map(p => normalizeChoice(p, compiled));
    const rawAnchors = input.anchors || (input.anchorSceneId ? [{ choice: { sceneId: input.anchorSceneId, activityIds: [] } }] : []);
    anchors = normalizeAnchors(rawAnchors, compiled, ctx); ctx.anchors = anchors;
  } catch (error) { return errorResponse('invalid_input', [error.message], ctx, versions); }
  const exploration = integer(options.exploration ?? input.exploration, 0, 0, 100);
  const rawConfig = { ...CONFIG, ...(input.searchConfig || {}), ...options };
  const config = { method: rawConfig.method === 'exact' ? 'exact' : 'bounded', maxStages: integer(rawConfig.maxStages ?? rawConfig.maxDepth, CONFIG.maxStages, 1, 24), beamWidth: integer(rawConfig.beamWidth, CONFIG.beamWidth, 1, 2048), maxExpandedNodes: integer(rawConfig.maxExpandedNodes, CONFIG.maxExpandedNodes, 1, 1000000), maxCandidateExpandedNodes: integer(rawConfig.maxCandidateExpandedNodes, CONFIG.maxCandidateExpandedNodes, 0, 100000), activitySubsetLimit: integer(rawConfig.activitySubsetLimit, CONFIG.activitySubsetLimit, 1, 4096), candidateLimit: integer(rawConfig.candidateLimit, CONFIG.candidateLimit, 1, 64), tieBreak: 'stable-id' };
  if (ctx.endAfterStage !== null) config.maxStages = Math.min(config.maxStages, ctx.endAfterStage + 1);
  if (prefix.length > config.maxStages) return errorResponse('invalid_input', [fail('H_PREFIX_LENGTH', '固定前缀超过主动结束位置或阶段上限。')], ctx, versions);
  const stats = { ...config, expandedNodes: 0, candidateExpandedNodes: 0, candidateNodeBudgetReached: false, generatedNodes: 0, feasibleNodes: 0, terminalPlans: 0, constraintRejections: {}, beamPruned: 0, activitySubsetsTruncated: false, nodeBudgetReached: false, maxDepthReached: false, provedOptimal: false, proofScope: '未证明全局最优；搜索空间受阶段、活动子集和节点上限约束。' };
  const subsets = new Map(compiled.scenes.map(s => [s.id, enumerateSubsets(s, config.activitySubsetLimit, stats)]));
  const evaluator = createEvaluator(ctx, compiled, catalog, exploration);
  let start = initial(ctx);
  const reject = errors => { for (const error of errors) { const code = error.split(':')[0]; stats.constraintRejections[code] = (stats.constraintRejections[code] || 0) + 1; } };
  const choiceEqual = (a, b) => a.sceneId === b.sceneId && canonical(list(a.activityIds)) === canonical(list(b.activityIds));
  for (let i = 0; i < prefix.length; i++) {
    const pending = anchors[start.anchorIndex];
    const anchored = pending && choiceEqual(prefix[i], pending.choice) && (pending.index === undefined || pending.index === i) ? pending : null;
    if (pending?.index !== undefined && pending.index <= i && !anchored) return errorResponse('invalid_input', [fail('H_ANCHOR_PREFIX', '固定前缀与预约阶段位置冲突。')], ctx, versions, { failedStage: i, search: stats });
    const checked = evaluator.evaluate(start, prefix[i], anchored, true);
    if (checked.errors.length) return errorResponse('invalid_input', checked.errors, ctx, versions, { failedStage: i, prefix, search: stats });
    start = checked.next;
  }
  const isComplete = st => st.stages.length > 0 && st.anchorIndex === anchors.length && (!ctx.mealNeed || st.meal);
  const automaticChoices = compiled.scenes.flatMap(scene => subsets.get(scene.id).map(activityIds => ({ choice: { sceneId: scene.id, activityIds }, anchor: null })));
  function choicesFor(st, extra) {
    const depth = st.stages.length, pending = anchors[st.anchorIndex];
    if (pending?.index !== undefined && pending.index < depth) return [];
    const choices = pending?.index === depth ? [] : [...automaticChoices];
    if (pending && (pending.index === undefined || pending.index === depth)) choices.push({ choice: pending.choice, anchor: pending });
    if (extra && (pending?.index !== depth || choiceEqual(extra.choice, pending.choice))) {
      const same = choices.findIndex(item => canonical(item.choice) === canonical(extra.choice) && item.anchor?.id === extra.anchor?.id);
      if (same >= 0) choices[same] = extra; else choices.unshift(extra);
    }
    return choices;
  }
  // 人工阶段的反事实求解复用同一评估器，每轮调用共用固定节点预算，避免逐卡重跑规划器。
  function searchFrom(root, nodeLimit, counterfactual = false, extra = null) {
    const finished = [], history = new Map();
    let beam = [root], expanded = 0, budgetReached = false;
    if (isComplete(root)) finished.push(root);
    for (let depth = root.stages.length; depth < config.maxStages && beam.length; depth++) {
      const children = [];
      for (const st of beam) {
        if (expanded >= nodeLimit) { budgetReached = true; break; }
        const transitions = [];
        for (const item of choicesFor(st, st === root ? extra : null)) {
          if (expanded >= nodeLimit) { budgetReached = true; break; }
          expanded++;
          const evaluated = evaluator.evaluate(st, item.choice, item.anchor, item.manual === true);
          if (evaluated.errors.length) { if (!counterfactual) reject(evaluated.errors); continue; }
          if (!counterfactual) { stats.feasibleNodes++; stats.generatedNodes++; }
          transitions.push(evaluated.next); children.push(evaluated.next);
          if (isComplete(evaluated.next)) finished.push(evaluated.next);
        }
        history.set(stateKey(st), transitions);
      }
      const unique = [...new Map(children.map(s => [stateKey(s), s])).values()].sort((a, b) => orderStates(a, b, exploration));
      const width = config.method === 'exact' && !counterfactual ? unique.length : config.beamWidth;
      if (!counterfactual) stats.beamPruned += Math.max(0, unique.length - width);
      beam = unique.slice(0, width);
      // 已选组合独立校验后也进入后续评估，不能被活动子集或局部Top-K悄悄排除。
      if (counterfactual && depth === root.stages.length && extra) {
        const own = unique.find(s => choiceEqual(s.stages.at(-1), extra.choice) && s.stages.at(-1).fixedStartMinute === (extra.anchor?.startMinute ?? extra.choice.startMinute ?? null));
        if (own && !beam.includes(own)) beam.push(own);
      }
      if (!counterfactual && depth === config.maxStages - 1 && beam.length) stats.maxDepthReached = true;
      if (budgetReached) break;
    }
    return { finished, history, expanded, budgetReached };
  }
  const searched = searchFrom(start, config.maxExpandedNodes);
  const { finished, history } = searched;
  stats.expandedNodes = searched.expanded; stats.nodeBudgetReached = searched.budgetReached;
  stats.terminalPlans = finished.length;
  stats.reasoningSnapshots = evaluator.reasoningCache.size;
  if (!finished.length) return errorResponse('no_plan_found', [fail('SEARCH_NO_PLAN', '有界搜索未找到同时满足前缀、锚点和必要目标的完整方案；不据此证明模型无解。')], ctx, versions, { prefix, exploration, search: stats, evaluated: stats.expandedNodes, paretoPlans: [] });
  finished.sort((a, b) => orderStates(a, b, exploration));
  const best = finished[0];
  function continuationValues(terminals, searchHistory) {
    const values = new Map();
    for (const terminal of terminals) {
      const value = objective(terminal, exploration);
      let anchorIndex = 0;
      for (let i = 0; i < terminal.stages.length; i++) {
        if (terminal.stages[i].anchorId) anchorIndex++;
        const key = stateKey({ stages: terminal.stages.slice(0, i + 1), anchorIndex });
        const evaluated = terminal.stages.length > i + 1 || searchHistory.has(key) || i + 1 === config.maxStages;
        const old = values.get(key);
        values.set(key, { value: Math.max(old?.value ?? -Infinity, value), evaluated: evaluated || old?.evaluated === true });
      }
    }
    return values;
  }
  const mainContinuations = continuationValues(finished, history);
  let before = initial(ctx);
  const stages = best.stages.map((original, index) => {
    const anchor = original.anchorId ? anchors.find(a => a.id === original.anchorId) : null;
    const replayChoice = { sceneId: original.sceneId, activityIds: original.activityIds, ...(original.fixedStartMinute !== null ? { startMinute: original.fixedStartMinute } : {}) };
    const ownState = evaluator.evaluate(before, replayChoice, anchor, true).next;
    const prefixUtility = objective(before, exploration), referenceUtility = 80 * 0.88 ** index;
    const scoreReference = { version: CONFIG.scoreVersion, stageIndex: index, prefixUtility, referenceUtility, zeroUtilityScore: 50, label: '方案契合分', unit: 'points', range: [0, 100], method: 'signed_remaining_utility', formula: '50 + 50 * (q - prefixUtility) / (abs(q - prefixUtility) + referenceUtility)', scope: 'previous_stages_and_anchors', searchStatus: 'bounded_not_proved_optimal' };
    // 单调映射使用本阶段共同参考尺；0效用为50分，正负收益均可区分，不以批内最高分强制100。
    const scoreForContinuation = q => +(50 + 50 * (q - prefixUtility) / (Math.abs(q - prefixUtility) + referenceUtility)).toFixed(2);
    let stageHistory = history, values = mainContinuations;
    if (index < prefix.length) {
      const remaining = config.maxCandidateExpandedNodes - stats.candidateExpandedNodes;
      const budget = Math.floor(remaining / (prefix.length - index));
      const counterfactual = searchFrom(before, budget, true, { choice: replayChoice, anchor, manual: true });
      stats.candidateExpandedNodes += counterfactual.expanded;
      stats.candidateNodeBudgetReached ||= counterfactual.budgetReached;
      stageHistory = counterfactual.history;
      // 保留此前阶段及锚点，释放当前与后续人工前缀；实际完整方案也是合法的已知后续。
      values = continuationValues([...counterfactual.finished, best], stageHistory);
    }
    const transitions = [...(stageHistory.get(stateKey(before)) || []), ownState];
    function entryFor(candidateState, knownPlan = false) {
      const candidate = candidateState.stages.at(-1), key = stateKey(candidateState), completion = values.get(key);
      const found = knownPlan || completion?.evaluated === true;
      const q = found ? Math.max(completion?.value ?? -Infinity, knownPlan ? objective(best, exploration) : -Infinity) : null;
      const fitScore = found ? scoreForContinuation(q) : null;
      const evaluationStatus = found ? 'complete_continuation_found' : stageHistory.has(key) ? 'bounded_no_continuation_found' : 'continuation_not_evaluated';
      return { sceneId: candidate.sceneId, activityIds: candidate.activityIds, minutes: candidate.minutes, transfer: candidate.transfer, cost: candidate.cost, costCents: candidate.costCents, load: candidate.load, start: candidate.start, end: candidate.end, localUtility: objective(candidateState, exploration) - prefixUtility, rawUtility: q, q, fitScore, score: fitScore, recommendationIndex: fitScore, scoreVersion: CONFIG.scoreVersion, scoreStatus: found ? 'evaluated' : 'pending', evaluationStatus, conditional: true, continuationFound: found, feasibilityStatus: found ? 'feasible_continuation_found' : 'local_feasible_future_not_proved', featureContributions: candidate.featureContributions };
    }
    const byScene = new Map();
    for (const candidateState of transitions) {
      const entry = entryFor(candidateState);
      const old = byScene.get(entry.sceneId);
      if (!old || Number(entry.continuationFound) > Number(old.continuationFound) || entry.continuationFound === old.continuationFound && ((entry.q ?? entry.localUtility) > (old.q ?? old.localUtility) || (entry.q ?? entry.localUtility) === (old.q ?? old.localUtility) && cmp(canonical(entry.activityIds), canonical(old.activityIds)) < 0)) byScene.set(entry.sceneId, entry);
    }
    // 选中卡仍使用实际活动组合的完整方案效用；人工锁定允许低于其他方案。
    const own = entryFor(ownState, true);
    byScene.set(own.sceneId, own);
    const orderEntries = (a, b) => Number(b.continuationFound) - Number(a.continuationFound) || (a.continuationFound ? b.q - a.q : 0) || cmp(a.sceneId, b.sceneId);
    let ordered = [...byScene.values()].sort(orderEntries).slice(0, config.candidateLimit);
    if (!ordered.some(c => c.sceneId === own.sceneId)) ordered = [...ordered.slice(0, config.candidateLimit - 1), own].sort(orderEntries);
    const stage = { ...original, index, fitScore: own.fitScore, score: own.score, recommendationIndex: own.score, scoreStatus: own.scoreStatus, evaluationStatus: own.evaluationStatus, scoreVersion: own.scoreVersion, scoreReference, rawUtility: own.rawUtility, candidates: ordered, manual: index < prefix.length, selected: true };
    before = ownState;
    return stage;
  });
  stats.reasoningSnapshots = evaluator.reasoningCache.size;
  const measured = metrics(best, ctx, exploration);
  const assumptions = ['时间、费用、负担和恢复量为教学设计参数；实际开放、交通与双方感受仍需确认。', '费用区间为双人总额，约束使用整数分的上界。'];
  if (ctx.weather === 'unknown') assumptions.push('天气未提供，保留unknown；鲁棒模式对未知室外天气计入额外时间预留。');
  const warnings = [...new Set(stages.flatMap(s => s.warnings))];
  const replay = { schema: 'datemate-replay-3.0', versions, context: ctx, exploration, prefix, anchors, search: config };
  const core = { stages: stages.map(s => ({ sceneId: s.sceneId, activityIds: s.activityIds, start: s.start, end: s.end, costCents: s.costCents, score: s.score })), metrics: measured };
  return { ok: true, status: 'feasible', searchStatus: 'heuristic_feasible_not_proved_optimal', context: ctx, exploration, prefix, anchors, stages, totalCost: best.cost, totalCostCents: best.costCents, endingBuffer: measured.endingBuffer, metrics: measured, candidates: stages.map(s => s.candidates), paretoPlans: pareto(finished, ctx, exploration), trace: stages.flatMap(s => s.trace), search: stats, evaluated: stats.expandedNodes, versions, assumptions, warnings, errors: [], suggestions: [], replay, fingerprint: digest(replay), inputDigest: digest(replay), outputFingerprint: digest(core), outputDigest: digest(core) };
}

export function createPlanner(catalog, options = {}) {
  return { catalog, plan: (context = {}, exploration = 0, prefix = []) => planDate(context, catalog, { ...options, exploration, fixedPrefix: prefix }), normalizePrefix: prefix => normalizePrefix(prefix, catalog), check: (context, prefix) => planDate(context, catalog, { ...options, exploration: 0, fixedPrefix: prefix }) };
}
