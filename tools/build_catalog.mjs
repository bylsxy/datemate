#!/usr/bin/env node
// 手工知识源是编辑入口；编译产物可重复生成，构建过程只读取 knowledge/。
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SOURCE_SCHEMA = 'manual-knowledge-1.0';
export const SOURCE_FILES = ['scenes', 'activities', 'rules', 'metadata', 'evidence', 'source-registry', 'conditions', 'departures'];
const CITY_TIERS = ['tier1', 'tier2', 'tier3'];
const ARRAY_FIELDS = ['predecessorIds', 'requires', 'preconditions', 'provides', 'consumes', 'preparationIds', 'windows', 'dietaryTags'];
const ACTIVITY_TIME_FIELDS = ['minutes', 'duration', 'durationMinutes', 'compositionMode', 'durationMode'];
const MEAL_ROLES = new Set(['breakfast', 'lunch', 'dinner', 'supper']);
const OPS = new Set(['exists', 'eq', 'equals', '==', 'neq', 'not_equals', '!=', 'gt', '>', 'gte', '>=', 'lt', '<', 'lte', '<=', 'in', 'not_in', 'contains', 'not_contains', 'intersects', 'truthy', 'falsy']);
const ACTIONS = new Set(['set_fact', 'exclude_scene', 'exclude_activity', 'prefer_scene', 'prefer_activity', 'require_preparation', 'add_warning']);
const sha = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const order = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const json = value => JSON.stringify(value, null, 2) + '\n';
const unique = values => [...new Set(values)];
function ensure(ok, message) { if (!ok) throw new Error(`知识源验证失败：${message}`); }
function text(value, path) { ensure(typeof value === 'string' && value.trim().length > 0, `${path} 须为非空字符串`); }
function list(value, path) { ensure(Array.isArray(value), `${path} 须为数组`); return value; }
function ids(value, path) {
  const values = list(value, path);
  values.forEach(v => text(v, path));
  ensure(new Set(values).size === values.length, `${path} 包含重复 ID`);
  return values;
}
function index(items, path) {
  const result = new Map();
  list(items, path).forEach(item => {
    ensure(item && typeof item === 'object' && !Array.isArray(item), `${path} 条目须为对象`);
    text(item.id, `${path}.id`);
    ensure(!result.has(item.id), `${path} ID 重复：${item.id}`);
    result.set(item.id, item);
  });
  return result;
}
function references(values, known, path) {
  ids(values, path).forEach(id => ensure(known.has(id), `${path} 引用了不存在的 ID：${id}`));
}

export async function loadKnowledge(sourceDir = new URL('../knowledge/', import.meta.url)) {
  const dir = sourceDir instanceof URL ? fileURLToPath(sourceDir) : sourceDir;
  const entries = await Promise.all(SOURCE_FILES.map(async name => {
    const raw = await readFile(resolve(dir, name + '.json'), 'utf8');
    let value;
    try { value = JSON.parse(raw); } catch (error) { throw new Error(`${name}.json JSON 语法错误：${error.message}`); }
    ensure(value.schemaVersion === SOURCE_SCHEMA, `${name}.json schemaVersion 须为 ${SOURCE_SCHEMA}`);
    return [name, value, sha(raw)];
  }));
  return { documents: Object.fromEntries(entries.map(([name, value]) => [name, value])), sourceHashes: Object.fromEntries(entries.map(([name, , hash]) => [name + '.json', hash])) };
}

function normalizeActivity(raw) {
  const activity = { group: 'play', mode: 'multi', novelty: 45, requiresExplicitConsent: false, parameterStatus: 'designed_not_measured', publicAllowed: true, ...clone(raw) };
  delete activity._comment;
  // 活动在场景固定时段内发生，费用、体力与资源仍按所选活动核算。
  activity.minutes = 0;
  activity.compositionMode = 'included';
  activity.durationMode = 'within_scene';
  for (const field of ARRAY_FIELDS) activity[field] ??= [];
  activity.mealRoles ??= [];
  activity.featureValues = { novelty: activity.novelty, physicalLoad: activity.load };
  return activity;
}
function normalizeScene(raw) {
  const scene = { fit: 78, novelty: 45, mental: 1, bold: false, crowdRisk: 'unknown', reviewStatus: 'reviewed', evidenceStatus: 'local_source_summary_reviewed_real_world_unverified', parameterStatus: 'designed_not_measured', publicAllowed: true, ...clone(raw) };
  delete scene._comment;
  delete scene.activityIds;
  delete scene.activityOverrides;
  scene.title = scene.place.name;
  scene.typeId ??= scene.id;
  scene.quiet ??= scene.tags.includes('quiet');
  scene.seated ??= scene.load <= 0;
  scene.weather ??= scene.indoor ? ['clear', 'rain', 'unknown'] : ['clear', 'unknown'];
  scene.default = [];
  scene.mealRoles ??= [];
  scene.source = scene.evidenceIds.map(id => id.replace(/^E-/, ''));
  for (const field of ARRAY_FIELDS) scene[field] ??= [];
  scene.featureValues = { quiet: +scene.quiet, indoor: +scene.indoor, novelty: scene.novelty, physicalLoad: scene.load, mentalLoad: scene.mental };
  return scene;
}
function validateEntity(item, evidence, resources, allEntityIds, tags, path) {
  text(item.title, `${path}.title`); text(item.description, `${path}.description`);
  ensure(Number.isInteger(item.minutes) && item.minutes >= 0, `${path}.minutes 须为非负整数`);
  ensure(Array.isArray(item.cost) && item.cost.length === 2 && item.cost.every(n => Number.isFinite(n) && n >= 0 && Number.isInteger(Number((n * 100).toFixed(8)))) && item.cost[0] <= item.cost[1], `${path}.cost 须为按分计价的递增两人费用区间`);
  ensure(Number.isFinite(item.load), `${path}.load 须为有限数值`);
  ensure(Number.isFinite(item.novelty) && item.novelty >= 0 && item.novelty <= 100, `${path}.novelty 须在 0 至 100 之间`);
  ensure(item.parameterStatus === 'designed_not_measured', `${path} 数值参数须标明 designed_not_measured`);
  ensure(item.publicAllowed === true, `${path} 当前公开目录只编译 publicAllowed=true 的设计项`);
  ensure(item.evidenceIds?.length > 0, `${path} 须有证据或用户设计依据`);
  references(item.evidenceIds, evidence, `${path}.evidenceIds`);
  references(item.tags, tags, `${path}.tags`);
  references(item.predecessorIds, allEntityIds, `${path}.predecessorIds`);
  for (const field of ['requires', 'preconditions', 'provides', 'consumes', 'preparationIds']) references(item[field], resources, `${path}.${field}`);
  ids(item.dietaryTags, `${path}.dietaryTags`);
  ids(item.mealRoles, `${path}.mealRoles`).forEach(role => ensure(MEAL_ROLES.has(role), `${path}.mealRoles 餐次无效：${role}`));
  if (Object.hasOwn(item, 'compositionMode')) {
    if (item.mealRoles.length) ensure(item.provides.includes('meal_completed'), `${path} 用餐活动须提供 meal_completed`);
    if (item.provides.includes('meal_completed')) ensure(item.mealRoles.length > 0, `${path} 用餐活动须声明适用餐次`);
  }
  list(item.windows, `${path}.windows`).forEach(w => ensure(Number.isInteger(w.startMinute) && Number.isInteger(w.endMinute) && w.startMinute >= 0 && w.startMinute < w.endMinute && w.endMinute <= 1440, `${path}.windows 时间窗无效`));
  if (Object.hasOwn(item, 'compositionMode')) {
    ensure(item.compositionMode === 'included' && item.durationMode === 'within_scene' && item.minutes === 0, `${path} 活动须在场景固定时段内且不增加耗时`);
    ensure(['single', 'multi'].includes(item.mode), `${path}.mode 无效`);
    ensure(typeof item.requiresExplicitConsent === 'boolean', `${path}.requiresExplicitConsent 须为布尔值`);
  } else ensure(item.minutes > 0, `${path}.minutes 须为正整数；场景是唯一耗时入口`);
}

function validateRule(rule, sceneIds, activityIds, evidence, resources, tags, conditions) {
  const path = `rules.${rule.id}`;
  text(rule.title, `${path}.title`);
  ensure(Number.isFinite(rule.priority), `${path}.priority 须为有限数值`);
  ensure(['hard', 'soft', 'hint'].includes(rule.strength), `${path}.strength 无效`);
  ensure(typeof rule.enabled === 'boolean', `${path}.enabled 须为布尔值`);
  ensure(rule.evidenceIds?.length > 0, `${path} 须有依据`);
  references(rule.evidenceIds, evidence, `${path}.evidenceIds`);
  ensure(rule.when && (Array.isArray(rule.when.all) || Array.isArray(rule.when.any)), `${path}.when 须含 all 或 any 条件数组`);
  for (const part of ['all', 'any']) for (const check of rule.when[part] ?? []) {
    text(check.fact, `${path}.when.fact`);
    ensure(OPS.has(check.op), `${path} 条件操作符无效：${check.op}`);
    if (!['exists', 'truthy', 'falsy'].includes(check.op)) ensure(Object.hasOwn(check, 'value'), `${path} 条件缺少 value`);
    if (check.fact.startsWith('context.')) ensure(conditions.has(check.fact.slice(8)), `${path} 未登记输入条件：${check.fact}`);
    const values = Array.isArray(check.value) ? check.value : [check.value];
    let known;
    if (check.fact === 'scene.id') known = sceneIds;
    if (check.fact === 'activity.id') known = activityIds;
    if (check.fact.endsWith('.tags') || /^context.preferences[A-B]?$/.test(check.fact)) known = tags;
    if (check.fact === 'context.preparedIds' || /\.(requires|preconditions|provides|consumes|preparationIds)$/.test(check.fact)) known = resources;
    if (known && !['exists', 'truthy', 'falsy'].includes(check.op)) values.forEach(v => ensure(known.has(v), `${path} 条件引用无效：${v}`));
  }
  ensure(Array.isArray(rule.then) && rule.then.length > 0, `${path}.then 须有动作`);
  for (const action of rule.then) {
    ensure(ACTIONS.has(action.action), `${path} 规则动作无效：${action.action}`);
    if (action.action === 'set_fact') text(action.fact, `${path}.then.fact`);
    if (['prefer_scene', 'prefer_activity'].includes(action.action)) ensure(Number.isFinite(action.amount), `${path} 偏好加分须为有限数值`);
    if (action.action === 'require_preparation') references(action.preparationIds ?? [action.preparationId ?? action.id], resources, `${path}.then.preparationIds`);
  }
}

// 离开是行程结尾的独立选择，住宿不得进入场景搜索或默认推荐。
function compileDepartures(doc, evidence, publicIds, metadata, conditions) {
  const items = index(doc.departures, 'departures');
  ensure(items.size === 3 && ['separate', 'walk_together', 'hotel'].every(id => items.has(id)), 'departures 须包含 separate、walk_together、hotel 三项');
  ensure(doc.defaultId === 'separate', 'departures.defaultId 须为 separate');
  ensure(metadata.defaultContext.departureChoice === doc.defaultId, 'metadata.defaultContext.departureChoice 与离开默认值不一致');
  ensure(metadata.defaultContext.cityTier === 'tier1', 'metadata.defaultContext.cityTier 须为 tier1');
  ensure(JSON.stringify(conditions.get('cityTier')?.allowedValues) === JSON.stringify(CITY_TIERS), 'conditions.cityTier 须登记 tier1/tier2/tier3');
  ensure(JSON.stringify(conditions.get('departureChoice')?.allowedValues) === JSON.stringify(['separate', 'walk_together', 'hotel']), 'conditions.departureChoice 须登记三种离开选择');
  for (const item of items.values()) {
    const path = `departures.${item.id}`;
    ensure(!publicIds.includes(item.id), `${path} ID 与地点、活动或其他公开实体冲突`);
    ensure(!['place', 'activities', 'activityIds', 'mealRoles'].some(k => Object.hasOwn(item, k)), `${path} 须为独立离开数据`);
    text(item.title, `${path}.title`); text(item.description, `${path}.description`);
    ensure(Number.isInteger(item.minutes) && item.minutes > 0, `${path}.minutes 须为正整数`);
    ensure(item.parameterStatus === 'designed_not_measured' && item.assertionKind === 'designed', `${path} 须明确为设计参数`);
    ensure(item.publicAllowed === true, `${path}.publicAllowed 须为 true`);
    ensure(item.evidenceIds?.length > 0, `${path} 须有设计依据`);
    references(item.evidenceIds, evidence, `${path}.evidenceIds`);
    ensure(item.evidenceIds.every(id => evidence.get(id).assertionKind === 'designed'), `${path} 费用与时长须引用 designed 依据`);
    ensure(typeof item.onlyOvernight === 'boolean' && typeof item.requiresExplicitChoice === 'boolean', `${path} 离开限制须为布尔值`);
    if (item.id === 'hotel') {
      ensure(item.onlyOvernight === true && item.requiresExplicitChoice === true && item.minutes === 15, `${path} 须仅在过夜且用户明确选择时生效，入住预留15分钟`);
      ensure(!Object.hasOwn(item, 'cost'), `${path} 房费须按 cityTier 提供`);
      ensure(item.costUnit === 'CNY_per_room_for_two_per_night', `${path}.costUnit 须说明双人一晚房费`);
      ensure(item.costByCityTier && Object.keys(item.costByCityTier).length === 3 && CITY_TIERS.every(tier => Object.hasOwn(item.costByCityTier, tier)), `${path}.costByCityTier 须完整列出三档`);
      for (const tier of CITY_TIERS) {
        const cost = item.costByCityTier[tier];
        ensure(Array.isArray(cost) && cost.length === 2 && cost.every(n => Number.isFinite(n) && n >= 0 && Number.isInteger(Number((n * 100).toFixed(8)))) && cost[0] <= cost[1], `${path}.${tier} 须为有效费用区间`);
      }
    } else {
      ensure(item.onlyOvernight === false && item.requiresExplicitChoice === (item.id === 'walk_together'), `${path} 免费离开限制无效`);
      ensure(JSON.stringify(item.cost) === '[0,0]' && !Object.hasOwn(item, 'costByCityTier'), `${path} 免费离开费用须为 [0,0]`);
    }
  }
  return [...items.values()].map(clone).sort(order);
}

export function buildGraph(catalog, evidence, sources, resources) {
  const nodes = new Map(), edges = new Map();
  const node = (id, type, label, extra = {}) => {
    const previous = nodes.get(id);
    ensure(!previous || previous.type === type, `图节点 ID 跨类型重复：${id}`);
    nodes.set(id, { id, type, label, ...extra });
  };
  const edge = (subject, predicate, object, basis, assertionKind = 'designed') => {
    const id = 'EDGE-' + sha(JSON.stringify([subject, predicate, object])).slice(0, 14);
    const previous = edges.get(id);
    ensure(!previous || (previous.subject === subject && previous.predicate === predicate && previous.object === object), `图边 ID 冲突：${id}`);
    edges.set(id, { id, subject, predicate, object, evidenceIds: unique([...(previous?.evidenceIds ?? []), ...basis]).sort(), assertionKind });
  };
  for (const source of sources) node(source.id, 'source', source.title);
  for (const ev of evidence) {
    node(ev.id, 'evidence', ev.summary);
    const origin = ev.sourceKind === 'user_design' ? ev.sourceLocator : ev.sourceDocumentId;
    if (ev.sourceKind === 'user_design') node(origin, 'user_design', '用户项目设计；现实信息待确认');
    edge(ev.id, 'derived_from', origin, [ev.id], ev.sourceKind === 'user_design' ? 'designed' : 'observed');
  }
  for (const tag of unique([...catalog.interestTags, 'outdoor', ...catalog.scenes.flatMap(s => s.tags), ...catalog.activities.flatMap(a => a.tags)])) node('tag:' + tag, 'feature', tag);
  for (const resource of resources) node('resource:' + resource.id, 'resource', resource.label);
  const entityEdges = item => {
    for (const tag of item.tags) edge(item.id, 'has_feature', 'tag:' + tag, item.evidenceIds);
    for (const predicate of ['requires', 'preconditions', 'provides', 'consumes', 'preparationIds']) for (const rid of item[predicate]) edge(item.id, predicate, 'resource:' + rid, item.evidenceIds);
    for (const prior of item.predecessorIds) edge(item.id, 'follows', prior, item.evidenceIds);
    for (const ev of item.evidenceIds) edge(item.id, 'supported_by', ev, [ev]);
  };
  for (const activity of catalog.activities) { node(activity.id, 'activity', activity.title); entityEdges(activity); }
  for (const scene of catalog.scenes) {
    node(scene.id, 'scene', scene.title, { placeKind: scene.place.kind, category: scene.place.category });
    entityEdges(scene);
    for (const activity of scene.activities) {
      edge(scene.id, 'allows_activity', activity.id, unique([...scene.evidenceIds, ...activity.evidenceIds]));
      // 共享活动的地点增量由变体节点记录，避免把自带桌游要求传播到所有地点。
      if (activity.sceneOverride) {
        const id = `activity-at:${scene.id}:${activity.id}`;
        node(id, 'activity_variant', `${scene.title}：${activity.title}`);
        edge(scene.id, 'has_activity_variant', id, activity.evidenceIds);
        edge(id, 'specializes', activity.id, activity.evidenceIds);
        entityEdges({ ...activity, id });
      }
    }
  }
  for (const departure of catalog.departures) {
    node(departure.id, 'departure', departure.title);
    for (const ev of departure.evidenceIds) edge(departure.id, 'supported_by', ev, [ev], 'designed');
  }
  for (const rule of catalog.rules) { node(rule.id, 'rule', rule.title); for (const ev of rule.evidenceIds) edge(rule.id, 'supported_by', ev, [ev]); }
  const nodeIds = new Set(nodes.keys()), evidenceIds = new Set(evidence.map(e => e.id));
  for (const item of edges.values()) {
    ensure(nodeIds.has(item.subject) && nodeIds.has(item.object), `图边端点缺失：${item.id}`);
    references(item.evidenceIds, evidenceIds, `graph.${item.id}.evidenceIds`);
  }
  return { version: catalog.version, nodes: [...nodes.values()].sort(order), edges: [...edges.values()].sort(order), queryExamples: [{ start: 'campus_tabletennis', predicates: ['allows_activity', 'requires'], purpose: '从所选乒乓球活动查询装备依赖' }, { start: 'supermarket', predicates: ['allows_activity', 'provides'], purpose: '从超市活动查询野餐物资' }, { start: 'photo_print', predicates: ['follows'], purpose: '查询冲印的先行活动' }, { start: 'taishan_glass', predicates: ['has_activity_variant', 'requires'], purpose: '查询玻璃房桌游的场地增量要求' }].filter(q => nodeIds.has(q.start)) };
}

export function compileKnowledge(input) {
  const { documents: docs, sourceHashes = {} } = input;
  const metadata = clone(docs.metadata);
  for (const name of SOURCE_FILES) ensure(docs[name]?.schemaVersion === SOURCE_SCHEMA, `${name}.json schemaVersion 不匹配`);
  text(metadata.version, 'metadata.version'); text(metadata.rulesVersion, 'metadata.rulesVersion');
  const rawScenes = index(docs.scenes.scenes, 'scenes'), rawActivities = index(docs.activities.activities, 'activities');
  for (const activity of rawActivities.values()) ensure(!ACTIVITY_TIME_FIELDS.some(field => Object.hasOwn(activity, field)), `activities.${activity.id} 不允许活动时间字段；请修改 scenes.json 中对应地点的 minutes`);
  const ruleMap = index(docs.rules.rules, 'rules'), evidenceMap = index(docs.evidence.evidence, 'evidence');
  const sourceMap = index(docs['source-registry'].sources, 'source-registry');
  const resources = index(metadata.preparationOptions, 'metadata.preparationOptions');
  const conditionMap = new Map(list(docs.conditions.conditions, 'conditions').map(c => [c.key, c]));
  ensure(conditionMap.size === docs.conditions.conditions.length, 'conditions 条件 key 重复');
  const entityIds = new Set([...rawScenes.keys(), ...rawActivities.keys()]);
  ensure(entityIds.size === rawScenes.size + rawActivities.size, '地点与活动 ID 不能相同');
  const publicIds = [...entityIds, ...ruleMap.keys(), ...evidenceMap.keys(), ...sourceMap.keys()];
  ensure(new Set(publicIds).size === publicIds.length, '地点、活动、规则、证据与来源 ID 须全局唯一');
  const tags = new Set([...ids(metadata.interestTags, 'metadata.interestTags'), 'outdoor']);
  const activities = [...rawActivities.values()].map(normalizeActivity).sort(order);
  const activityMap = new Map(activities.map(a => [a.id, a]));
  const attachments = new Map(activities.map(a => [a.id, []]));
  for (const ev of evidenceMap.values()) {
    text(ev.summary, `evidence.${ev.id}.summary`); text(ev.sourceLocator, `evidence.${ev.id}.sourceLocator`);
    ensure(ev.publicExcerptAllowed === false && !Object.hasOwn(ev, 'originalExcerpt') && !Object.hasOwn(ev, 'rawText'), `evidence.${ev.id} 只允许原创摘要与定位`);
    if (ev.sourceKind === 'user_design') {
      ensure(ev.sourceDocumentId === null && ev.assertionKind === 'designed' && ev.reviewStatus === 'awaiting_confirmation', `evidence.${ev.id} 用户设计须标明待确认且不冒充语料来源`);
    } else {
      ensure(sourceMap.has(ev.sourceDocumentId), `evidence.${ev.id} 来源不存在：${ev.sourceDocumentId}`);
      ensure(/^L\d+$/.test(ev.sourceLocator) && /^[a-f0-9]{64}$/.test(ev.anchorSha256 ?? ''), `evidence.${ev.id} 缺少本地定位与锚点哈希`);
    }
  }
  for (const source of sourceMap.values()) {
    ensure(source.rawTextIncluded === false && !Object.hasOwn(source, 'rawText') && !Object.hasOwn(source, 'originalExcerpt'), `source.${source.id} 不允许发布原文`);
    ensure(/^[a-f0-9]{64}$/.test(source.sha256 ?? ''), `source.${source.id} 缺少文件哈希`);
    references(source.adoptedEvidenceIds, evidenceMap, `source.${source.id}.adoptedEvidenceIds`);
    source.adoptedEvidenceIds.forEach(id => ensure(evidenceMap.get(id).sourceDocumentId === source.id, `source.${source.id} 证据归属不一致：${id}`));
  }
  const scenes = [...rawScenes.values()].map(raw => {
    const path = `scenes.${raw.id}`;
    ensure(raw.place && typeof raw.place === 'object', `${path}.place 缺失`);
    text(raw.place.name, `${path}.place.name`); text(raw.place.category, `${path}.place.category`);
    ensure(['ordinary', '休息'].includes(raw.place.kind), `${path}.place.kind 须为 ordinary 或 休息`);
    ensure(['awaiting_confirmation', 'current_location', 'verified'].includes(raw.place.verificationStatus), `${path}.place.verificationStatus 无效`);
    if (raw.place.verificationStatus === 'awaiting_confirmation') ensure(!raw.place.address && !raw.place.openingHours, `${path} 待确认地点不能填入未核实的地址或营业时间`);
    if (raw.place.kind === '休息') ensure(raw.id === 'rest' && raw.kind === 'rest' && raw.area === 'current' && raw.activityIds.length === 0, `${path} 原地休息须无活动且 area=current`);
    if (raw.id === 'rest' || raw.kind === 'rest') ensure(raw.place.kind === '休息', `${path} 休息语义不一致`);
    references(raw.activityIds, rawActivities, `${path}.activityIds`);
    ensure(!Object.hasOwn(raw, 'mealActivityIds'), `${path}.mealActivityIds 由构建器生成`);
    ensure(!Object.hasOwn(raw, 'activities') && !Object.hasOwn(raw, 'title'), `${path} 活动引用用 activityIds，地点名称用 place.name`);
    const overrides = raw.activityOverrides ?? {};
    ensure(overrides && typeof overrides === 'object' && !Array.isArray(overrides), `${path}.activityOverrides 须为对象`);
    for (const [id, override] of Object.entries(overrides)) {
      ensure(raw.activityIds.includes(id), `${path} override 活动未挂载：${id}`);
      ensure(override && typeof override === 'object' && !Array.isArray(override), `${path}.${id} override 须为对象`);
      ensure(!['id', 'allowedSceneIds', 'allowedSceneTypes', 'sceneOverride', 'featureValues'].some(k => Object.hasOwn(override, k)), `${path}.${id} override 不能改写身份或派生字段`);
      ensure(!ACTIVITY_TIME_FIELDS.some(field => Object.hasOwn(override, field)), `${path}.${id} override 不允许活动时间字段；请修改地点的 minutes`);
    }
    const scene = normalizeScene(raw);
    if (Object.hasOwn(raw, 'scauOnly')) {
      ensure(typeof raw.scauOnly === 'boolean', `${path}.scauOnly 须为布尔值`);
      if (raw.scauOnly) ensure(raw.area === 'campus' && raw.place.universityId === 'scau' && raw.place.campusArea === 'taishan', `${path} 华农泰山区属性须一致`);
    }
    ensure(typeof scene.indoor === 'boolean' && typeof scene.quiet === 'boolean', `${path} indoor/quiet 须为布尔值`);
    ensure(['campus', 'near', 'off', 'current'].includes(scene.area), `${path}.area 无效`);
    scene.activities = raw.activityIds.map(id => {
      attachments.get(id).push(scene.id);
      const activity = normalizeActivity({ ...activityMap.get(id), ...clone(overrides[id] ?? {}) });
      activity.allowedSceneIds = [scene.id]; activity.allowedSceneTypes = [scene.typeId];
      if (overrides[id]) activity.sceneOverride = true;
      validateEntity(activity, evidenceMap, resources, entityIds, tags, `${path}.activities.${id}`);
      return activity;
    });
    validateEntity(scene, evidenceMap, resources, entityIds, tags, path);
    // 餐次卡只能选择实际完成用餐的活动；到场本身不能满足用餐目标。
    scene.mealActivityIds = scene.activities.filter(a => a.provides.includes('meal_completed')).map(a => a.id);
    if (scene.mealRoles.length) {
      ensure(!scene.provides.includes('meal_completed'), `${path} 用餐目标须由所选活动提供`);
      for (const role of scene.mealRoles) ensure(scene.activities.some(a => a.provides.includes('meal_completed') && a.mealRoles.includes(role)), `${path}.${role} 缺少适用的用餐活动`);
      for (const activity of scene.activities.filter(a => a.mealRoles.length)) ensure(activity.mealRoles.every(role => scene.mealRoles.includes(role)), `${path}.${activity.id} 活动餐次超出地点适用范围`);
    }
    return scene;
  }).sort(order);
  for (const activity of activities) {
    validateEntity(activity, evidenceMap, resources, entityIds, tags, `activities.${activity.id}`);
    activity.allowedSceneIds = attachments.get(activity.id).sort();
    ensure(activity.allowedSceneIds.length > 0, `activities.${activity.id} 未挂到任何地点`);
    activity.allowedSceneTypes = unique(scenes.filter(s => activity.allowedSceneIds.includes(s.id)).map(s => s.typeId)).sort();
  }
  const rules = [...ruleMap.values()].map(clone).sort((a, b) => b.priority - a.priority || order(a, b));
  rules.forEach(rule => validateRule(rule, rawScenes, rawActivities, evidenceMap, resources, tags, conditionMap));
  const evidence = [...evidenceMap.values()].map(clone).sort(order), sources = [...sourceMap.values()].map(clone).sort(order);
  const conditions = clone(docs.conditions.conditions);
  const departures = compileDepartures(docs.departures, evidenceMap, publicIds, metadata, conditionMap);
  const catalog = { version: metadata.version, rulesVersion: metadata.rulesVersion, schemaVersion: metadata.runtimeSchemaVersion, durationPolicy: 'scene_only', rights: metadata.rights, disclaimer: metadata.disclaimer, interestTags: metadata.interestTags, scenes, activities, rules, departures, defaultDepartureId: docs.departures.defaultId, cityTiers: CITY_TIERS, defaultCityTier: metadata.defaultContext.cityTier };
  const graph = buildGraph(catalog, evidence, sources, metadata.preparationOptions); catalog.graph = graph;
  // 手改内容自动产生修订指纹，复盘可识别同版本号下的知识变化。
  catalog.contentRevision = sha(JSON.stringify(catalog)).slice(0, 16);
  const checks = { status: 'passed', sceneCount: scenes.length, activityCount: activities.length, activityPlacementCount: scenes.reduce((n, s) => n + s.activities.length, 0), ruleCount: rules.length, evidenceCount: evidence.length, graphNodeCount: graph.nodes.length, graphEdgeCount: graph.edges.length, sourceCount: sources.length, scannedSourceCount: sources.filter(s => s.status === 'scanned').length, adoptedSourceCount: sources.filter(s => s.adoptedEvidenceIds.length).length, candidateOnlySourceCount: sources.filter(s => s.status === 'scanned' && !s.adoptedEvidenceIds.length).length, decodeFailedCount: sources.filter(s => s.status === 'decode_failed').length, rawExcerptsPublished: 0 };
  const audit = { version: catalog.version, checks, ...metadata.extraction, durationPolicy: 'scene_only', processingPolicy: '手工 UTF-8 JSON 为唯一编辑源；耗时由地点固定时长决定。原始语料抽取仅产生候选，发布只含原创摘要与设计参数。', sourceFiles: SOURCE_FILES.map(n => 'knowledge/' + n + '.json'), sourceHashes, catalogContentSha256: sha(JSON.stringify(catalog)), defaultContext: metadata.defaultContext, resourceDefinitions: Object.fromEntries(metadata.preparationOptions.map(p => [p.id, p.label])) };
  return { catalog, rules, graph, evidence, sources, conditions, metadata, audit };
}

export function serializeArtifacts(compiled) {
  const { catalog, rules, graph, evidence, sources, conditions, metadata, audit } = compiled;
  const moduleCatalog = Object.fromEntries(Object.entries(catalog).filter(([k]) => !['rules', 'graph'].includes(k)));
  let module = '// 由 tools/build_catalog.mjs 从 knowledge/*.json 编译；请编辑手工源。\n';
  for (const [name, value] of Object.entries({ catalog: moduleCatalog, rules, graph, sources, evidence, conditions })) module += `export const ${name} = ${JSON.stringify(value)};\n`;
  module += 'export const activities = catalog.activities;\ncatalog.rules = rules;\ncatalog.graph = graph;\nexport default catalog;\n';
  let options = '// 标签与资源元数据从 knowledge/metadata.json 编译。\n';
  for (const name of ['interestTags', 'interestOptions', 'preparationOptions', 'dietaryOptions']) options += `export const ${name} = ${JSON.stringify(metadata[name])};\n`;
  return { 'catalog.json': json(catalog), 'catalog.mjs': module, 'activities.mjs': options, 'rules.json': json(rules), 'graph.json': json(graph), 'evidence.json': json(evidence), 'source-registry.json': json(sources), 'conditions.json': json(conditions), 'extraction-report.json': json(audit) };
}

export async function main(args = process.argv.slice(2)) {
  const project = fileURLToPath(new URL('../', import.meta.url));
  let source = resolve(project, 'knowledge'), output = resolve(project, 'data'), check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') check = true;
    else if (args[i] === '--source' || args[i] === '--output') {
      ensure(args[i + 1] && !args[i + 1].startsWith('--'), `${args[i]} 缺少目录参数`);
      if (args[i] === '--source') source = resolve(args[++i]); else output = resolve(args[++i]);
    } else if (args[i] === '--help') {
      console.log('node tools/build_catalog.mjs [--check] [--source 目录] [--output 目录]\n默认读取 knowledge/ 编译到 data/；--check 只验证源与已编译文件是否一致。'); return;
    } else throw new Error(`未知参数：${args[i]}`);
  }
  const nested = (parent, child) => { const rel = relative(parent, child); return !rel || (!isAbsolute(rel) && !rel.startsWith('..' + sep) && rel !== '..'); };
  ensure(!nested(source, output), '输出目录不能是手工源或其子目录');
  const compiled = compileKnowledge(await loadKnowledge(source));
  const artifacts = serializeArtifacts(compiled);
  if (check) {
    for (const [name, expected] of Object.entries(artifacts)) {
      let actual;
      try { actual = await readFile(resolve(output, name), 'utf8'); } catch { throw new Error(`缺少编译文件：${name}；请运行 node tools/build_catalog.mjs`); }
      ensure(actual === expected, `编译文件已过期：${name}；请运行 node tools/build_catalog.mjs`);
    }
  } else {
    // 在任何写入之前完成全部规则、引用和图谱验证。
    await mkdir(output, { recursive: true });
    for (const [name, value] of Object.entries(artifacts)) await writeFile(resolve(output, name), value, 'utf8');
  }
  console.log(JSON.stringify({ mode: check ? 'checked' : 'compiled', ...compiled.audit.checks }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
