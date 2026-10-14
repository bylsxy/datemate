/** 探索只改变搜索和展露顺序；真实效用与硬约束仍由引擎计算。 */
export const EXPLORATION_VERSION = 'seeded-exploration-1.0';

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
  function select(ordered, limit, { key, value, bucket = key, scope, temperature = 60, elite = 0.25 } = {}) {
    if (!strength || ordered.length <= limit) return ordered.slice(0, limit);
    // 保留择优槽位，剩余槽位在不同场景间轮转；重复仍合法，不作硬禁止。
    const keep = Math.min(limit, Math.max(1, Math.ceil(limit * (1 - strength * (1 - elite)))));
    const selected = ordered.slice(0, keep), retained = new Set(selected);
    const ranked = ordered.slice(keep).map((item, index) => ({ item, index, rank: value(item) + temperature * noise(scope, key(item)) }))
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
  return { strength, noise, select, choose };
}
