// 全天采用同一起点的绝对分钟；夜晚可超过1440，显示归一由界面负责。
export const TIME_PERIODS = Object.freeze([
  Object.freeze({ id: 'morning', label: '上午', startMinute: 450, endMinute: 720 }),
  Object.freeze({ id: 'afternoon', label: '下午', startMinute: 840, endMinute: 1080 }),
  Object.freeze({ id: 'evening', label: '晚上', startMinute: 1140, endMinute: 1380 }),
  Object.freeze({ id: 'night', label: '夜晚', startMinute: 1380, endMinute: 1560 }),
]);
const ROLES = ['breakfast', 'lunch', 'dinner', 'supper'];
const fail = (code, message) => { throw Error(`${code}:${message}`); };

export function normalizePeriodIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => !TIME_PERIODS.some(p => p.id === id))) fail('H_PERIODS', '请选择有效的约会时段。');
  const selected = TIME_PERIODS.filter(p => ids.includes(p.id));
  const indexes = selected.map(p => TIME_PERIODS.indexOf(p));
  if (indexes.at(-1) - indexes[0] + 1 !== indexes.length) fail('H_PERIOD_CONTIGUITY', '只能整段规划，请选择连续时段（例如上午和下午）。');
  return selected.map(p => p.id);
}

export function getMealRequirements(periodIds, mealChoices = {}) {
  const ids = normalizePeriodIds(periodIds);
  if (!mealChoices || typeof mealChoices !== 'object' || Array.isArray(mealChoices) || Object.keys(mealChoices).some(role => !ROLES.includes(role))) fail('H_MEAL_CHOICE', '用餐选择需按早餐、午餐、晚餐和宵夜提供。');
  const choices = {};
  for (const [role, value] of Object.entries(mealChoices)) {
    const choice = typeof value === 'string' ? { mode: value } : value;
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) fail('H_MEAL_CHOICE', '用餐选择格式无效。');
    const mode = choice.mode ?? 'together';
    if (mode !== 'together' && !(role === 'breakfast' && mode === 'before_meeting') && !(role === 'supper' && mode === 'skip')) fail('H_MEAL_CHOICE', '只有早餐可会面前吃，只有宵夜可不吃；午餐和晚餐必须安排。');
    if (mode !== 'together' && (choice.sceneId !== undefined || choice.activityIds !== undefined)) fail('H_MEAL_CHOICE', '会面前吃或不吃不能同时固定用餐场景。');
    if (choice.sceneId !== undefined && (typeof choice.sceneId !== 'string' || !choice.sceneId)) fail('H_MEAL_CHOICE', '固定餐馆需使用有效场景ID。');
    if (choice.activityIds !== undefined && (!Array.isArray(choice.activityIds) || choice.activityIds.some(id => typeof id !== 'string'))) fail('H_MEAL_CHOICE', '用餐活动需使用活动ID数组。');
    choices[role] = { ...choice, mode };
  }
  const definitions = [
    { mealRole: 'breakfast', label: '早餐', applies: ids.includes('morning'), targetMinute: 450, startMinute: 450, endMinute: 660 },
    { mealRole: 'lunch', label: '午餐', applies: ids.includes('morning') && ids.includes('afternoon'), targetMinute: 720, startMinute: 690, endMinute: 870 },
    { mealRole: 'dinner', label: '晚餐', applies: ids.includes('afternoon') && ids.includes('evening'), targetMinute: 1080, startMinute: 1050, endMinute: 1200 },
    { mealRole: 'supper', label: '宵夜', applies: ids.includes('evening') && ids.includes('night'), targetMinute: 1380, startMinute: 1350, endMinute: 1470 },
  ];
  return definitions.filter(m => m.applies).map(({ applies, ...m }) => {
    const choice = choices[m.mealRole] || { mode: 'together' };
    return { ...m, id: m.mealRole, required: m.mealRole !== 'supper', choiceMode: choice.mode, mode: choice.mode, sceneId: choice.sceneId ?? null, activityIds: choice.activityIds ? [...new Set(choice.activityIds)].sort() : null, stageIndex: null, insertIndex: 0, satisfied: choice.mode !== 'together', candidates: [] };
  });
}

export function normalizePeriods(periodIds, mealChoices = {}) {
  const ids = normalizePeriodIds(periodIds);
  const startMinute = TIME_PERIODS.find(p => p.id === ids[0]).startMinute;
  const endMinute = TIME_PERIODS.find(p => p.id === ids.at(-1)).endMinute;
  return { periodIds: ids, windows: [{ id: 'period-span', startMinute, endMinute }], duration: endMinute - startMinute, startMinute, endMinute, mealRequirements: getMealRequirements(ids, mealChoices) };
}

export const resolvePeriodSelection = normalizePeriods;
