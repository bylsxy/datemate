/** 探索改变搜索和展露顺序，并控制露营门槛；真实效用与硬约束由引擎计算。 */
export const EXPLORATION_VERSION = 'seeded-exploration-1.4';
export const CAMPING_EXPLORATION_MIN = 80;

// 精确匹配露营标识，避免把 campus 等普通校园场景误归为露营。
const CAMPING_SCENE_IDS = new Set(['camp_day_setup', 'camp_evening']);
export function isSceneAllowedAtExploration(scene, exploration = 0) {
  if (!scene) return false;
  const level = Number(exploration);
  const configured = scene.minimumExploration === undefined ? 0 : scene.minimumExploration;
  if (!Number.isInteger(configured) || configured < 0 || configured > 100) return false;
  if (scene.dreamOnly === true && level !== 100) return false;
  const minimum = Math.max(configured, CAMPING_SCENE_IDS.has(scene.id) ? CAMPING_EXPLORATION_MIN : 0);
  return level >= minimum;
}

export function isDepartureAllowedAtExploration(departure, exploration = 0) {
  return departure?.id !== 'camping' || Number(exploration) >= CAMPING_EXPLORATION_MIN;
}

export function normalizeExplorationSeed(seed) {
  if (seed === undefined || seed === null) return null;
  if (typeof seed !== 'string' && !(typeof seed === 'number' && Number.isFinite(seed))) {
    throw Error('H_EXPLORATION_SEED:探索种子必须为字符串或有限数值。');
  }
  return String(seed);
}

// 按用途与完整路径寻址，不依赖调用次数、时间或 Math.random，分片与同步结果一致。
function unitHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

export function createExploration(exploration, seed) {
  const strength = (Math.max(0, Math.min(100, exploration)) / 100) ** 2;
  const noise = (scope, key) => (2 * unitHash(JSON.stringify([seed, scope, key])) - 1) * strength;
  function select(ordered, limit, { key, value, bucket = key, scope, temperature = 60, elite = 0.25, reorder = false } = {}) {
    if (!ordered.length || limit <= 0) return [];
    if (!strength || !reorder && ordered.length <= limit) return ordered.slice(0, limit);
    limit = Math.min(limit, ordered.length);
    // 保留择优槽位，剩余槽位在不同场景间轮转；重复仍合法，不作硬禁止。
    const keep = Math.min(limit, Math.max(1, Math.ceil(limit * (1 - strength * (1 - elite)))));
    const selected = [ordered[0]], retained = new Set(selected);
    const counts = new Map([[bucket(ordered[0]), 1]]);
    // 择优槽也软减同地点的组合重复，避免活动排列独占有限束宽；最高真实效用仍保留。
    while (selected.length < keep) {
      let chosen, bestRank = -Infinity;
      for (const item of ordered) if (!retained.has(item)) {
        const rank = value(item) - temperature * strength * (counts.get(bucket(item)) || 0);
        if (rank > bestRank) { chosen = item; bestRank = rank; }
      }
      selected.push(chosen); retained.add(chosen);
      counts.set(bucket(chosen), (counts.get(bucket(chosen)) || 0) + 1);
    }
    const ranked = ordered.filter(item => !retained.has(item)).map((item, index) => ({ item, index, rank: value(item) + temperature * noise(scope, key(item)) }))
      .sort((a, b) => b.rank - a.rank || a.index - b.index);
    const groups = new Map();
    for (const { item } of ranked) {
      const id = bucket(item);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(item);
    }
    // 已占优的场景优先让出一轮，以覆盖被同场景活动组合挤掉的分支。
    const occupied = new Set(selected.map(bucket));
    const buckets = [...groups.entries()].sort((a, b) => Number(occupied.has(a[0])) - Number(occupied.has(b[0]))).map(([, items]) => items);
    for (let rank = 0; selected.length < limit; rank++) {
      let added = false;
      for (const items of buckets) if (items[rank] && selected.length < limit && !retained.has(items[rank])) {
        selected.push(items[rank]); retained.add(items[rank]); added = true;
      }
      if (!added) break;
    }
    return selected;
  }
  function display(ordered, limit, { key, confirmed, scope, dream = () => false }) {
    if (!strength) return ordered.slice(0, limit);
    // 展示采用共同的归一化序位，不直接混比完整 q 与局部效用。
    // 高探索仅保留一个已验证推荐位置，其余位置允许 pending 与已评候选混合。
    const reservedCount = Math.min(limit, strength >= 0.64 ? 1 : 2);
    const reserved = ordered.filter(confirmed).slice(0, reservedCount), retained = new Set(reserved);
    const denominator = Math.max(1, ordered.length - 1);
    const ranked = ordered.map((item, index) => ({
      item, index,
      rank: (1 - 0.95 * strength) * (1 - index / denominator) + 0.95 * (noise(scope, key(item)) + strength) / 2 + (exploration === 100 && dream(item) ? 0.6 : 0),
    })).filter(entry => !retained.has(entry.item)).sort((a, b) => b.rank - a.rank || a.index - b.index);
    return [...reserved, ...ranked.slice(0, Math.max(0, limit - reserved.length)).map(entry => entry.item)];
  }
  function choose(ordered, { key, value, scope }) {
    const highest = ordered[0], top = value(highest);
    const maxGap = strength * Math.max(50, Math.abs(top) * 0.24);
    let selected = highest, selectedNoise = maxGap * noise(scope, key(highest));
    let rank = top + selectedNoise;
    for (const item of ordered.slice(1)) {
      const utility = value(item);
      if (top - utility > maxGap) break;
      const perturbation = maxGap * noise(scope, key(item));
      if (utility + perturbation > rank) { selected = item; rank = utility + perturbation; selectedNoise = perturbation; }
    }
    return { selected, searchNoise: selectedNoise, bestDiscoveredObjective: top, utilityGap: top - value(selected), maxUtilityGap: maxGap };
  }
  return { strength, noise, select, display, choose };
}
