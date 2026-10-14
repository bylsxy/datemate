// 时长是可调整的停留区间；自动推荐尽量连续待着，明确选择的分钟数则保持不变。
export function durationBounds(scene) {
  const base = Array.isArray(scene.minutes) ? scene.minutes[1] : scene.minutes;
  const range = scene.durationRange ?? [base, Math.max(base, 60)];
  if (!Array.isArray(range) || range.length !== 2 || range.some(n => !Number.isInteger(n) || n <= 0) || range[1] < range[0] || base < range[0] || base > range[1]) {
    throw Error(`H_DURATION:场景${scene.id ?? ''}的停留时长区间无效。`);
  }
  return {min:range[0], max:range[1], preferred:base, flexible:range[0] !== range[1]};
}

export function chooseStayDuration(scene, {available, requested, automaticMinimum, relaxed, mealRole, short = false}) {
  const bounds = durationBounds(scene);
  if (requested !== undefined) {
    if (!Number.isInteger(requested) || requested < bounds.min || requested > bounds.max) throw Error('H_DURATION:所选时长超出这个场景允许的范围。');
    return requested <= available ? requested : null;
  }
  const minimum = Math.max(bounds.min, automaticMinimum ?? bounds.min);
  if (available < minimum || bounds.max < minimum) return null;
  // 用餐与小休按合适时长安排，普通停留尽量用好这段空闲，减少为了填满时间而换地方。
  if (relaxed && bounds.flexible && !mealRole && !['meal','rest'].includes(scene.kind) && !short) return Math.min(bounds.max, Math.max(minimum, Math.floor(available / 5) * 5));
  return Math.min(available, bounds.max, Math.max(minimum, short ? bounds.min : bounds.preferred));
}

export function splitDuration(scene, minutes) {
  const {min,max} = durationBounds(scene);
  const first = Math.floor(minutes / 10) * 5, second = minutes - first;
  return first >= min && second >= min && first <= max && second <= max ? [first,second] : null;
}

// 合并保留前一地点及活动，累加停留时间；取消的转场不再占用时间。
export function mergeStayOption(scene, first, following) {
  if (!first || !following || ['meal','rest'].includes(scene.kind) ||
      [first,following].some(stage => stage.mealRole || stage.virtualMeal || stage.departure || stage.anchorId !== undefined) ||
      Number.isFinite(following.fixedStartMinute)) return null;
  if (![first.minutes,following.minutes].every(minutes => Number.isInteger(minutes) && minutes > 0)) return null;
  const minutes = first.minutes + following.minutes, {min,max} = durationBounds(scene);
  return {minutes, error:minutes < min || minutes > max ? `合并后为 ${minutes} 分钟，超出这个场景允许的 ${min}–${max} 分钟。` : null};
}
