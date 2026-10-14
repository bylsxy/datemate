// 规则推导和图谱检索均为纯函数：同一快照不读取时间、随机数或隐式历史。
export const REASONING_VERSION = 'datemate-reasoning-3.0.0';
const cmp = (a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;

export function canonical(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort(cmp).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export function digest(value) {
  const text = typeof value === 'string' ? value : canonical(value);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0'); // 复盘校验码，不是安全哈希。
}

const clone = value => JSON.parse(JSON.stringify(value));
function getFact(facts, path) {
  if (Object.hasOwn(facts, path)) return facts[path];
  return String(path).split('.').reduce((v, key) => v !== null && v !== undefined && Object.hasOwn(Object(v), key) ? v[key] : undefined, facts);
}
function compare(actual, op, expected) {
  if (op === 'exists') return expected === false ? actual === undefined : actual !== undefined;
  // 缺失事实不等于false，也不满足neq/not_contains等否定条件。
  if (actual === undefined || actual?.status === 'unknown' || actual?.status === 'conflicting') return false;
  if (actual?.status === 'known') actual = actual.value;
  switch (op || 'eq') {
    case 'eq': case 'equals': case '==': return canonical(actual) === canonical(expected);
    case 'neq': case 'not_equals': case '!=': return canonical(actual) !== canonical(expected);
    case 'gt': case '>': return typeof actual === 'number' && actual > expected;
    case 'gte': case '>=': return typeof actual === 'number' && actual >= expected;
    case 'lt': case '<': return typeof actual === 'number' && actual < expected;
    case 'lte': case '<=': return typeof actual === 'number' && actual <= expected;
    case 'in': return Array.isArray(expected) && expected.includes(actual);
    case 'not_in': return Array.isArray(expected) && !expected.includes(actual);
    case 'contains': return (Array.isArray(actual) || typeof actual === 'string') && actual.includes(expected);
    case 'not_contains': return (Array.isArray(actual) || typeof actual === 'string') && !actual.includes(expected);
    case 'intersects': return Array.isArray(actual) && Array.isArray(expected) && actual.some(v => expected.includes(v));
    case 'truthy': return Boolean(actual);
    case 'falsy': return !actual;
    default: return false;
  }
}

function conditions(rule) {
  if (Array.isArray(rule.when)) return { all: rule.when, any: [] };
  return { all: rule.when?.all || [], any: rule.when?.any || [] };
}

/** 工作记忆上的前向链。每条规则在一次推导中最多触发一次；新增事实可触发后续轮次。 */
export function forwardChain(initialFacts = {}, rules = [], options = {}) {
  const facts = clone(initialFacts);
  const ordered = [...rules].filter(r => r.enabled !== false).sort((a, b) => (b.priority || 0) - (a.priority || 0) || cmp(a.id, b.id));
  const fired = new Set(), trace = [], warnings = [], requiredPreparations = new Set();
  const excludedScenes = new Set(), excludedActivities = new Set();
  const scenePreferences = {}, activityPreferences = {};
  const maxRounds = options.maxRounds ?? Math.max(2, ordered.length + 1);
  let rounds = 0, changed = true;
  while (changed && rounds < maxRounds) {
    rounds++; changed = false;
    for (const rule of ordered) {
      if (fired.has(rule.id)) continue;
      const { all, any } = conditions(rule);
      const match = condition => compare(getFact(facts, condition.fact), condition.op, condition.value);
      if (!all.every(match) || (any.length && !any.some(match))) continue;
      fired.add(rule.id);
      const outputFacts = [];
      for (const action of rule.then || []) {
        const type = action.action || action.type;
        const sceneId = action.sceneId || action.targetSceneId || action.target || getFact(facts, 'scene.id');
        const activityId = action.activityId || action.targetActivityId || action.target || getFact(facts, 'activity.id');
        const amount = Number(action.amount ?? action.weight ?? action.value ?? 10);
        let key, value;
        if (type === 'set_fact') { key = action.fact; value = action.value; }
        else if (type === 'exclude_scene' && sceneId) { excludedScenes.add(sceneId); key = `derived.excludedScene.${sceneId}`; value = true; }
        else if (type === 'exclude_activity' && activityId) { excludedActivities.add(activityId); key = `derived.excludedActivity.${activityId}`; value = true; }
        else if (type === 'prefer_scene' && sceneId) { scenePreferences[sceneId] = (scenePreferences[sceneId] || 0) + (Number.isFinite(amount) ? amount : 0); key = `derived.preferScene.${sceneId}`; value = scenePreferences[sceneId]; }
        else if (type === 'prefer_activity' && activityId) { activityPreferences[activityId] = (activityPreferences[activityId] || 0) + (Number.isFinite(amount) ? amount : 0); key = `derived.preferActivity.${activityId}`; value = activityPreferences[activityId]; }
        else if (type === 'require_preparation') {
          const ids = action.preparationIds || [action.preparationId || action.id || action.value].filter(Boolean);
          for (const id of ids) requiredPreparations.add(id);
          key = `derived.preparation.${rule.id}`; value = ids;
        } else if (type === 'add_warning') { const message = action.message || action.warning || action.value || rule.title || rule.id; warnings.push(message); key = `derived.warning.${rule.id}`; value = message; }
        if (key) {
          if (getFact(facts, key) === undefined || canonical(getFact(facts, key)) !== canonical(value)) { facts[key] = value === undefined ? null : clone(value); changed = true; }
          outputFacts.push({ id: key, value });
        }
      }
      const used = [...all, ...any.filter(match)];
      trace.push({ ruleId: rule.id, rule: rule.id, message: rule.title || rule.id, bindings: { sceneId: getFact(facts, 'scene.id'), activityId: getFact(facts, 'activity.id') }, inputFacts: used.map(c => ({ id: c.fact, value: getFact(facts, c.fact) })), outputFacts, evidenceIds: rule.evidenceIds || rule.evidence || [], evidence: rule.evidenceIds || rule.evidence || [], assertionKind: rule.assertionKind || 'designed', strength: rule.strength || 'soft', round: rounds });
    }
  }
  return { facts, trace, rounds, saturated: !changed, excludedSceneIds: [...excludedScenes].sort(cmp), excludedActivityIds: [...excludedActivities].sort(cmp), scenePreferences, activityPreferences, requiredPreparations: [...requiredPreparations].sort(cmp), warnings: [...new Set(warnings)] };
}

/** 无重复节点的有向路径；严格限制深度与返回数量，避免图环和组合爆炸。 */
export function queryGraph(graph, startId, endId, { maxDepth = 4, maxPaths = 24 } = {}) {
  const edges = [...(graph?.edges || [])].map((e, i) => ({ ...e, id: e.id || `edge-${i}`, subject: e.subject ?? e.from, object: e.object ?? e.to })).sort((a, b) => cmp(a.id, b.id));
  const adjacency = new Map();
  for (const edge of edges) { if (!adjacency.has(edge.subject)) adjacency.set(edge.subject, []); adjacency.get(edge.subject).push(edge); }
  const queue = [{ nodes: [startId], edges: [] }], paths = [];
  let cursor = 0;
  while (cursor < queue.length && paths.length < maxPaths && cursor < 4096) {
    const path = queue[cursor++], tail = path.nodes.at(-1);
    if (tail === endId && path.edges.length) { paths.push({ ...path, evidenceIds: [...new Set(path.edges.flatMap(e => e.evidenceIds || e.evidence || []))].sort(cmp) }); continue; }
    if (path.edges.length >= maxDepth) continue;
    for (const edge of adjacency.get(tail) || []) if (!path.nodes.includes(edge.object)) queue.push({ nodes: [...path.nodes, edge.object], edges: [...path.edges, edge] });
  }
  return paths;
}

export function buildKnowledgeGraph(catalog) {
  const supplied = catalog.graph || { nodes: [], edges: [] };
  const nodes = new Map((supplied.nodes || []).map(n => [n.id, { ...n }]));
  const edges = new Map((supplied.edges || []).map((e, i) => [e.id || `supplied-${i}`, { ...e, id: e.id || `supplied-${i}` }]));
  const add = (subject, predicate, object, evidenceIds = []) => {
    const id = `${subject}|${predicate}|${object}`;
    if (!nodes.has(subject)) nodes.set(subject, { id: subject });
    if (!nodes.has(object)) nodes.set(object, { id: object });
    if (!edges.has(id)) edges.set(id, { id, subject, predicate, object, evidenceIds, assertionKind: 'designed' });
  };
  for (const scene of catalog.scenes || []) {
    for (const tag of scene.tags || []) { add(scene.id, '具有体验属性', `tag:${tag}`, scene.evidenceIds || scene.source || []); add(`tag:${tag}`, '匹配明示偏好', `preference:${tag}`); }
    for (const activity of scene.activities || []) {
      add(scene.id, '支持活动', activity.id, activity.evidenceIds || activity.source || []);
      for (const tag of activity.tags || []) { add(activity.id, '具有体验属性', `tag:${tag}`, activity.evidenceIds || []); add(`tag:${tag}`, '匹配明示偏好', `preference:${tag}`); }
      for (const prep of activity.preparationIds || []) add(activity.id, '需要准备', `preparation:${prep}`, activity.evidenceIds || []);
    }
  }
  return { nodes: [...nodes.values()].sort((a, b) => cmp(a.id, b.id)), edges: [...edges.values()].sort((a, b) => cmp(a.id, b.id)) };
}

export const DEFAULT_RULES = [
  { id: 'CORE_WET_RISK', title: '雨天与无掩蔽室外场景组合产生淋雨风险', priority: 100, strength: 'hard', when: { all: [{ fact: 'context.weather', op: 'eq', value: 'rain' }, { fact: 'scene.indoor', op: 'eq', value: false }], any: [{ fact: 'scene.sheltered', op: 'exists', value: false }, { fact: 'scene.sheltered', op: 'neq', value: true }] }, then: [{ action: 'set_fact', fact: 'derived.wetRisk', value: true }], assertionKind: 'designed' },
  { id: 'CORE_EXCLUDE_WET', title: '根据已推导的淋雨风险排除当前场景', priority: 110, strength: 'hard', when: { all: [{ fact: 'derived.wetRisk', op: 'eq', value: true }] }, then: [{ action: 'exclude_scene' }], assertionKind: 'designed' },
  { id: 'CORE_HIGH_LOAD', title: '累计预计负担较高，推导恢复需求', priority: 50, strength: 'soft', when: { all: [{ fact: 'state.maxLoad', op: 'gte', value: 6 }] }, then: [{ action: 'set_fact', fact: 'derived.recoveryNeeded', value: true }], assertionKind: 'designed' },
  { id: 'CORE_REST_PRIORITY', title: '恢复需求提高独立休息场景的相对效用', priority: 60, strength: 'soft', when: { all: [{ fact: 'derived.recoveryNeeded', op: 'eq', value: true }, { fact: 'scene.kind', op: 'eq', value: 'rest' }] }, then: [{ action: 'prefer_scene', amount: 18 }], evidenceIds: ['G003', 'G004'], assertionKind: 'designed' },
];
