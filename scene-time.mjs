import { normalizePeriods } from './time-periods.mjs?v=70d76ccc0868cf19';

const DAY = 1440;

// 相邻区间表示连续开放，包括分段表达的午夜两侧。
function mergeWindows(windows) {
  const merged = [];
  for (const w of windows.sort((a, b) => a.startMinute - b.startMinute)) {
    const last = merged.at(-1);
    if (last && w.startMinute <= last.endMinute) last.endMinute = Math.max(last.endMinute, w.endMinute);
    else merged.push({ ...w });
  }
  return merged;
}

export function validateDailyWindows(scene) {
  if (scene.dailyWindows === undefined) return;
  if (!Array.isArray(scene.dailyWindows) || !scene.dailyWindows.length || scene.dailyWindows.some(w => !w || !Number.isInteger(w.startMinute) || !Number.isInteger(w.endMinute) || w.startMinute < 0 || w.startMinute >= DAY || w.endMinute < 0 || w.endMinute > DAY || w.startMinute === w.endMinute)) {
    throw Error(`H_DATA:场景${scene.id}的每日开放时间需为有效时钟分钟区间。`);
  }
}

export function sceneDailyWindows(scene, start, end) {
  validateDailyWindows(scene);
  if (scene.dailyWindows === undefined) return [{ startMinute: start, endMinute: end }];
  const daily = [];
  for (let day = Math.floor(start / DAY) - 1; day <= Math.floor(end / DAY); day++) {
    for (const w of scene.dailyWindows) daily.push({ startMinute: day * DAY + w.startMinute, endMinute: day * DAY + w.endMinute + (w.startMinute > w.endMinute ? DAY : 0) });
  }
  return mergeWindows(daily).map(w => ({ startMinute: Math.max(start, w.startMinute), endMinute: Math.min(end, w.endMinute) })).filter(w => w.endMinute > w.startMinute);
}

export function isSceneOpenDuring(scene, start, end) {
  if (scene.dailyWindows === undefined) return true;
  return end > start && sceneDailyWindows(scene, start, end).some(w => w.startMinute <= start && w.endMinute >= end);
}

export function sceneOpenWindows(scene, window, clockMode) {
  const absolute = scene.windows || scene.openWindows;
  const base = Array.isArray(absolute) && absolute.length ? absolute.map(w => ({ startMinute: w.startMinute ?? w.start, endMinute: w.endMinute ?? w.end })) : [window];
  // 合成测试的相对分钟没有实际时钟语义，仍保留绝对预约窗校验。
  if (!clockMode || scene.dailyWindows === undefined) return mergeWindows(base);
  const continuous = sceneDailyWindows(scene, window.startMinute, window.endMinute);
  return mergeWindows(base.flatMap(a => continuous.map(b => ({ startMinute: Math.max(a.startMinute, b.startMinute), endMinute: Math.min(a.endMinute, b.endMinute) })).filter(w => w.endMinute > w.startMinute)));
}

export function sceneStayMinutes(scene, start, mealRole, clockMode) {
  return sceneDurationAt(scene, start, { mealRole, clockMode });
}

export function sceneDurationAt(scene, start, { mealRole = null, clockMode = true } = {}) {
  const raw = scene.minutes ?? scene.baseline?.duration;
  const minutes = Array.isArray(raw) ? raw[1] ?? raw[0] : typeof raw === 'object' && raw !== null ? raw.high ?? raw.low : raw;
  if (!clockMode) return minutes;
  const end = start + minutes;
  let evening = false;
  for (let day = Math.floor(start / DAY) - 1; day <= Math.floor(end / DAY); day++) {
    if (start < day * DAY + DAY + 360 && end > day * DAY + 1140) { evening = true; break; }
  }
  if (!evening) return minutes;
  if (mealRole === 'supper') return Math.max(minutes, 30);
  if (mealRole || ['meal', 'rest'].includes(scene.kind ?? scene.typeId)) return minutes;
  return Math.max(minutes, 60);
}

// 这里只判断营业区间能否容纳阶段，完整资源、转场及前后依赖仍由引擎校验。
export function isSceneAvailableInContext(scene, context = {}) {
  if (!context.periodIds?.length) return true;
  const periods = normalizePeriods(context.periodIds, context.mealChoices);
  const meals = context.mealRequirements ?? periods.mealRequirements;
  const roles = scene.mealRoles ?? [];
  const slots = (scene.kind ?? scene.typeId) === 'meal'
    ? meals.filter(m => m.choiceMode === 'together' && roles.includes(m.mealRole)).map(m => ({ startMinute: Math.max(m.startMinute, m.targetMinute), endMinute: m.endMinute, mealRole: m.mealRole }))
    : periods.windows;
  return slots.some(slot => sceneOpenWindows(scene, slot, true).some(w => {
    const start = Math.max(slot.startMinute, w.startMinute);
    const minimumScene=scene.durationRange?{...scene,minutes:scene.durationRange[0]}:scene;
    return start + sceneDurationAt(minimumScene, start, { mealRole: slot.mealRole }) <= Math.min(slot.endMinute, w.endMinute);
  }));
}
