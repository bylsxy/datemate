import { preparationOptions } from './data/activities.mjs?v=70d76ccc0868cf19';

// 这些资源表示行程内已经完成的成果，不能靠默认准备库存满足。
export const INTERNAL_PREPARATION_IDS = Object.freeze([
  'photo_pair', 'breakfast_pack', 'printed_photo', 'shared_sketch', 'handmade_card', 'meal_completed',
]);
const internalIds = new Set(INTERNAL_PREPARATION_IDS);
// picnic_share 明确允许“之前采购或自行准备”；它是既可外备也可途中采购的耗材。
const externallySuppliedOutputs = new Set(['picnic_pack']);
const compareIds = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function inventory(value) {
  if (Array.isArray(value)) return new Map(value.filter(id => typeof id === 'string' && id).map(id => [id, 1]));
  return new Map(Object.entries(value || {}).filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && count > 0));
}

function requirements(item) {
  const result = new Map();
  // 三个字段通常是同一要求的重复表达，取最大数量而非累加。
  for (const field of ['preparationIds', 'requires', 'preconditions', 'consumes']) {
    for (const [id, count] of inventory(item[field])) result.set(id, Math.max(result.get(id) || 0, count));
  }
  return result;
}

function catalogIndex(catalog = {}) {
  const flat = new Map((catalog.activities || []).map(activity => [activity.id, activity]));
  const scenes = new Map((catalog.scenes || []).map(scene => {
    const attached = scene.activities ?? scene.activityIds ?? [];
    const activities = attached.map(value => {
      const id = typeof value === 'string' ? value : value.id;
      const activity = typeof value === 'string' ? flat.get(id) : value;
      if (!activity) throw new Error(`未知活动：${id}`);
      return { ...activity, ...(scene.activityOverrides?.[id] || {}) };
    });
    return [scene.id, { scene, activities }];
  }));
  return { scenes, entities: [...flat.values(), ...[...scenes.values()].flatMap(({ scene, activities }) => [scene, ...activities])] };
}

function externalDefinitions(catalog, index, options = {}) {
  const definitions = options.preparationOptions ?? catalog?.preparationOptions ?? catalog?.metadata?.preparationOptions ?? preparationOptions;
  const produced = new Set(index.entities.flatMap(item => [...inventory(item.provides).keys()]));
  return new Map(definitions.filter(item => item?.id && !internalIds.has(item.id)
    && (!produced.has(item.id) || externallySuppliedOutputs.has(item.id))).map(item => [item.id, item]));
}

/** 元数据准备项白名单，排除内部成果；返回独立、稳定排序的 ID 数组。 */
export function availablePreparationIds(catalog, options = {}) {
  return [...externalDefinitions(catalog, catalogIndex(catalog), options).keys()].sort(compareIds);
}

/**
 * 用于 rawContext.resources 的有限足量库存；同时将其键写入 preparedIds。
 * maxStages 默认 24（engine 的硬上限）。每项数量 = 单阶段最大耗用 × 阶段数 + 最大前置需求。
 * 此上界允许重复场景及全部活动，不依赖搜索结果，也不会预先产生内部成果。
 */
export function availablePreparationResources(catalog, options = {}) {
  const maxStages = options.maxStages ?? 24;
  if (!Number.isSafeInteger(maxStages) || maxStages < 1) throw new RangeError('maxStages 必须为正安全整数。');
  const index = catalogIndex(catalog), definitions = externalDefinitions(catalog, index, options);
  const entries = [...definitions.keys()].sort(compareIds).map(id => {
    const required = Math.max(1, ...index.entities.map(item => requirements(item).get(id) || 0));
    const consumption = Math.max(0, ...[...index.scenes.values()].map(({ scene, activities }) =>
      (inventory(scene.consumes).get(id) || 0) + activities.reduce((sum, activity) => sum + (inventory(activity.consumes).get(id) || 0), 0)));
    const count = required + consumption * maxStages;
    if (!Number.isFinite(count) || count > Number.MAX_SAFE_INTEGER) throw new RangeError(`准备资源数量超出安全范围：${id}`);
    return [id, count];
  });
  return Object.fromEntries(entries);
}

/** 初始化和 readContext 共用的准备上下文；计数库存的键就是 preparedIds 白名单。 */
export function defaultPreparationResources(catalog, options = {}) {
  const resources = availablePreparationResources(catalog, options);
  return { preparedIds: Object.keys(resources), resources };
}

function orderedActivities(selected, completed) {
  const byId = new Map(selected.map(activity => [activity.id, activity]));
  const pending = new Set(byId.keys()), result = [];
  for (const activity of selected) {
    for (const predecessor of activity.predecessorIds || []) {
      if (!byId.has(predecessor) && !completed.has(predecessor)) throw new Error(`H_PREDECESSOR:活动${activity.id}缺少前置活动${predecessor}。`);
    }
  }
  while (pending.size) {
    const ready = [...pending].filter(id => (byId.get(id).predecessorIds || []).every(predecessor => !pending.has(predecessor))).sort(compareIds);
    if (!ready.length) throw new Error('H_PREDECESSOR_CYCLE:活动前置关系存在循环。');
    for (const id of ready) { result.push(byId.get(id)); pending.delete(id); }
  }
  return result;
}

/**
 * 完整所选 stages（{sceneId, activityIds}[]）所需的最小外部初始库存。
 * quantity 是知识库资源单位，stageIndexes 从 0 开始，涵盖所有使用该外部项的阶段。
 * 按 engine 顺序先场景、再依赖排序后的所选活动；只用已经产生的供给抵扣后续需求。
 * 不读取候选项、默认活动、缓存快照或未选活动，不改变输入，不替代 engine 的完整可行性验证。
 */
export function planPreparations(stages, catalog) {
  if (!Array.isArray(stages)) throw new TypeError('stages 必须为完整所选阶段数组。');
  const index = catalogIndex(catalog), definitions = externalDefinitions(catalog, index);
  const balance = new Map(), entries = new Map(), completed = new Set();
  function apply(item, stageIndex) {
    for (const [id, count] of requirements(item)) {
      if (!definitions.has(id)) continue;
      if (!entries.has(id)) entries.set(id, { id, label: definitions.get(id).label || id, quantity: 0, stageIndexes: [] });
      const entry = entries.get(id);
      if (!entry.stageIndexes.includes(stageIndex)) entry.stageIndexes.push(stageIndex);
      const missing = Math.max(0, count - (balance.get(id) || 0));
      entry.quantity += missing;
      balance.set(id, (balance.get(id) || 0) + missing);
    }
    for (const [id, count] of inventory(item.consumes)) balance.set(id, (balance.get(id) || 0) - count);
    for (const [id, count] of inventory(item.provides)) balance.set(id, (balance.get(id) || 0) + count);
  }
  stages.forEach((stage, stageIndex) => {
    const attached = index.scenes.get(stage.sceneId);
    if (!attached) throw new Error(`未知场景：${stage.sceneId}`);
    const selectedIds = [...new Set(stage.activityIds || [])];
    const selected = selectedIds.map(id => {
      const activity = attached.activities.find(item => item.id === id);
      if (!activity) throw new Error(`活动${id}不属于场景${stage.sceneId}。`);
      return activity;
    });
    const ordered = orderedActivities(selected, completed);
    apply(attached.scene, stageIndex);
    for (const activity of ordered) { apply(activity, stageIndex); completed.add(activity.id); }
    completed.add(attached.scene.id);
  });
  return [...entries.values()].filter(entry => entry.quantity > 0).sort((a, b) => compareIds(a.id, b.id));
}
