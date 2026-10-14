import { canonical, digest, forwardChain, buildKnowledgeGraph, queryGraph, DEFAULT_RULES, REASONING_VERSION } from './reasoning.mjs?v=a4420782c4d5e641';
import { normalizePeriods, TIME_PERIODS } from './time-periods.mjs?v=a4420782c4d5e641';
import { createExploration, normalizeExplorationSeed, EXPLORATION_VERSION, CAMPING_EXPLORATION_MIN, isDepartureAllowedAtExploration, isSceneAllowedAtExploration } from './exploration.mjs?v=a4420782c4d5e641';
import { normalizeSchoolScope, isSceneInSchoolScope } from './school-scope.mjs?v=a4420782c4d5e641';
import { validateDailyWindows, sceneOpenWindows, sceneStayMinutes } from './scene-time.mjs?v=a4420782c4d5e641';
import { normalizePreferences, preferencePolicy } from './preference-policy.mjs?v=a4420782c4d5e641';

export { canonical, digest } from './reasoning.mjs?v=a4420782c4d5e641';
import {durationBounds,chooseStayDuration} from './duration-policy.mjs?v=a4420782c4d5e641';
export const VERSION = 'datemate-engine-4.2.1';
export const CONFIG = Object.freeze({ method: 'bounded', maxStages: 8, beamWidth: 24, maxExpandedNodes: 18000, maxCandidateExpandedNodes: 6000, activitySubsetLimit: 64, candidateLimit: 20, scoreVersion: 'planning-fit-4.1.0', tieBreak: 'stable-id' });
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
  const periods = raw.periodIds !== undefined && raw.periodIds !== null ? normalizePeriods(raw.periodIds, raw.mealChoices) : null;
  const windowTotal = Array.isArray(raw.windows) && raw.windows.length ? raw.windows.reduce((sum, w) => sum + number(w.endMinute ?? w.end, 0) - number(w.startMinute ?? w.start, 0), 0) : 180;
  const duration = periods?.duration ?? integer(raw.duration ?? raw.minutes, windowTotal, 1, 2880);
  const budget = raw.budgetHighCents !== undefined && raw.budgetHighCents !== null ? raw.budgetHighCents / 100 : raw.budget;
  const preparedIds = list(raw.preparedIds ?? raw.prepared);
  const resources = { ...inventory(preparedIds), ...inventory(raw.resources) };
  const ctx = {
    duration, budget: budget === undefined || budget === null || budget === '' ? null : number(budget, NaN),
    reserve: integer(raw.reserve, 15, 0, 240), robust: raw.robust !== false,
    area: raw.area === 'nearby' ? 'near' : ['campus', 'near', 'all'].includes(raw.area) ? raw.area : 'all',
    fatigueA: clamp(number(raw.fatigueA, 2), 0, 10), fatigueB: clamp(number(raw.fatigueB, 2), 0, 10),
    goals: list(raw.goals), preferences: list(raw.preferences), preferencesA: list(raw.preferencesA), preferencesB: list(raw.preferencesB),
    bans: list(raw.bans), requiredSceneIds: list(raw.requiredSceneIds), excludedSceneTypes: list(raw.excludedSceneTypes), excludedActivityTypes: list(raw.excludedActivityTypes),
    quietRequired: raw.quietRequired === true, mentalLow: raw.mentalLow === true, crowdAvoidance: raw.crowdAvoidance === true,
    mealNeed: raw.mealNeed === true || raw.requireMeal === true, requireMeal: raw.mealNeed === true || raw.requireMeal === true,
    theme: ['any', 'daily', 'romantic', 'fresh'].includes(raw.theme) ? raw.theme : 'any',
    dietaryRestrictions: list(raw.dietaryRestrictions), preparedIds, prepared: Object.keys(resources).sort(cmp), resources,
    explicitConsentIds: list(raw.explicitConsentIds ?? raw.consentIds), availability: { ...(raw.availability || {}) },
    windows: periods?.windows ?? normalizeWindows(raw.windows, duration), initialArea: raw.initialArea === 'nearby' ? 'near' : raw.initialArea || 'campus',
    periodIds: periods?.periodIds ?? null, mealChoices: copy(raw.mealChoices || {}), mealRequirements: periods?.mealRequirements ?? [],
    departureChoice: periods ? raw.departureChoice ?? 'separate' : null, cityTier: raw.cityTier ?? 'tier1',
    finalPeriodStart: periods ? TIME_PERIODS.find(p => p.id === periods.periodIds.at(-1)).startMinute : null,
    maxLoad: clamp(number(raw.maxLoad, 10), 0, 10), endAfterStage: raw.endAfterStage === undefined || raw.endAfterStage === null ? null : integer(raw.endAfterStage, 0, 0, 23),
    minimumStageCount: integer(raw.minimumStageCount, 0, 0, 24),
    facts: copy(raw.facts || {}), ...normalizePreferences(raw),
    explorationSeed: normalizeExplorationSeed(raw.explorationSeed),
  };
  Object.assign(ctx, normalizeSchoolScope({ ...raw, area: ctx.area }));
  if (ctx.budget !== null && (!Number.isFinite(ctx.budget) || ctx.budget < 0)) throw Error(fail('H_BUDGET', '预算必须为非负金额或未指定。'));
  if (periods && (!['separate', 'walk_together', 'hotel', 'camping'].includes(ctx.departureChoice) || !['tier1', 'tier2', 'tier3'].includes(ctx.cityTier))) throw Error(fail('H_DEPARTURE_CHOICE', '请选择有效的分别方式与城市等级。'));
  if (periods && ['hotel', 'camping'].includes(ctx.departureChoice) && periods.endMinute <= 1440) throw Error(fail('H_DEPARTURE_OVERNIGHT', '只有跨午夜的约会时段可以选择酒店或露营。'));
  ctx.budgetHigh = ctx.budget;
  ctx.budgetHighCents = ctx.budget === null ? null : cents(ctx.budget);
  ctx.minutes = ctx.duration;
  return ctx;
}

function compileDepartures(catalog, ctx) {
  if (!ctx.periodIds) return [];
  if (!Array.isArray(catalog.departures) || !catalog.departures.length) throw Error(fail('H_DEPARTURE_DATA', '分别方式目录尚未提供。'));
  const departures = catalog.departures.map(raw => {
    const cost = raw.costByCityTier?.[ctx.cityTier] ?? raw.cost;
    const values = Array.isArray(cost) ? cost : [cost, cost];
    if (!['separate', 'walk_together', 'hotel', 'camping'].includes(raw.id) || !Number.isInteger(raw.minutes) || raw.minutes <= 0 || raw.minutes > 240 || values.length !== 2 || values.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0) || values[1] < values[0]) throw Error(fail('H_DEPARTURE_DATA', '分别方式需使用正整数分钟和有效设计费用区间。'));
    return { ...raw, cost: [...values], costCents: values.map(cents), reservedMinutes: Math.max(15, raw.minutes), cityTier: ctx.cityTier, manualOnly: ['hotel', 'camping'].includes(raw.id) || raw.requiresExplicitChoice === true, realWorldStatus: 'needs_confirmation' };
  });
  if (new Set(departures.map(d => d.id)).size !== departures.length || !departures.some(d => d.id === ctx.departureChoice)) throw Error(fail('H_DEPARTURE_DATA', '分别方式目录重复或缺少所选方式。'));
  return departures.filter(departure => isDepartureAllowedAtExploration(departure, ctx.exploration));
}

function departureResult(ctx, st = null) {
  if (!ctx.departure) return null;
  const sum = st?.costCents ?? [0, 0];
  const candidates = ctx.departures.filter(d => !['hotel', 'camping'].includes(d.id) || ctx.windows.at(-1).endMinute > 1440).map(d => {
    const withinBudget = ctx.budgetHighCents === null || sum[1] + d.costCents[1] <= ctx.budgetHighCents;
    const withinTime = !st || st.time + d.reservedMinutes + ctx.reserve + st.uncertaintyTotal <= ctx.windows.at(-1).endMinute;
    return { ...d, selected: d.id === ctx.departureChoice, available: withinBudget && withinTime, fitScore: null, scoreStatus: 'pending', evaluationStatus: 'continuation_not_evaluated', feasibilityStatus: withinBudget && withinTime ? 'local_feasible_future_not_proved' : 'hard_constraint_rejected', errors: [...(!withinBudget ? [fail('H_BUDGET', '分别方式与当前行程合计超过预算。')] : []), ...(!withinTime ? [fail('H_TIME_WINDOW', '跨度内没有足够时间完成分别并保留缓冲。')] : [])] };
  });
  return { ...ctx.departure, startMinute: st?.time ?? null, endMinute: st ? st.time + ctx.departure.minutes : null, selected: true, planned: Boolean(st), candidates };
}

const departureMinutes = ctx => ctx.departure?.minutes ?? 0;
const departureReservedMinutes = ctx => ctx.departure?.reservedMinutes ?? 0;
const departureCostCents = ctx => ctx.departure?.costCents ?? [0, 0];

function normalizeAction(action, scene) {
  if (action.socialDemand !== undefined && (!Number.isInteger(action.socialDemand) || action.socialDemand < 0 || action.socialDemand > 3)) throw Error(fail('H_DATA', `活动${action.id}的社交负担需为0至3。`));
  const costs = action.costCents ? range(action.costCents).map(Math.round) : range(action.cost ?? action.baseline?.cost).map(cents);
  const load = range(action.load ?? action.baseline?.load)[1];
  if (!action.id || costs.some(n => n < 0) || costs[1] < costs[0] || !Number.isFinite(load)) throw Error(fail('H_DATA', `活动${action.id || '(无ID)'}的资源字段无效。`));
  return { ...action, id: String(action.id), minutes: 0, costCents: costs, load, group: action.group || 'optional', mode: action.compositionMode === 'exclusive' ? 'single' : action.mode || 'multiple', tags: list(action.tags), compositionMode: 'within_scene', predecessorIds: list(action.predecessorIds), preparationIds: list(action.preparationIds), requires: inventory(action.requires ?? action.preconditions), provides: inventory(action.provides), consumes: inventory(action.consumes), sceneId: scene.id };
}

function compileCatalog(catalog, ctx = { weekPart: 'weekday' }) {
  if (!catalog || !Array.isArray(catalog.scenes) || !catalog.scenes.length) throw Error(fail('H_DATA', '场景目录为空。'));
  const flat = new Map((catalog.activities || []).map(a => [a.id, a]));
  const scenes = [...catalog.scenes].sort((a, b) => cmp(a.id, b.id)).map(raw => {
    const scene = { ...raw, sheltered: raw.sheltered === true, area: raw.area === 'nearby' ? 'near' : raw.area || raw.areaClass || 'campus', kind: raw.kind || raw.typeId || 'ordinary', tags: list(raw.tags) };
    if (raw.minimumExploration !== undefined && (!Number.isInteger(raw.minimumExploration) || raw.minimumExploration < 0 || raw.minimumExploration > 100)) throw Error(fail('H_DATA', `场景${raw.id}的最低探索度需为0至100的整数。`));
    scene.minutes = range(raw.minutes ?? raw.baseline?.duration)[1];
    durationBounds(scene);
    validateDailyWindows(scene);
    const weekCost = raw.costByWeekPart?.[ctx.weekPart];
    if (weekCost !== undefined && (!Array.isArray(weekCost) || weekCost.length !== 2 || weekCost.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0) || weekCost[1] < weekCost[0])) throw Error(fail('H_DATA', `场景${raw.id}的周中周末费用区间无效。`));
    scene.costCents = weekCost !== undefined ? weekCost.map(cents) : raw.costCents ? range(raw.costCents).map(Math.round) : range(raw.cost ?? raw.baseline?.cost).map(cents);
    scene.cost = scene.costCents.map(money);
    scene.weekPart = ctx.weekPart;
    scene.queueMinutes = Math.max(0, number(raw.queueMinutesByWeekPart?.[ctx.weekPart] ?? raw.queueMinutes, 0));
    scene.socialDemand = raw.socialDemand === undefined ? 1 : raw.socialDemand;
    if (!Number.isInteger(scene.socialDemand) || scene.socialDemand < 0 || scene.socialDemand > 3) throw Error(fail('H_DATA', `场景${raw.id}的社交负担需为0至3。`));
    scene.load = range(raw.load)[1];
    scene.loadByPerson = raw.loadByPerson || raw.loadBySubject || raw.baseline?.loadBySubject;
    scene.preparationIds = list(raw.preparationIds);
    scene.predecessorIds = list(raw.predecessorIds);
    scene.bundledMeals = list(raw.bundledMeals);
    if(scene.bundledMeals.some(role=>!['breakfast','lunch','dinner','supper'].includes(role))) throw Error(fail('H_DATA', `场景${raw.id}的行程内餐次无效。`));
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
  if (choice.durationMinutes !== undefined) {
    const bounds = durationBounds(scene);
    if (!Number.isInteger(choice.durationMinutes) || choice.durationMinutes < bounds.min || choice.durationMinutes > bounds.max) throw Error(fail('H_DURATION', '所选时长超出这个场景允许的范围。'));
  }
  return { sceneId: scene.id, activityIds: ids, ...(choice.mealRole !== undefined ? { mealRole: choice.mealRole } : {}), ...(choice.startMinute !== undefined ? { startMinute: choice.startMinute } : {}), ...(choice.durationMinutes !== undefined ? {durationMinutes:choice.durationMinutes} : {}), ...(choice.anchorId !== undefined ? { anchorId: choice.anchorId } : {}) };
}
function normalizeAnchors(raw, compiled, ctx) {
  if (!Array.isArray(raw)) throw Error(fail('H_ANCHOR', '锚点必须为数组。'));
  const anchors = raw.map((a, i) => {
    const rawChoice = a.choice || a;
    const startMinute = a.startMinute ?? rawChoice.startMinute;
    const anchor = { id: a.id || `anchor-${i}`, choice: normalizeChoice(a.sceneOnly === true ? { ...rawChoice, activityIds: [] } : rawChoice, compiled), ...(a.sceneOnly === true ? { sceneOnly: true } : {}), ...(a.index !== undefined ? { index: a.index } : {}), ...(startMinute !== undefined ? { startMinute } : {}), ...(a.windowId ? { windowId: a.windowId } : {}) };
    if (anchor.index !== undefined && (!Number.isInteger(anchor.index) || anchor.index < 0 || anchor.index > 23)) throw Error(fail('H_ANCHOR', '锚点阶段序号无效。'));
    if (anchor.startMinute !== undefined && (!Number.isInteger(anchor.startMinute) || anchor.startMinute < 0)) throw Error(fail('H_ANCHOR', '预约开始需为非负整数分钟。'));
    if (anchor.windowId && !ctx.windows.some(w => w.id === anchor.windowId)) throw Error(fail('H_ANCHOR', '锚点引用了不存在的时间窗。'));
    return anchor;
  }); // 无位置锚点按输入顺序逐个保留，不悄悄排序用户意图。
  if (new Set(anchors.map(a => a.id)).size !== anchors.length) throw Error(fail('H_ANCHOR', '预约ID不得重复。'));
  return anchors;
}

// 只保留复演所需的选择，不把自动排程时间或旧状态快照变成约束。
function compactWitness(st) {
  return st.stages.map(s => ({ sceneId: s.sceneId, activityIds: [...s.activityIds], ...(s.mealRole ? { mealRole: s.mealRole } : {}), ...(s.durationRange ? {durationMinutes:s.minutes} : {}), ...(Number.isFinite(s.fixedStartMinute) ? { startMinute: s.fixedStartMinute } : {}), ...(s.anchorId !== undefined ? { anchorId: s.anchorId } : {}) }));
}

function initial(ctx) {
  return { periodMode: Boolean(ctx.periodIds), relaxedMode: Boolean(ctx.periodIds && ctx.durationPolicy === 'flexible'), activeMinutes: 0, waitMinutes: 0, time: ctx.windows[0].startMinute, elapsed: 0, usedMinutes: 0, windowIndex: 0, uncertaintyByWindow: {}, uncertaintyTotal: 0, costCents: [0, 0], cost: [0, 0], fatigue: [ctx.fatigueA, ctx.fatigueB], resources: { ...ctx.resources }, completed: [], visited: [], kinds: [], mealWindows: [], mealRoles: [], meal: false, hasRest: false, last: null, lastKind: null, placeId: null, area: ctx.initialArea, anchorIndex: 0, utilities: [0, 0], novelty: 0, variety: 0, ruleUtility: 0, stages: [] };
}
const dedicatedMealScene = scene => scene.kind === 'meal';
const pendingMealFor = (st, ctx) => ctx.mealRequirements.find(m => m.choiceMode === 'together' && !st.mealRoles.includes(m.mealRole));
const mealsSatisfied = (st, ctx) => ctx.mealRequirements.every(m => m.choiceMode !== 'together' || st.mealRoles.includes(m.mealRole));
const coveredPeriodIds = (st, ctx) => (ctx.periodIds || []).filter(id => { const p = TIME_PERIODS.find(p => p.id === id); return st.stages.some(s => s.start < p.endMinute && s.end > p.startMinute); });
const periodsCovered = (st, ctx) => !ctx.periodIds || coveredPeriodIds(st, ctx).length === ctx.periodIds.length;
// 考试季单时段的短会允许提前分别；多时段、预约和必需饭点仍完整履行。
const shortExamMeeting = ctx => ctx.season === 'exam' && ctx.periodIds?.length === 1 && !ctx.anchors?.length && !ctx.mealRequirements.some(m => m.choiceMode === 'together');
const nearEnd = (st, ctx) => !ctx.periodIds || ctx.endAfterStage !== null || shortExamMeeting(ctx) || st.time + departureMinutes(ctx) >= ctx.windows.at(-1).endMinute - 60;
function mealActivityChoices(scene, role, subsets) {
  if (!scene.mealRoles?.includes(role)) return [];
  const eating = scene.activities.filter(a => a.provides.meal_completed > 0 && a.mealRoles?.includes(role));
  const minimum = eating.map(a => {
    const selected = new Set([a.id]);
    // 用餐本身不能因子集截断消失；场景内前置活动一并保留，外部前置交给资源校验。
    for (const id of selected) for (const predecessor of scene.activities.find(item => item.id === id)?.predecessorIds || []) if (scene.activities.some(item => item.id === predecessor)) selected.add(predecessor);
    return [...selected].sort(cmp);
  });
  return [...new Map([...minimum, ...subsets].filter(ids => ids.some(id => eating.some(a => a.id === id))).map(ids => [canonical(ids), ids])).values()];
}
function stateSnapshot(st, ctx) {
  return { elapsed: st.elapsed, elapsedMinutes: st.elapsed, absoluteMinute: st.time, usedMinutes: st.usedMinutes, windowIndex: st.windowIndex, uncertaintyByWindow: st.uncertaintyByWindow, uncertaintyMinutes: st.uncertaintyTotal, cost: st.cost, costCents: st.costCents, costLowCents: st.costCents[0], costHighCents: st.costCents[1], fatigue: st.fatigue, predictedLoadByPerson: { A: st.fatigue[0], B: st.fatigue[1] }, resources: st.resources, preparationRemaining: Object.keys(st.resources).filter(k => st.resources[k] > 0).sort(cmp), completedActionIds: st.completed, satisfiedGoalTags: list(st.stages.flatMap(s => s.tags || [])), visited: st.visited, kinds: st.kinds, last: st.last, placeId: st.placeId, area: st.area, meal: st.meal, hasRest: st.hasRest, remainingBudgetCents: ctx.budgetHighCents === null ? null : ctx.budgetHighCents - st.costCents[1] - departureCostCents(ctx)[1] };
}

function transfer(st, scene, catalog) {
  if (scene.kind === 'rest' || scene.area === 'current' || st.placeId === scene.id) return 0;
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
  const out = [[]], acts = scene.activities, seen = new Set(['[]']);
  let truncated = false;
  // 先覆盖每项玩法及其场景内前置，再扩展组合；深度优先的尾部子集会挤掉前半活动。
  const add = selected => {
    const ids = new Set(selected.map(a => a.id));
    for (const id of ids) for (const predecessor of acts.find(a => a.id === id)?.predecessorIds || []) if (acts.some(a => a.id === predecessor)) ids.add(predecessor);
    const ordered = acts.filter(a => ids.has(a.id)), key = canonical(ordered.map(a => a.id));
    if (seen.has(key) || !permittedGroups(scene, ordered)) return;
    seen.add(key);
    if (out.length >= limit) { truncated = true; stats.activitySubsetsTruncated = true; return; }
    out.push(ordered.map(a => a.id));
  };
  for (const activity of acts) add([activity]);
  for (let i = 1; i < out.length && !truncated; i++) for (const activity of acts) add([...acts.filter(a => out[i].includes(a.id)), activity]);
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
function scheduleWithinScene(minutes, acts) {
  // 活动只在场景内执行，顺序记录依赖关系；阶段时长仅由场景决定，不分配活动耗时。
  return acts.map((a, order) => ({ activityId: a.id, order, predecessorIds: a.predecessorIds, startOffset: 0, endOffset: minutes, compositionMode: 'within_scene' }));
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
  // 必需饭点至少要留出其最低可行费用；有此下界时，可以直接排除超预算选项，而不是让界面一直等待后续搜索。
  const mealFloors=new Map(ctx.mealRequirements.filter(meal=>meal.choiceMode==='together').map(meal=>{
    const prices=compiled.scenes.filter(scene=>isSceneInSchoolScope(scene,ctx)&&(!meal.sceneId||meal.sceneId===scene.id)&&!ctx.bans.includes(scene.id)).flatMap(scene=>{
      if(!scene.mealRoles?.includes(meal.mealRole))return [];
      if(meal.activityIds!==null){const acts=scene.activities.filter(a=>meal.activityIds.includes(a.id));return [scene.costCents[1]+acts.reduce((sum,a)=>sum+a.costCents[1],0)];}
      return scene.activities.filter(a=>a.provides.meal_completed>0&&a.mealRoles?.includes(meal.mealRole)&&!ctx.bans.includes(a.id)&&(!a.requiresExplicitConsent||ctx.explicitConsentIds.includes(a.id))&&!(a.dietaryTags||[]).some(tag=>ctx.dietaryRestrictions.includes(tag))).map(a=>scene.costCents[1]+a.costCents[1]);
    });
    return [meal.mealRole,Math.min(...prices)];
  }));
  function infer(st, scene, activity) {
    const key = canonical([scene.id, st.placeId, activity?.id, st.fatigue, Object.keys(st.resources).filter(k => st.resources[k] > 0)]);
    if (!reasoningCache.has(key)) {
      const place = scene.kind === 'rest' ? compiled.byId.get(st.placeId) : null;
      // 休息恢复量沿用休息卡；环境属性继承真实地点，不能凭休息卡变成室内或安静场所。
      const environment = place ? Object.fromEntries(['indoor', 'sheltered', 'quiet', 'crowded', 'uncrowded', 'crowdRisk'].map(key => [key, place[key]])) : {};
      const facts = { context: { ...ctx, fatigueA: st.fatigue[0], fatigueB: st.fatigue[1], prepared: Object.keys(st.resources).filter(k => st.resources[k] > 0).sort(cmp) }, scene: { ...scene, ...environment }, graph: { matchedPreferenceTags: [...graphFeatures(scene, activity ? [activity] : []).matches] }, ...(activity ? { activity } : {}), state: { maxLoad: Math.max(...st.fatigue), predictedLoadByPerson: { A: st.fatigue[0], B: st.fatigue[1] } } };
      reasoningCache.set(key, forwardChain(facts, compiled.rules));
    }
    return reasoningCache.get(key);
  }
  function graphFeatures(scene, acts) {
    const key = canonical([scene.id, acts.map(a => a.id)]);
    if (preferenceCache.has(key)) return preferenceCache.get(key);
    const stateInterests = ctx.reunion ? ['private', 'shared_hobby'] : [];
    const endpoints = list([...ctx.preferencesA, ...ctx.preferencesB, ...ctx.preferences, ...ctx.goals, ...stateInterests]);
    const matches = new Set(), trace = [], selected = new Set(acts.map(a => a.id));
    for (const tag of endpoints) {
      const paths = queryGraph(compiled.graph, scene.id, `preference:${tag}`, { maxDepth: 4, maxPaths: 12 }).filter(path => !path.nodes.some(id => scene.activities.some(a => a.id === id) && !selected.has(id)));
      if (paths.length) { matches.add(tag); const path = paths[0]; trace.push({ ruleId: 'KG_PREFERENCE_PATH', rule: 'KG_PREFERENCE_PATH', message: `沿场景—体验属性—偏好路径匹配${tag}`, path: path.nodes, edges: path.edges.map(e => e.id), inputFacts: [{ id: stateInterests.includes(tag) ? 'context.reunion' : 'explicitPreference', value: stateInterests.includes(tag) ? ctx.reunion : tag }], outputFacts: [{ id: `feature.preference.${tag}`, value: true }], evidenceIds: path.evidenceIds, evidence: path.evidenceIds, assertionKind: 'designed' }); }
    }
    const result = { matches, trace };
    preferenceCache.set(key, result); return result;
  }
  function evaluate(st, choice, anchor, manual = false, releaseMealChoice = false) {
    const scene = compiled.byId.get(choice.sceneId);
    if (!scene) return { errors: [fail('H_SCENE', '场景不存在。')] };
    const ids = list(choice.activityIds), acts = scene.activities.filter(a => ids.includes(a.id));
    const place = scene.kind === 'rest' ? compiled.byId.get(st.placeId) ?? scene : scene;
    const errors = [];
    const pendingMeal = pendingMealFor(st, ctx);
    const selectedEating = acts.some(a => a.provides.meal_completed > 0);
    const mealRole = choice.mealRole ?? (ctx.periodIds && (dedicatedMealScene(scene) || selectedEating) ? pendingMeal?.mealRole : null);
    const mealSlot = mealRole ? ctx.mealRequirements.find(m => m.mealRole === mealRole) : null;
    if (ctx.periodIds) {
      if ((dedicatedMealScene(scene) || selectedEating) && !mealRole) errors.push(fail('H_MEAL_ROLE', '实际用餐只能安排在尚未完成的指定饭点。'));
      if (mealRole) {
        if (!mealSlot || pendingMeal?.mealRole !== mealRole || mealSlot.choiceMode !== 'together' || !scene.mealRoles?.includes(mealRole)) errors.push(fail('H_MEAL_ROLE', '餐馆角色或用餐顺序与指定饭点不符。'));
        const eating = acts.filter(a => a.provides.meal_completed > 0);
        if (!eating.length || eating.some(a => !a.mealRoles?.includes(mealRole))) errors.push(fail('H_MEAL_ACTIVITY', '指定饭点必须选择适用于该餐的实际用餐活动。'));
        if (!releaseMealChoice && mealSlot?.sceneId && (mealSlot.sceneId !== scene.id || mealSlot.activityIds !== null && canonical(mealSlot.activityIds) !== canonical(ids))) errors.push(fail('H_MEAL_CHOICE', '当前用餐阶段与固定餐卡选择冲突。'));
      }
    }
    if (acts.length !== ids.length) errors.push(fail('H_ACTIVITY', '活动不属于当前场景。'));
    if (!permittedGroups(scene, acts)) errors.push(fail('H_EXCLUSIVE', '单选组或互斥活动发生冲突。'));
    if (ctx.bans.includes(scene.id) || ctx.bans.includes(`kind:${scene.kind}`) || ctx.excludedSceneTypes.includes(scene.typeId || scene.kind)) errors.push(fail('H_EXCLUDED', '场景或场景类型已排除。'));
    if (scene.publicAllowed === false || scene.reviewStatus === 'rejected' || scene.reviewStatus === 'draft') errors.push(fail('H_REVIEW', '场景未通过公开使用审核。'));
    if (ctx.availability[scene.id] === 'unavailable') errors.push(fail('H_AVAILABILITY', '场景明确不可用。'));
    if (scene.predecessorIds.some(id => !st.completed.includes(id))) errors.push(fail('H_PREDECESSOR', `场景${scene.id}缺少前置场景或活动。`));
    if (ctx.area === 'campus' && !['campus', 'current'].includes(scene.area) || ctx.area === 'near' && scene.area === 'off') errors.push(fail('H_RANGE', '超出本次地点范围。'));
    else if (!isSceneInSchoolScope(scene, ctx) || !isSceneInSchoolScope(place, ctx)) errors.push(fail('H_SCHOOL_SCOPE', '地点不适用于本次学校或校区范围。'));
    if (scene.dreamOnly === true && exploration !== 100) errors.push(fail('H_DREAM_ONLY', '该场景仅在探索度100的梦幻模式可选；降低探索度后请移除该阶段及其后续固定安排。'));
    else if (!isSceneAllowedAtExploration(scene, exploration)) errors.push(fail('H_SCENE_EXPLORATION', `场景${scene.id}未达到所需探索度；请提高探索度或移除该阶段及其后续固定安排。`));
    if (ctx.periodIds && scene.kind === 'rest' && st.placeId === null) errors.push(fail('H_REST_PLACE', '原地休息需要先进入一个可停留的地点。'));
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
    if (ctx.budgetHighCents !== null && st.costCents[1] + costCents[1] + departureCostCents(ctx)[1] > ctx.budgetHighCents) return { errors: [fail('H_BUDGET', '按整数分核算的双人费用及分别方式上界超过预算。')] };
    const canBundle=meal=>scene.bundledMeals.includes(meal.mealRole)&&!meal.sceneId;
    const blockingMeal=ctx.mealRequirements.find(meal=>meal.choiceMode==='together'&&!st.mealRoles.includes(meal.mealRole)&&meal.mealRole!==mealRole&&!canBundle(meal));
    const remainingMealCost=[...mealFloors].filter(([role])=>role!==mealRole&&!st.mealRoles.includes(role)&&!scene.bundledMeals.includes(role)).reduce((sum,[,price])=>sum+price,0);
    if(ctx.budgetHighCents!==null&&Number.isFinite(remainingMealCost)&&st.costCents[1]+costCents[1]+departureCostCents(ctx)[1]+remainingMealCost>ctx.budgetHighCents)return {errors:[fail('H_BUDGET','这项选择加上后面必需的用餐费用会超出预算。')]};
    const load = [0, 1].map(i => range(scene.loadByPerson?.[i === 0 ? 'A' : 'B'] ?? scene.load)[1] + acts.reduce((sum, a) => sum + range(a.loadByPerson?.[i === 0 ? 'A' : 'B'] ?? a.load)[1], 0));
    const fatigueAfter = st.fatigue.map((f, i) => Math.max(0, f + load[i]));
    if (fatigueAfter.some(f => f > ctx.maxLoad)) return { errors: [fail('H_LOAD', '预计负担超过本次双方上限。')] };
    const transit = transfer(st, scene, catalog);
    const uncertainty = ctx.robust ? integer(scene.uncertaintyMinutes, scene.reliable === false ? 10 : 0, 0, 120) : 0;
    const exactStart = anchor?.startMinute ?? choice.startMinute;
    const isMeal = scene.kind === 'meal' || acts.some(a => a.exclusiveKey === 'main_meal' || a.provides.meal_completed > 0);
    let slot = null, hoursRejected = false;
    for (let wi = st.windowIndex; wi < ctx.windows.length; wi++) {
      const window = ctx.windows[wi];
      if (anchor?.windowId && window.id !== anchor.windowId) continue;
      const depart = Math.max(st.time, window.startMinute), earliest = depart + transit;
      const priorUncertainty = st.uncertaintyByWindow[window.id] || 0;
      let sceneWindows = sceneOpenWindows(scene, window, Boolean(ctx.periodIds));
      // 原地休息沿用已进入地点的营业边界，不能在闭馆后继续占用原地。
      if (scene.kind === 'rest' && st.placeId !== null) {
        const placeWindows = sceneOpenWindows(place, window, Boolean(ctx.periodIds));
        sceneWindows = sceneWindows.flatMap(a => placeWindows.map(b => ({ startMinute: Math.max(a.startMinute, b.startMinute), endMinute: Math.min(a.endMinute, b.endMinute) })).filter(w => w.endMinute > w.startMinute));
      }
      const possibleSlot = windows => windows.map(w => {
        const start = exactStart ?? Math.max(earliest, w.startMinute, mealSlot?.targetMinute ?? 0);
        const carry = Math.max(0, priorUncertainty - (start - earliest)) + uncertainty;
        const openEnd = Math.min(w.endMinute, mealSlot?.endMinute ?? Infinity);
        const nextAppointment = !anchor ? ctx.anchors?.[st.anchorIndex]?.startMinute ?? Infinity : Infinity;
        const stop = Math.min(openEnd, window.endMinute - ctx.reserve - departureReservedMinutes(ctx) - carry,
          ctx.periodIds && !mealRole && blockingMeal ? blockingMeal.targetMinute - carry : Infinity, nextAppointment);
        const bounds = durationBounds(scene);
        const automaticMinimum = ctx.minimumStageCount > st.stages.length ? bounds.min : sceneStayMinutes({...scene,minutes:bounds.min}, start, mealRole, Boolean(ctx.periodIds));
        const durationOptions = {requested:choice.durationMinutes, automaticMinimum, relaxed:Boolean(ctx.periodIds && scene.durationRange), mealRole, short:choice.durationStrategy === 'minimum'};
        // 自动停留优先留下其他有效分别方式的时间；短窗口仍退回所选方式，不增加硬门槛。
        const alternativeReserve = !manual && !anchor && choice.durationMinutes === undefined
          ? Math.max(departureReservedMinutes(ctx), ...(ctx.departures || []).filter(d => !['hotel', 'camping'].includes(d.id) || ctx.windows.at(-1).endMinute > 1440).map(d => d.reservedMinutes)) : departureReservedMinutes(ctx);
        const preferredStop = Math.min(stop, window.endMinute - ctx.reserve - alternativeReserve - carry);
        const minutes = chooseStayDuration(scene, { ...durationOptions, available:preferredStop-start })
          ?? chooseStayDuration(scene, { ...durationOptions, available:stop-start });
        return {start,minutes,openEnd,openStart:Math.max(w.startMinute,mealSlot?.startMinute ?? 0)};
      }).find(s => s.minutes !== null && s.start >= earliest && (exactStart === undefined || s.start >= earliest + priorUncertainty) && s.start >= s.openStart && s.start + s.minutes <= s.openEnd && s.start + s.minutes + ctx.reserve + departureReservedMinutes(ctx) + Math.max(0, priorUncertainty - (s.start - earliest)) + uncertainty <= window.endMinute);
      const possible = possibleSlot(sceneWindows);
      if (ctx.periodIds && scene.dailyWindows !== undefined && !possible && possibleSlot([window])) hoursRejected = true;
      if (!possible) continue;
      const start = possible.start, minutes = possible.minutes, end = start + minutes;
      const uncertaintyCarry = Math.max(0, priorUncertainty - (start - earliest)) + uncertainty;
      const uncertaintyTotal = st.uncertaintyTotal - priorUncertainty + uncertaintyCarry;
      const reserve = ctx.reserve + uncertaintyCarry;
      if (acts.some(a => a.windows?.length && !a.windows.some(w => {
        return start >= (w.startMinute ?? w.start) && end <= (w.endMinute ?? w.end);
      }))) continue;
      const used = start - depart + minutes;
      if (st.usedMinutes + used + ctx.reserve + departureReservedMinutes(ctx) + uncertaintyTotal > ctx.duration) continue;
      if (isMeal && !ctx.periodIds && st.mealWindows.includes(window.id)) continue;
      // 必需饭点的截止时间约束每个普通阶段，预约和人工前缀同样不能绕过。
      if (ctx.periodIds && !mealRole && blockingMeal && end + uncertaintyCarry > blockingMeal.targetMinute) continue;
      // 完整旅行卡的费用与时长已含餐。每餐仍需在实际饭点留出30分钟，不能靠标签跳过。
      const bundledMeals=ctx.mealRequirements.filter(meal=>meal.choiceMode==='together'&&!st.mealRoles.includes(meal.mealRole)&&meal.mealRole!==mealRole&&canBundle(meal)&&end>meal.targetMinute).map(meal=>{
        const mealStart=Math.max(start,meal.targetMinute);
        return {mealRole:meal.mealRole,label:meal.label,startMinute:mealStart,endMinute:mealStart+30,latestEnd:meal.endMinute};
      });
      if(bundledMeals.some(meal=>meal.endMinute>end||meal.endMinute>meal.latestEnd))continue;
      slot = { start, end, minutes, bundledMeals, windowIndex: wi, windowId: window.id, wait: start - earliest, used, reserve, uncertainty, uncertaintyCarry, uncertaintyTotal }; break;
    }
    if (!slot) return { errors: [hoursRejected ? fail('H_SCENE_HOURS', '场景开放时间不能完整容纳本阶段，请选择其他地点或时段。') : fail('H_TIME_WINDOW', '阶段、转场、预约时间和必要缓冲无法放入可用时间窗。')] };
    const bundledRoles=slot.bundledMeals.map(meal=>meal.mealRole);
    const laterMealCost=[...mealFloors].filter(([role])=>role!==mealRole&&!st.mealRoles.includes(role)&&!bundledRoles.includes(role)).reduce((sum,[,price])=>sum+price,0);
    if(ctx.budgetHighCents!==null&&Number.isFinite(laterMealCost)&&st.costCents[1]+costCents[1]+departureCostCents(ctx)[1]+laterMealCost>ctx.budgetHighCents)return {errors:[fail('H_BUDGET','行程与剩余餐次费用超过预算。')]};
    const minutes = slot.minutes;
    const schedule = scheduleWithinScene(minutes, ordering.ordered);
    if (ctx.periodIds && TIME_PERIODS.some(p => ctx.periodIds.includes(p.id) && p.endMinute <= slot.start && !st.stages.some(s => s.start < p.endMinute && s.end > p.startMinute))) return { errors: [fail('H_PERIOD_COVERAGE', '不能跳过已选择的时段；每个时段需有实际规划阶段。')] };
    const pendingAnchor = ctx.anchors?.[st.anchorIndex];
    if (!anchor && pendingAnchor?.startMinute !== undefined && slot.end > pendingAnchor.startMinute) return { errors: [fail('H_ANCHOR_TIME', '当前阶段会越过后续固定预约。')] };
    const graph = graphFeatures(scene, acts), tags = list([...scene.tags, ...acts.flatMap(a => a.tags)]);
    const soft = preferencePolicy(ctx, scene, place, tags, graph.matches, exploration, acts);
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
    // 有实际玩法的共同体验具备基础收益；未知兴趣不应让所有活动只有成本。
    const distinctActivities = acts.filter(a => !st.completed.includes(a.id)).length;
    const activityParticipation = acts.length ? 14 + 6 * Math.min(2, Math.max(0, distinctActivities - 1)) : 0;
    const repeatedActivityPenalty = acts.filter(a => st.completed.includes(a.id)).length * 10;
    const extraActivityPenalty = (2 * acts.length * (acts.length - 1) + acts.reduce((sum, a) => sum + 4 + Math.max(0, a.load) * 4 + a.costCents[1] * 0.003, 0)) * (1 - exploration / 100 * 0.7) + repeatedActivityPenalty;
    const resourcePenalty = costCents[1] * 0.001 + minutes * 0.05;
    const values = [matchA, matchB].map((matches, i) => Math.max(0, fit + matches * 18 + sharedInterest + generalPreference + goalBonus + themeBonus + activityExperience[i] + sharedActivityExperience + generalActivityExperience + activityParticipation - comfortPenalty[i] - transit * 0.12 - extraActivityPenalty - resourcePenalty));
    const novelty = Math.max(scene.novelty, ...acts.map(a => number(a.novelty, 0)));
    const repeatFunctionPenalty = st.kinds.includes(scene.kind) ? 18 : 0;
    const repeatScenePenalty = st.visited.includes(scene.id) ? 36 : 0;
    const unnecessaryRestPenalty = scene.kind === 'rest' && Math.max(...st.fatigue) < 6 ? 35 : 0;
    const ruleBonus = soft.score + (sceneInference.scenePreferences[scene.id] || 0) + acts.reduce((sum, a, i) => sum + (inferences[i + 1].activityPreferences[a.id] || 0), 0) - repeatFunctionPenalty - repeatScenePenalty - unnecessaryRestPenalty;
    const newKind = st.kinds.includes(scene.kind) ? 0 : 1;
    const discounted = (ctx.periodIds ? 0.96 : 0.88) ** st.stages.length;
    // 连续停留的收益递减，不能用三小时裸地点把一次地点匹配重复计分三次。
    const durationWeight = ctx.periodIds && scene.durationRange && !shortExamMeeting(ctx) ? Math.min(1, minutes / 60) + 0.15 * Math.log2(Math.max(1, minutes / 60)) : 1;
    const stageComplexityPenalty = (shortExamMeeting(ctx) ? 40 : ctx.periodIds ? scene.durationRange ? 15 : 1.5 : 8) * (2 * st.stages.length + 1);
    const features = { ...soft.contributions, preferenceA: matchA * 18, preferenceB: matchB * 18, sharedInterest, generalPreference, goalBonus, themeBonus, activityExperienceA: activityExperience[0], activityExperienceB: activityExperience[1], sharedActivityExperience, generalActivityExperience, comfort: fit - (comfortPenalty[0] + comfortPenalty[1]) / 2, transferPenalty: -transit * 0.12, extraActivityPenalty: -extraActivityPenalty, resourcePenalty: -resourcePenalty, repeatFunctionPenalty: -repeatFunctionPenalty, repeatScenePenalty: -repeatScenePenalty, unnecessaryRestPenalty: -unnecessaryRestPenalty, stageComplexityPenalty: -stageComplexityPenalty, novelty: novelty * exploration / 100 * 0.55, variety: newKind * (4 + exploration * 0.06), ruleBonus, fairnessFloor: Math.min(...values) * 0.3 };
    const stage = { sceneId: scene.id, activityIds: ids, minutes, transfer: transit, wait: slot.wait, start: slot.start, end: slot.end, startMinute: slot.start, endMinute: slot.end, fixedStartMinute: exactStart ?? null, windowId: slot.windowId, cost: costCents.map(money), costCents, load: Math.max(...load), loadByPerson: { A: load[0], B: load[1] }, schedule: schedule, reserve: slot.reserve, uncertaintyMinutes: uncertainty, tags, featureContributions: features, trace: [...inferences.flatMap(i => i.trace), ...graph.trace, ...soft.trace, { ruleId: 'RESOURCE_ACCOUNTING', rule: 'RESOURCE_ACCOUNTING', message: '阶段按场景基础时长及晚间最小停留核算，活动在完整阶段内执行；转场及缓冲照常核算，费用使用整数分', inputFacts: [{ id: 'composition', value: schedule }], outputFacts: [{ id: 'costCents', value: costCents }, { id: 'minutes', value: minutes }], evidenceIds: [], assertionKind: 'designed' }], warnings: list([...inferences.flatMap(i => i.warnings), ...soft.warnings]), preparationIds: list([...(scene.preparationIds || []), ...acts.flatMap(a => a.preparationIds)]), manual, ...(anchor ? { anchorId: anchor.id } : {}), realWorldStatus: 'needs_confirmation' };
    if (scene.durationRange) stage.durationRange = [...scene.durationRange];
    if (choice.durationMinutes !== undefined) stage.fixedDurationMinutes = choice.durationMinutes;
    if(slot.bundledMeals.length){
      stage.bundledMeals=slot.bundledMeals.map(({latestEnd,...meal})=>meal);
      stage.trace.push({ruleId:'BUNDLED_MEAL_ACCOUNTING',message:'完整行程内餐次已按饭点预留时间，费用包含在旅行卡内。',strength:'hard',assertionKind:'designed',inputFacts:[{id:'scene.bundledMeals',value:scene.bundledMeals}],outputFacts:stage.bundledMeals});
    }
    if (mealRole) { stage.mealRole = mealRole; stage.mealId = mealRole; }
    const next = { ...st, time: slot.end, elapsed: slot.end - ctx.windows[0].startMinute, usedMinutes: st.usedMinutes + slot.used, windowIndex: slot.windowIndex, uncertaintyByWindow: { ...st.uncertaintyByWindow, [slot.windowId]: slot.uncertaintyCarry }, uncertaintyTotal: slot.uncertaintyTotal, costCents: st.costCents.map((n, i) => n + costCents[i]), cost: st.costCents.map((n, i) => money(n + costCents[i])), fatigue: fatigueAfter, resources, completed: list([...completed, scene.id]), visited: [...st.visited, scene.id], kinds: [...st.kinds, scene.kind], mealWindows: isMeal ? [...st.mealWindows, slot.windowId] : st.mealWindows, mealRoles: mealRole ? [...st.mealRoles, mealRole] : st.mealRoles, meal: st.meal || isMeal, hasRest: st.hasRest || scene.kind === 'rest', last: scene.id, lastKind: scene.kind, area: scene.area === 'current' ? st.area : scene.area, anchorIndex: st.anchorIndex + (anchor ? 1 : 0), utilities: st.utilities.map((v, i) => v + values[i] * discounted * durationWeight), novelty: st.novelty + novelty * discounted, variety: st.variety + newKind, ruleUtility: st.ruleUtility + ruleBonus * discounted, stages: [...st.stages, stage] };
    next.activeMinutes = st.activeMinutes + minutes;
    next.mealRoles=list([...next.mealRoles,...bundledRoles]);next.meal=next.meal||bundledRoles.length>0;
    next.placeId = scene.kind === 'rest' ? st.placeId : scene.id;
    next.waitMinutes = st.waitMinutes + slot.wait;
    features.activityParticipation = activityParticipation;
    features.repeatedActivityPenalty = -repeatedActivityPenalty;
    features.durationWeight = durationWeight;
    next.shortMeeting = shortExamMeeting(ctx);
    if (ctx.periodIds) {
      if (next.shortMeeting) features.shortMeetingTimePenalty = -slot.used * 0.25;
      else { features.activeCoverage = minutes * 0.45; features.waitPenalty = -slot.wait * 0.35; }
    }
    stage.localUtility = objective(next, exploration) - objective(st, exploration);
    stage.before = stateSnapshot(st, ctx); stage.after = stateSnapshot(next, ctx); stage.stateBefore = stage.before; stage.stateAfter = stage.after;
    return { next, stage, errors: [] };
  }
  return { evaluate, reasoningCache };
}

function objective(st, exploration) {
  const mean = (st.utilities[0] + st.utilities[1]) / 2;
  return mean * (0.7 - exploration * 0.002) + Math.min(...st.utilities) * 0.3 + st.novelty * exploration / 100 * 0.55 + st.variety * (4 + exploration * 0.06) + st.ruleUtility - (st.shortMeeting ? 40 : st.relaxedMode ? 15 : st.periodMode ? 1.5 : 8) * st.stages.length ** 2 + (st.periodMode ? st.shortMeeting ? -st.usedMinutes * 0.25 : st.activeMinutes * 0.45 - st.waitMinutes * 0.35 : 0);
}
function planKey(st) { return st.stages.map(s => `${s.sceneId}[${s.activityIds.join(',')}]@${s.start}+${s.minutes ?? s.end-s.start}`).join('/'); }
function stateKey(st) { return `${planKey(st)}#${st.anchorIndex}#${st.placeId}`; }
function orderStates(a, b, exploration) { return objective(b, exploration) - objective(a, exploration) || a.costCents[1] - b.costCents[1] || a.usedMinutes - b.usedMinutes || cmp(planKey(a), planKey(b)); }
function metrics(st, ctx, exploration) {
  const mean = (st.utilities[0] + st.utilities[1]) / 2, high = Math.max(...st.utilities);
  const endingBuffer = ctx.windows[st.windowIndex].endMinute - st.time - departureMinutes(ctx);
  const robustReserve = ctx.reserve + (st.uncertaintyByWindow[ctx.windows[st.windowIndex].id] || 0);
  const totalCostCents = st.costCents.map((n, i) => n + departureCostCents(ctx)[i]);
  return {
    totalMinutes: st.usedMinutes + departureMinutes(ctx), elapsedMinutes: st.elapsed + departureMinutes(ctx),
    planningSpanMinutes: ctx.duration, elapsedMinutesIncludingGaps: st.elapsed + departureMinutes(ctx),
    periodCoverageSatisfied: periodsCovered(st, ctx), endingCoverageSatisfied: nearEnd(st, ctx), coveredPeriodIds: coveredPeriodIds(st, ctx),
    activeMinutes: st.activeMinutes, waitingMinutes: st.waitMinutes, transferMinutes: st.usedMinutes - st.activeMinutes - st.waitMinutes,
    departureMinutes: departureMinutes(ctx), departureCostCents: departureCostCents(ctx), activeCoverageRatio: +(st.activeMinutes / ctx.duration).toFixed(4),
    totalCost: totalCostCents.map(money), totalCostCents, budgetHighCents: ctx.budgetHighCents,
    remainingBudgetCents: ctx.budgetHighCents === null ? null : ctx.budgetHighCents - totalCostCents[1],
    utilityA: +st.utilities[0].toFixed(3), utilityB: +st.utilities[1].toFixed(3), meanUtility: +mean.toFixed(3),
    fairness: high === 0 ? 1 : +((Math.min(...st.utilities) / high)).toFixed(4),
    novelty: +(st.novelty / Math.max(1, st.stages.length)).toFixed(3), variety: st.variety, objective: +objective(st, exploration).toFixed(3),
    predictedLoadByPerson: { A: st.fatigue[0], B: st.fatigue[1] },
    mealSatisfied: mealsSatisfied(st, ctx) && (!ctx.mealNeed || st.meal || ctx.mealRequirements.some(m => m.choiceMode === 'before_meeting')),
    anchorsSatisfied: st.anchorIndex === ctx.anchors.length, endingBuffer, robustReserve,
    totalUncertaintyMinutes: st.uncertaintyTotal, uncertaintyByWindow: st.uncertaintyByWindow, reserveSatisfied: endingBuffer >= robustReserve,
    preparationsRemaining: Object.keys(st.resources).filter(k => st.resources[k] > 0).sort(cmp),
  };
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
  return frontier.sort((a, b) => orderStates(a, b, exploration)).slice(0, limit).map(s => ({ stages: s.stages.map(stage => ({ sceneId: stage.sceneId, activityIds: stage.activityIds, start: stage.start, end: stage.end })), ...(ctx.departure ? { departure: departureResult(ctx, s) } : {}), metrics: metrics(s, ctx, exploration), searchStatus: 'pareto_among_discovered_plans' }));
}

function errorResponse(status, errors, ctx, versions, extra = {}) {
  return { ok: false, status, errors, warnings: [], stages: [], mealRequirements: ctx?.mealRequirements || [], ...(ctx?.departure ? { departure: departureResult(ctx) } : {}), totalCost: [0, 0], trace: [], versions, searchStatus: status === 'invalid_input' || status === 'invalid_data' ? status : 'bounded_no_plan_found_not_proved_infeasible', ...extra, ...(ctx ? { context: ctx } : {}) };
}

/** 有界束搜索；人工固定组合独立精确校验，不受活动枚举Top-K限制。 */
export function planDate(input = {}, catalog, options = {}) {
  return finishSearch(searchDate(input, catalog, options));
}

function finishSearch(iterator) {
  let step;
  do { step = iterator.next(); } while (!step.done);
  return step.value;
}

/** 同一搜索器分片执行候选的完整后续验证，调用方可在片间优先处理可见卡片。 */
export function createContinuationSearch(input = {}, catalog, options = {}) {
  return searchDate(input, catalog, { ...options, continuationOnly: true });
}

/** 快捷重验完整见证；options.knownPlan 为 compact 选择数组，fixedPrefix 为本次候选前缀。
 * 有效返回重新核算的 q / prefixUtility / referenceUtility / stages / continuationWitness；
 * 无效返回 errors / failedStage，绝不自动搜索。省略 anchorId 的见证阶段表示普通到访。
 */
export function verifyPlanWitness(input = {}, catalog, options = {}) {
  return planDate(input, catalog, { ...options, continuationOnly: true, verifyKnownPlanOnly: true });
}

function* searchDate(input = {}, catalog, options = {}) {
  let ctx, compiled, prefix, anchors;
  const exploration = integer(options.exploration ?? input.exploration ?? input.context?.exploration, 0, 0, 100);
  const versions = { engine: VERSION, rules: catalog?.rulesVersion || REASONING_VERSION, knowledge: catalog?.version || 'unversioned', knowledgeRevision: catalog?.contentRevision || digest({scenes:catalog?.scenes,rules:catalog?.rules,departures:catalog?.departures}), data: catalog?.version || 'unversioned', score: CONFIG.scoreVersion, schema: 'datemate-3.0' };
  const expectedVersions = options.expectedVersions ?? input.expectedVersions;
  if (expectedVersions && Object.entries(expectedVersions).some(([key, value]) => versions[key] !== value)) return errorResponse('invalid_input', [fail('H_VERSION', '复盘的引擎、知识或评分版本与当前版本不一致。')], null, versions);
  try {
    ctx = normalize({ ...input, explorationSeed: options.explorationSeed ?? input.explorationSeed ?? input.context?.explorationSeed });
    if (!isDepartureAllowedAtExploration({id: ctx.departureChoice}, exploration)) throw Error(fail('H_DEPARTURE_EXPLORATION', `露营需要探索度至少${CAMPING_EXPLORATION_MIN}。`));
    ctx.explorationSeed ??= digest(ctx);
    ctx.exploration = exploration;
  } catch (error) { return errorResponse('invalid_input', [error.message], null, versions); }
  try { compiled = compileCatalog(catalog, ctx); } catch (error) { return errorResponse('invalid_data', [error.message], ctx, versions); }
  ctx.durationPolicy = compiled.scenes.some(scene => scene.durationRange) ? 'flexible' : 'fixed';
  if (ctx.requiredSceneIds.some(id => !compiled.byId.has(id) || ctx.bans.includes(id))) return errorResponse('invalid_input', [fail('H_REQUIRED_SCENE', '必去地点不存在或同时被排除。')], ctx, versions);
  if (ctx.requiredSceneIds.some(id => !isSceneInSchoolScope(compiled.byId.get(id), ctx))) return errorResponse('invalid_input', [fail('H_SCHOOL_SCOPE', '必去地点不适用于本次地点、学校或校区范围。')], ctx, versions);
  if (ctx.requiredSceneIds.some(id => { const scene = compiled.byId.get(id); return !scene.dreamOnly && !isSceneAllowedAtExploration(scene, exploration); })) return errorResponse('invalid_input', [fail('H_SCENE_EXPLORATION', '必去地点未达到所需探索度。')], ctx, versions);
  try { ctx.departures = compileDepartures(catalog, ctx); ctx.departure = ctx.departures.find(d => d.id === ctx.departureChoice) ?? null; } catch (error) { return errorResponse('invalid_data', [error.message], ctx, versions); }
  try {
    const rawPrefix = options.fixedPrefix ?? input.fixedPrefix ?? input.prefix ?? [];
    if (!Array.isArray(rawPrefix) || rawPrefix.length > 24) throw Error(fail('H_PREFIX', '前缀格式无效。'));
    prefix = rawPrefix.map(p => normalizeChoice(p, compiled));
    for (const meal of ctx.mealRequirements) {
      if (!meal.sceneId) continue;
      const choice = normalizeChoice({ sceneId: meal.sceneId, activityIds: meal.activityIds ?? [] }, compiled);
      const scene = compiled.byId.get(choice.sceneId);
      if (!isSceneInSchoolScope(scene, ctx)) throw Error(fail('H_SCHOOL_SCOPE', '固定餐馆不适用于本次地点、学校或校区范围。'));
      if (!scene.mealRoles?.includes(meal.mealRole)) throw Error(fail('H_MEAL_ROLE', '固定餐馆不支持当前饭点。'));
      if (meal.activityIds !== null && (!choice.activityIds.some(id => scene.activities.find(a => a.id === id)?.provides.meal_completed > 0) || choice.activityIds.some(id => { const a = scene.activities.find(a => a.id === id); return a.provides.meal_completed > 0 && !a.mealRoles?.includes(meal.mealRole); }))) throw Error(fail('H_MEAL_ACTIVITY', '固定餐卡必须选择适用于该餐的实际用餐活动。'));
    }
    const rawAnchors = input.anchors || (input.anchorSceneId ? [{ choice: { sceneId: input.anchorSceneId, activityIds: [] } }] : []);
    anchors = normalizeAnchors(rawAnchors, compiled, ctx); ctx.anchors = anchors;
    if (anchors.some(a => !isSceneInSchoolScope(compiled.byId.get(a.choice.sceneId), ctx))) throw Error(fail('H_SCHOOL_SCOPE', '锚点不适用于本次地点、学校或校区范围。'));
    if (anchors.some(a => { const scene = compiled.byId.get(a.choice.sceneId); return !scene.dreamOnly && !isSceneAllowedAtExploration(scene, exploration); })) throw Error(fail('H_SCENE_EXPLORATION', '锚点未达到所需探索度。'));
  } catch (error) { return errorResponse('invalid_input', [error.message], ctx, versions); }
  // 独立候选验证只求最高真实效用；探索度仍影响真实目标函数，不施加搜索噪声。
  const explorer = createExploration(options.continuationOnly ? 0 : exploration, ctx.explorationSeed);
  const periodDefaults = ctx.periodIds ? { maxStages: Math.min(24, Math.max(CONFIG.maxStages, Math.ceil(ctx.duration / 45) + 2)), beamWidth: 8, activitySubsetLimit: 8 } : {};
  const rawConfig = { ...CONFIG, ...periodDefaults, candidateLimit: CONFIG.candidateLimit + Math.round(12 * explorer.strength), ...(input.searchConfig || {}), ...options };
  const config = { method: rawConfig.method === 'exact' ? 'exact' : 'bounded', maxStages: integer(rawConfig.maxStages ?? rawConfig.maxDepth, CONFIG.maxStages, 1, 24), beamWidth: integer(rawConfig.beamWidth, CONFIG.beamWidth, 1, 2048), maxExpandedNodes: integer(rawConfig.maxExpandedNodes, CONFIG.maxExpandedNodes, 1, 1000000), maxCandidateExpandedNodes: integer(rawConfig.maxCandidateExpandedNodes, CONFIG.maxCandidateExpandedNodes, 0, 100000), activitySubsetLimit: integer(rawConfig.activitySubsetLimit, CONFIG.activitySubsetLimit, 1, 4096), candidateLimit: integer(rawConfig.candidateLimit, CONFIG.candidateLimit, 1, 64), tieBreak: 'stable-id' };
  // 主动选择后按真实效用重新择优；探索仍拓宽搜索和展示，最终选择方式单独记录以便复盘。
  config.selectionMode = rawConfig.selectionMode === 'utility_best' || !explorer.strength ? 'utility_best' : 'seeded_exploration';
  if (ctx.endAfterStage !== null) config.maxStages = Math.min(config.maxStages, ctx.endAfterStage + 1);
  if (prefix.length > config.maxStages) return errorResponse('invalid_input', [fail('H_PREFIX_LENGTH', '固定前缀超过主动结束位置或阶段上限。')], ctx, versions);
  if (ctx.requiredSceneIds.length > config.maxStages) return errorResponse('invalid_input', [fail('H_REQUIRED_LENGTH', '必去地点数量超过当前阶段上限。')], ctx, versions);
  const stats = { ...config, explorationVersion: EXPLORATION_VERSION, explorationSeed: ctx.explorationSeed, explorationStrength: explorer.strength, expandedNodes: 0, candidateExpandedNodes: 0, candidateNodeBudgetReached: false, generatedNodes: 0, feasibleNodes: 0, terminalPlans: 0, constraintRejections: {}, beamPruned: 0, activitySubsetsTruncated: false, nodeBudgetReached: false, maxDepthReached: false, provedOptimal: false, proofScope: '未证明全局最优；搜索空间受阶段、活动子集和节点上限约束。' };
  const scopedScenes = compiled.scenes.filter(scene => isSceneInSchoolScope(scene, ctx) && isSceneAllowedAtExploration(scene, exploration));
  const evaluator = createEvaluator(ctx, compiled, catalog, exploration);
  let start = initial(ctx), candidatePrefixUtility = 0;
  const reject = errors => { for (const error of errors) { const code = error.split(':')[0]; stats.constraintRejections[code] = (stats.constraintRejections[code] || 0) + 1; } };
  const choiceEqual = (a, b) => a.sceneId === b.sceneId && (!a.mealRole || !b.mealRole || a.mealRole === b.mealRole) && canonical(list(a.activityIds)) === canonical(list(b.activityIds));
  const matchesAnchor = (choice, anchor) => anchor.sceneOnly ? choice.sceneId === anchor.choice.sceneId && (!anchor.choice.mealRole || !choice.mealRole || choice.mealRole === anchor.choice.mealRole) : choiceEqual(choice, anchor.choice);
  const requiredCovered = st => ctx.requiredSceneIds.filter(id => st.visited.includes(id));
  const completionErrors = st => [
    ...(!st.stages.length ? [fail('H_KNOWN_PLAN', '完整见证至少需要一个阶段。')] : []),
    ...(st.stages.length < ctx.minimumStageCount ? [fail('H_STAGE_SPLIT', '拆分后需保留后续一段可选择的安排。')] : []),
    ...(st.anchorIndex !== anchors.length ? [fail('H_ANCHOR', '完整见证未履行全部预约。')] : []),
    ...(requiredCovered(st).length !== ctx.requiredSceneIds.length ? [fail('H_REQUIRED_SCENE', '完整见证未覆盖全部必去地点。')] : []),
    ...(!mealsSatisfied(st, ctx) || ctx.mealNeed && !st.meal && !ctx.mealRequirements.some(m => m.choiceMode === 'before_meeting') ? [fail('H_MEAL', '完整见证未满足全部用餐要求。')] : []),
    ...(!periodsCovered(st, ctx) ? [fail('H_PERIOD_COVERAGE', '完整见证未覆盖全部所选时段。')] : []),
    ...(!nearEnd(st, ctx) ? [fail('H_END_COVERAGE', '完整见证未覆盖最后时段的结束位置。')] : []),
  ];
  const isComplete = st => st.stages.length > 0 && st.stages.length >= ctx.minimumStageCount && st.anchorIndex === anchors.length && requiredCovered(st).length === ctx.requiredSceneIds.length && mealsSatisfied(st, ctx) && periodsCovered(st, ctx) && nearEnd(st, ctx) && (!ctx.mealNeed || st.meal || ctx.mealRequirements.some(m => m.choiceMode === 'before_meeting'));
  function resolveAnchor(choice, st, index, explicitIdentity = false) {
    const pending = anchors[st.anchorIndex];
    const anchored = choice.anchorId !== undefined
      ? pending?.id === choice.anchorId && matchesAnchor(choice, pending) && (pending.index === undefined || pending.index === index) ? pending : null
      : !explicitIdentity && pending && matchesAnchor(choice, pending) && (pending.index === undefined || pending.index === index) ? pending : null;
    if (choice.anchorId !== undefined && !anchored || pending?.index !== undefined && pending.index <= index && !anchored) return { errors: [fail('H_ANCHOR_PREFIX', '阶段与预约身份、顺序或位置冲突。')] };
    if(explicitIdentity&&pending&&!anchored&&pending.startMinute!==undefined&&choice.startMinute===pending.startMinute&&choice.sceneId===pending.choice.sceneId)return {errors:[fail('H_ANCHOR_PREFIX','该固定时刻需要保留对应的预约身份。')]};
    if (anchored?.startMinute !== undefined && choice.startMinute !== undefined && anchored.startMinute !== choice.startMinute) return { errors: [fail('H_ANCHOR_TIME', '阶段的固定开始时间与当前预约冲突。')] };
    return { anchor: anchored, errors: [] };
  }
  // 见证完全从当前初始状态重演；旧费用、资源、效用和状态快照一概不读取。
  function checkKnownPlan(raw) {
    if (!Array.isArray(raw) || !raw.length || raw.length > config.maxStages) return { errors: [fail('H_KNOWN_PLAN', '完整见证需为阶段上限以内的非空数组。')] };
    let choices;
    try {
      choices = raw.map(choice => {
        if (!choice || !Array.isArray(choice.activityIds) || choice.activityIds.some(id => typeof id !== 'string') || choice.startMinute !== undefined && (!Number.isInteger(choice.startMinute) || choice.startMinute < 0) || choice.anchorId !== undefined && typeof choice.anchorId !== 'string' || choice.mealRole !== undefined && typeof choice.mealRole !== 'string') throw Error(fail('H_KNOWN_PLAN', '见证活动、预约身份、餐角色或固定时间格式无效。'));
        return normalizeChoice(choice, compiled);
      });
    } catch (error) { return { errors: [error.message] }; }
    if (choices.length < prefix.length || prefix.some((p, i) => !choiceEqual(p, choices[i]) || p.mealRole !== undefined && p.mealRole !== choices[i].mealRole || p.durationMinutes !== undefined && p.durationMinutes !== choices[i].durationMinutes || p.startMinute !== undefined && p.startMinute !== choices[i].startMinute || p.anchorId !== undefined && p.anchorId !== choices[i].anchorId)) return { errors: [fail('H_KNOWN_PREFIX', '完整见证与本次固定前缀不一致。')] };
    let state = initial(ctx), prefixUtility = 0;
    for (let i = 0; i < choices.length; i++) {
      if (i === prefix.length - 1) prefixUtility = objective(state, exploration);
      const resolved = resolveAnchor(choices[i], state, i, true);
      if (resolved.errors.length) return { errors: resolved.errors, failedStage: i };
      const checked = evaluator.evaluate(state, choices[i], resolved.anchor, true);
      if (checked.errors.length) return { errors: checked.errors, failedStage: i };
      state = checked.next;
    }
    const errors = completionErrors(state);
    return { state, prefixUtility, errors };
  }
  const rawKnownPlan = options.knownPlan ?? input.knownPlan;
  const suppliedKnownPlan = rawKnownPlan !== undefined;
  const known = suppliedKnownPlan || options.verifyKnownPlanOnly ? checkKnownPlan(rawKnownPlan) : null;
  if (known) stats.knownPlan = { status: known.errors.length ? 'ignored' : 'verified', errors: known.errors, ...(known.failedStage !== undefined ? { failedStage: known.failedStage } : {}) };
  const continuationResult = (best, prefixUtility) => ({ ok: true, status: 'feasible', errors: [], q: objective(best, exploration), prefixUtility, referenceUtility: 80 * (ctx.periodIds ? 0.96 : 0.88) ** Math.max(0, prefix.length - 1), scoreVersion: CONFIG.scoreVersion, explorationSeed: ctx.explorationSeed, choiceMode: 'utility_best', decisionMode: 'utility_best', explorationNoiseEnabled: false, scoringMode: 'best_discovered_true_utility', stages: best.stages, continuationWitness: compactWitness(best), metrics: metrics(best, ctx, exploration), versions, search: stats });
  if (options.verifyKnownPlanOnly) {
    stats.reasoningSnapshots = evaluator.reasoningCache.size;
    if (known.errors.length) return errorResponse('invalid_known_plan', known.errors, ctx, versions, { ...(known.failedStage !== undefined ? { failedStage: known.failedStage } : {}), search: stats });
    stats.terminalPlans = 1;
    return { ...continuationResult(known.state, known.prefixUtility), scoringMode: 'verified_plan_true_utility', searchStatus: 'known_plan_verified' };
  }
  for (let i = 0; i < prefix.length; i++) {
    if (i === prefix.length - 1) candidatePrefixUtility = objective(start, exploration);
    // 有效见证的真实身份可消除无 index 预约的同地点歧义；无效见证不影响新搜索。
    const knownStage = known && !known.errors.length ? known.state.stages[i] : null;
    const resolved = resolveAnchor(knownStage ? { ...prefix[i], ...(knownStage.anchorId !== undefined ? { anchorId: knownStage.anchorId } : {}) } : prefix[i], start, i, Boolean(knownStage));
    if (resolved.errors.length) return errorResponse('invalid_input', resolved.errors, ctx, versions, { failedStage: i, search: stats });
    const anchored = resolved.anchor;
    const checked = evaluator.evaluate(start, prefix[i], anchored, true);
    if (checked.errors.length) return errorResponse('invalid_input', checked.errors, ctx, versions, { failedStage: i, prefix, search: stats });
    start = checked.next;
  }
  const subsets = new Map(scopedScenes.map(s => [s.id, enumerateSubsets(s, config.activitySubsetLimit, stats)]));
  const automaticChoices = scopedScenes.filter(scene => !ctx.periodIds || !dedicatedMealScene(scene)).flatMap(scene => subsets.get(scene.id).filter(ids => !ctx.periodIds || !ids.some(id => scene.activities.find(a => a.id === id).provides.meal_completed > 0)).flatMap(activityIds => {
    const choice = {sceneId:scene.id,activityIds};
    // 长跨度普通规划优先推进饭点和时段覆盖，避免每个玩法翻倍成短停留后耗尽节点。
    // 单时段、探索或明确预约/必去仍搜索短停留；人工固定分钟始终直接校验。
    return [{choice,anchor:null}, ...(scene.durationRange && (ctx.periodIds?.length === 1 || exploration > 0 || ctx.requiredSceneIds.length || anchors.length) ? [{choice:{...choice,durationStrategy:'minimum'},anchor:null}] : [])];
  }));
  const mealChoices = new Map(ctx.mealRequirements.map(meal => [meal.mealRole, scopedScenes.filter(scene => !meal.sceneId || meal.sceneId === scene.id).flatMap(scene => (meal.activityIds !== null ? scene.mealRoles?.includes(meal.mealRole) ? [meal.activityIds] : [] : mealActivityChoices(scene, meal.mealRole, subsets.get(scene.id))).map(activityIds => ({ choice: { sceneId: scene.id, activityIds, mealRole: meal.mealRole }, anchor: null })))]));
  function choicesFor(st, extra) {
    const depth = st.stages.length, pending = anchors[st.anchorIndex];
    if (pending?.index !== undefined && pending.index < depth) return [];
    const pendingMeal = pendingMealFor(st, ctx);
    const ordinaryChoices = [...automaticChoices];
    // 最后时段可通过真实场景的等待进入；不能为了跳过宵夜而结束在傍晚。
    const nextPeriod = ctx.periodIds?.map(id => TIME_PERIODS.find(p => p.id === id)).find(p => !coveredPeriodIds(st, ctx).includes(p.id));
    if (nextPeriod && st.time < nextPeriod.startMinute && (!pendingMeal || nextPeriod.startMinute < pendingMeal.targetMinute)) ordinaryChoices.push(...automaticChoices.map(item => ({ ...item, choice: { ...item.choice, startMinute: nextPeriod.startMinute } })));
    if (ctx.periodIds && !pendingMeal && !nearEnd(st, ctx)) ordinaryChoices.push(...automaticChoices.map(item => ({ ...item, choice: { ...item.choice, startMinute: ctx.windows.at(-1).endMinute - 60 - departureMinutes(ctx) - compiled.byId.get(item.choice.sceneId).minutes } })));
    const choices = pending?.index === depth ? [] : [...(pendingMeal ? mealChoices.get(pendingMeal.mealRole) : []), ...ordinaryChoices];
    if (pending && (pending.index === undefined || pending.index === depth)) {
      // 必去只约束地点：活动仍联合搜索，食堂锚点也必须选择实际用餐组合。
      if (pending.sceneOnly) {
        const eligible = [...(pendingMeal ? mealChoices.get(pendingMeal.mealRole) : []), ...ordinaryChoices];
        choices.push(...eligible.filter(item => matchesAnchor(item.choice, pending)).map(item => ({ choice: item.choice, anchor: pending })));
      } else choices.push({ choice: pending.choice, anchor: pending });
    }
    if (extra && (pending?.index !== depth || matchesAnchor(extra.choice, pending))) {
      const same = choices.findIndex(item => canonical(item.choice) === canonical(extra.choice) && item.anchor?.id === extra.anchor?.id);
      if (same >= 0) choices[same] = extra; else choices.unshift(extra);
    }
    if (!explorer.strength) return choices;
    // 截断预算时也先覆盖不同地点；预约及饭点优先，人工精确组合不受此顺序限制。
    const groups = new Map(), scope = `choices:${stateKey(st)}`;
    for (const item of choices) {
      const key = `${item.anchor ? 0 : item.choice.mealRole ? 1 : 2}:${item.choice.sceneId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const buckets = [...groups.entries()].map(([key, items]) => ({ key, items, rank: explorer.noise(scope, key) }))
      .sort((a, b) => Number(a.key[0]) - Number(b.key[0]) || b.rank - a.rank || cmp(a.key, b.key)).map(group => group.items);
    const spread = [];
    for (let rank = 0; spread.length < choices.length; rank++) for (const bucket of buckets) if (bucket[rank]) spread.push(bucket[rank]);
    return spread;
  }
  // 人工阶段的反事实求解复用同一评估器，每轮调用共用固定节点预算，避免逐卡重跑规划器。
  function* searchFrom(root, nodeLimit, counterfactual = false, extra = null) {
    const finished = [], history = new Map();
    let beam = [root], expanded = 0, budgetReached = false, sliceStarted = performance.now();
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
          if (options.continuationOnly && (expanded % 64 === 0 || performance.now() - sliceStarted >= 8)) {
            yield { expandedNodes: expanded, terminalPlans: finished.length };
            sliceStarted = performance.now();
          }
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
      if ((ctx.periodIds || ctx.requiredSceneIds.length) && width < unique.length) {
        // 场合是软目标；单独保留已匹配的分支，避免短庆祝在完整收益出现前被长停留挤掉。
        const groups = new Map();
        for (const child of unique) {
          const occasionCovered=ctx.occasion!=='daily'&&child.stages.some(stage=>stage.tags.includes(ctx.occasion));
          const key = `${child.mealRoles.length}:${child.anchorIndex}:${coveredPeriodIds(child, ctx).join(',')}:${requiredCovered(child).join(',')}:${occasionCovered}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(child);
        }
        const buckets = [...groups.values()].sort((a, b) => b[0].mealRoles.length - a[0].mealRoles.length || b[0].anchorIndex - a[0].anchorIndex || requiredCovered(b[0]).length - requiredCovered(a[0]).length || coveredPeriodIds(b[0], ctx).length - coveredPeriodIds(a[0], ctx).length)
          .map(bucket => explorer.select(bucket, width, { key: stateKey, value: st => objective(st, exploration), bucket: st => st.last, scope: `beam:${depth}`, temperature: 65 * Math.sqrt(depth + 1) }));
        beam = [];
        for (let rank = 0; beam.length < width; rank++) {
          let added = false;
          for (const bucket of buckets) if (bucket[rank] && beam.length < width) { beam.push(bucket[rank]); added = true; }
          if (!added) break;
        }
      } else beam = explorer.select(unique, width, { key: stateKey, value: st => objective(st, exploration), bucket: st => st.last, scope: `beam:${depth}`, temperature: 65 * Math.sqrt(depth + 1) });
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
  const searched = yield* searchFrom(start, config.maxExpandedNodes);
  const { finished, history } = searched;
  if (known && !known.errors.length && !finished.some(st => stateKey(st) === stateKey(known.state))) finished.push(known.state);
  stats.expandedNodes = searched.expanded; stats.nodeBudgetReached = searched.budgetReached;
  stats.terminalPlans = finished.length;
  stats.reasoningSnapshots = evaluator.reasoningCache.size;
  if (!finished.length) return errorResponse('no_plan_found', [fail('SEARCH_NO_PLAN', '有界搜索未找到同时满足前缀、锚点和必要目标的完整方案；不据此证明模型无解。')], ctx, versions, { prefix, exploration, search: stats, evaluated: stats.expandedNodes, paretoPlans: [] });
  finished.sort((a, b) => orderStates(a, b, exploration));
  const selection = explorer.choose(finished, { key: stateKey, value: st => objective(st, exploration), scope: 'complete-plan' });
  // 后续候选评分取发现的最高真实效用，不把探索选择的噪声带入契合分。
  const preferBest = options.continuationOnly || config.selectionMode === 'utility_best';
  const best = preferBest ? finished[0] : selection.selected;
  const displayMode = explorer.strength ? 'seeded_exploration' : 'utility_best';
  const explorationSelection = { version: EXPLORATION_VERSION, seed: ctx.explorationSeed, strength: explorer.strength, mode: config.selectionMode, label: preferBest ? '效用择优' : '探索选择', objective: objective(best, exploration), bestDiscoveredObjective: selection.bestDiscoveredObjective, utilityGap: preferBest ? 0 : selection.utilityGap, maxUtilityGap: preferBest ? 0 : selection.maxUtilityGap, searchNoise: preferBest ? 0 : selection.searchNoise };
  if (options.continuationOnly) return continuationResult(best, best === known?.state ? known.prefixUtility : candidatePrefixUtility);
  function continuationValues(terminals, searchHistory) {
    const values = new Map();
    for (const terminal of terminals) {
      const value = objective(terminal, exploration);
      const witness = compactWitness(terminal);
      let anchorIndex = 0;
      for (let i = 0; i < terminal.stages.length; i++) {
        if (terminal.stages[i].anchorId !== undefined) anchorIndex++;
        const key = stateKey({ stages: terminal.stages.slice(0, i + 1), anchorIndex, placeId: terminal.stages[i].after.placeId });
        const evaluated = terminal.stages.length > i + 1 || searchHistory.has(key) || i + 1 === config.maxStages;
        const old = values.get(key);
        // 保留原有完整评选门槛；最高分及其见证始终来自同一个真实终态。
        values.set(key, { value: Math.max(old?.value ?? -Infinity, value), evaluated: evaluated || old?.evaluated === true, witness: !old || value > old.value ? witness : old.witness });
      }
    }
    return values;
  }
  const mainContinuations = continuationValues(finished, history);
  let before = initial(ctx);
  const beforeByIndex = [];
  const stages = best.stages.map((original, index) => {
    beforeByIndex.push(before);
    const anchor = original.anchorId ? anchors.find(a => a.id === original.anchorId) : null;
    const lockedStage = index < prefix.length || Boolean(anchor) || Boolean(ctx.mealRequirements.find(m => m.mealRole === original.mealRole)?.sceneId);
    const replayChoice = compactWitness({stages:[original]})[0];
    const ownState = evaluator.evaluate(before, replayChoice, anchor, true).next;
    const prefixUtility = objective(before, exploration), referenceUtility = 80 * (ctx.periodIds ? 0.96 : 0.88) ** index;
    const scoreReference = { version: CONFIG.scoreVersion, stageIndex: index, prefixUtility, referenceUtility, zeroUtilityScore: 50, label: '方案契合分', unit: 'points', range: [0, 100], method: 'signed_remaining_utility', formula: '50 + 50 * (q - prefixUtility) / (abs(q - prefixUtility) + referenceUtility)', scope: 'previous_stages_and_anchors', searchStatus: 'bounded_not_proved_optimal' };
    // 单调映射使用本阶段共同参考尺；0效用为50分，正负收益均可区分，不以批内最高分强制100。
    const scoreForContinuation = q => +(50 + 50 * (q - prefixUtility) / (Math.abs(q - prefixUtility) + referenceUtility)).toFixed(2);
    let stageHistory = history, values = mainContinuations;
    if (index < prefix.length) {
      const remaining = config.maxCandidateExpandedNodes - stats.candidateExpandedNodes;
      const budget = Math.floor(remaining / (prefix.length - index));
      const counterfactual = finishSearch(searchFrom(before, budget, true, { choice: replayChoice, anchor, manual: true }));
      stats.candidateExpandedNodes += counterfactual.expanded;
      stats.candidateNodeBudgetReached ||= counterfactual.budgetReached;
      stageHistory = counterfactual.history;
      // 保留此前阶段及锚点，释放当前与后续人工前缀；实际完整方案也是合法的已知后续。
      values = continuationValues([...counterfactual.finished, best], stageHistory);
    }
    const transitions = [...(stageHistory.get(stateKey(before)) || []), ownState].filter(s => (s.stages.at(-1).mealRole ?? null) === (original.mealRole ?? null));
    function entryFor(candidateState, knownPlan = false) {
      const candidate = candidateState.stages.at(-1), key = stateKey(candidateState), completion = values.get(key);
      const found = knownPlan || completion?.evaluated === true;
      const q = found ? (knownPlan ? objective(best, exploration) : completion.value) : null;
      const continuationWitness = found ? (knownPlan ? compactWitness(best) : completion.witness) : null;
      const fitScore = found ? scoreForContinuation(q) : null;
      const evaluationStatus = found ? 'complete_continuation_found' : stageHistory.has(key) ? 'bounded_no_continuation_found' : 'continuation_not_evaluated';
      return { sceneId: candidate.sceneId, activityIds: candidate.activityIds, ...(candidate.mealRole ? { mealRole: candidate.mealRole } : {}), ...(candidate.anchorId !== undefined ? { anchorId: candidate.anchorId } : {}), ...(continuationWitness ? { continuationWitness } : {}), minutes: candidate.minutes, transfer: candidate.transfer, cost: candidate.cost, costCents: candidate.costCents, load: candidate.load, start: candidate.start, end: candidate.end, localUtility: objective(candidateState, exploration) - prefixUtility, rawUtility: q, q, fitScore, score: fitScore, recommendationIndex: fitScore, scoreVersion: CONFIG.scoreVersion, scoreStatus: found ? 'evaluated' : 'pending', evaluationStatus, conditional: true, continuationFound: found, feasibilityStatus: found ? 'feasible_continuation_found' : 'local_feasible_future_not_proved', featureContributions: candidate.featureContributions };
    }
    const byScene = new Map();
    for (const candidateState of transitions) {
      const entry = entryFor(candidateState);
      if (Number.isFinite(candidateState.stages.at(-1).fixedStartMinute)) entry.fixedStartMinute = candidateState.stages.at(-1).fixedStartMinute;
      const old = byScene.get(entry.sceneId);
      if (!old || Number(entry.continuationFound) > Number(old.continuationFound) || entry.continuationFound === old.continuationFound && ((entry.q ?? entry.localUtility) > (old.q ?? old.localUtility) || (entry.q ?? entry.localUtility) === (old.q ?? old.localUtility) && cmp(canonical(entry.activityIds), canonical(old.activityIds)) < 0)) byScene.set(entry.sceneId, entry);
    }
    // 选中卡仍使用实际活动组合的完整方案效用；人工锁定允许低于其他方案。
    const own = entryFor(ownState, true);
    if (Number.isFinite(original.fixedStartMinute)) own.fixedStartMinute = original.fixedStartMinute;
    byScene.set(own.sceneId, own);
    const orderEntries = (a, b) => Number(b.continuationFound) - Number(a.continuationFound) || (a.continuationFound ? b.q - a.q : 0) || cmp(a.sceneId, b.sceneId);
    const allEntries = [...byScene.values()].sort(orderEntries);
    // 展示与真实评分分离，未验证场景可以靠前展露，但仍只能带 pending 状态。
    const explorationDisplay = explorer.strength > 0 && !lockedStage;
    let ordered = explorationDisplay ? explorer.display(allEntries, config.candidateLimit, { key: c => c.sceneId, confirmed: c => c.continuationFound, dream: c => compiled.byId.get(c.sceneId)?.dreamOnly || compiled.byId.get(c.sceneId)?.tags.includes('dream'), scope: `cards:${stateKey(before)}` }) : allEntries.slice(0, config.candidateLimit);
    if (!ordered.some(c => c.sceneId === own.sceneId)) ordered = [...ordered.slice(0, config.candidateLimit - 1), own];
    if (!explorationDisplay) ordered.sort(orderEntries);
    ordered = ordered.map((candidate, rank) => ({ ...candidate, explorationRank: rank, displayOrderIndex: rank }));
    const decisionMode = lockedStage ? 'manual' : explorationSelection.mode;
    const stage = { ...original, index, fitScore: own.fitScore, score: own.score, recommendationIndex: own.score, scoreStatus: own.scoreStatus, evaluationStatus: own.evaluationStatus, scoreVersion: own.scoreVersion, scoreReference, rawUtility: own.rawUtility, candidates: ordered, manual: index < prefix.length, selected: true, choiceMode: decisionMode, decisionMode, selectionMode: decisionMode, displayMode: explorationDisplay ? 'seeded_exploration' : 'utility_best', selectionLabel: lockedStage ? '人工固定' : explorationSelection.label };
    before = ownState;
    return stage;
  });
  const mealRequirements = ctx.mealRequirements.map(meal => {
    const bundledIndex=stages.findIndex(stage=>stage.bundledMeals?.some(item=>item.mealRole===meal.mealRole));
    if(bundledIndex>=0)return {...meal,satisfied:true,bundled:true,sceneId:stages[bundledIndex].sceneId,stageIndex:bundledIndex,insertIndex:bundledIndex,activityIds:stages[bundledIndex].activityIds,candidates:[]};
    const actualIndex = stages.findIndex(s => s.mealRole === meal.mealRole);
    const stageIndex = actualIndex < 0 ? null : actualIndex;
    // 特殊餐次切回真实用餐时，释放跨越饭点的自动尾段；显式前缀仍不可回退。
    const specialMeal = meal.choiceMode !== 'together';
    const insertion = stages.findIndex(s => specialMeal ? s.end > meal.targetMinute : s.start >= meal.targetMinute);
    const insertIndex = stageIndex ?? Math.max(specialMeal ? prefix.length : 0, insertion < 0 ? stages.length : insertion);
    const menuState = beforeByIndex[insertIndex] ?? best;
    // 菜单替换只释放当前饭点选择，沿用前序资源、疲劳、费用和全部其他硬约束。
    const menuContext = { ...ctx, mealRequirements: ctx.mealRequirements.map(m => m.mealRole === meal.mealRole ? { ...m, choiceMode: 'together', mode: 'together', sceneId: null, activityIds: null } : m) };
    const menuEvaluator = createEvaluator(menuContext, compiled, catalog, exploration);
    const candidates = new Map((stageIndex === null ? [] : stages[stageIndex].candidates).map(c => [c.sceneId, c]));
    for (const scene of scopedScenes) {
      if (candidates.has(scene.id)) continue;
      for (const activityIds of mealActivityChoices(scene, meal.mealRole, subsets.get(scene.id))) {
        const checked = menuEvaluator.evaluate(menuState, { sceneId: scene.id, activityIds, mealRole: meal.mealRole }, null, true, true);
        if (checked.errors.length) continue;
        const candidate = checked.stage;
        candidates.set(scene.id, { sceneId: scene.id, activityIds, mealRole: meal.mealRole, minutes: candidate.minutes, start: candidate.start, end: candidate.end, transfer: candidate.transfer, cost: candidate.cost, costCents: candidate.costCents, load: candidate.load, fitScore: null, score: null, scoreStatus: 'pending', evaluationStatus: 'continuation_not_evaluated', feasibilityStatus: 'local_feasible_future_not_proved', continuationFound: false });
        break;
      }
    }
    const exploredMenu = explorer.strength > 0 && stageIndex !== null && stages[stageIndex].displayMode === 'seeded_exploration';
    const menuEntries = [...candidates.values()].sort((a, b) => Number(b.continuationFound) - Number(a.continuationFound) || (b.fitScore ?? -Infinity) - (a.fitScore ?? -Infinity) || cmp(a.sceneId, b.sceneId));
    const ordered = (exploredMenu ? explorer.display(menuEntries, menuEntries.length, { key: c => c.sceneId, confirmed: c => c.continuationFound, scope: `meal-cards:${meal.mealRole}:${stateKey(menuState)}` }) : menuEntries)
      .map((candidate, rank) => ({ ...candidate, explorationRank: rank, displayOrderIndex: rank }));
    if (stageIndex !== null) stages[stageIndex].candidates = ordered;
    return { ...meal, satisfied: meal.choiceMode !== 'together' || stageIndex !== null, sceneId: stageIndex === null ? null : stages[stageIndex].sceneId, activityIds: stageIndex === null ? [] : stages[stageIndex].activityIds, stageIndex, insertIndex, candidates: ordered };
  });
  stats.reasoningSnapshots = evaluator.reasoningCache.size;
  const measured = metrics(best, ctx, exploration);
  const departure = departureResult(ctx, best);
  const assumptions = ['时间、费用、负担和恢复量为教学设计参数；实际开放、交通与双方感受仍需确认。', '费用区间为双人总额，约束使用整数分的上界。'];
  if (ctx.weather === 'cloudy') assumptions.push('天气未提供或旧值unknown时按多云处理；天气偏好仅调整排序。');
  if (departure?.id === 'hotel') assumptions.push('酒店费用为所选城市等级的一间双人客房设计区间，并非实际房价；房源、交通和入住条件需确认。');
  const warnings = [...new Set(stages.flatMap(s => s.warnings))];
  const replay = { schema: 'datemate-replay-3.0', versions, context: ctx, exploration, explorationSeed: ctx.explorationSeed, explorationVersion: EXPLORATION_VERSION, prefix, anchors, search: config, ...(known && !known.errors.length ? { knownPlan: compactWitness(known.state) } : {}) };
  const core = { stages: stages.map(s => ({ sceneId: s.sceneId, activityIds: s.activityIds, ...(s.mealRole ? { mealRole: s.mealRole } : {}), start: s.start, end: s.end, costCents: s.costCents, score: s.score })), mealRequirements, ...(departure ? { departure } : {}), metrics: measured };
  return { ok: true, status: 'feasible', searchStatus: 'heuristic_feasible_not_proved_optimal', context: ctx, exploration, explorationSeed: ctx.explorationSeed, choiceMode: explorationSelection.mode, decisionMode: explorationSelection.mode, displayMode, explorationSelection, prefix, anchors, stages, continuationWitness: compactWitness(best), mealRequirements, ...(departure ? { departure } : {}), totalCost: measured.totalCost, totalCostCents: measured.totalCostCents, endingBuffer: measured.endingBuffer, metrics: measured, candidates: stages.map(s => s.candidates), paretoPlans: pareto(finished, ctx, exploration), trace: stages.flatMap(s => s.trace), search: stats, evaluated: stats.expandedNodes, versions, assumptions, warnings, errors: [], suggestions: [], replay, fingerprint: digest(replay), inputDigest: digest(replay), outputFingerprint: digest(core), outputDigest: digest(core) };
}

export function createPlanner(catalog, options = {}) {
  return { catalog, plan: (context = {}, exploration = 0, prefix = []) => planDate(context, catalog, { ...options, exploration, fixedPrefix: prefix }), normalizePrefix: prefix => normalizePrefix(prefix, catalog), check: (context, prefix) => planDate(context, catalog, { ...options, exploration: 0, fixedPrefix: prefix }) };
}
