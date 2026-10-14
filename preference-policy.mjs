const choices = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
const themes = ['chinese', 'japanese', 'romantic', 'fresh'];
const mbti = value => typeof value === 'string' && /^[EI][NS][FT][JP]$/i.test(value) ? value.toUpperCase() : '';

export function normalizePreferences(raw) {
  return {
    weather: choices(raw.weather, ['clear', 'cloudy', 'rain'], 'cloudy'),
    weekPart: choices(raw.weekPart, ['weekday', 'weekend'], 'weekday'),
    relationship: choices(raw.relationship, ['any', 'first', 'flirting', 'passionate', 'stable', 'longterm'], 'any'),
    reunion: raw.reunion === true,
    cyclePhase: choices(raw.cyclePhase, ['none', 'before', 'during', 'after'], 'none'),
    mood: choices(raw.mood, ['normal', 'happy', 'low'], 'normal'),
    energy: choices(raw.energy === 'low' ? 'tired' : raw.energy, ['normal', 'tired', 'tense', 'relax'], Math.max(Number(raw.fatigueA) || 0, Number(raw.fatigueB) || 0) >= 6 ? 'tired' : 'normal'),
    season: choices(raw.season, ['ordinary', 'holiday', 'exam'], 'ordinary'),
    mentalDemand: choices(raw.mentalDemand, ['any', 'low', 'medium', 'high'], raw.mentalLow === true ? 'low' : 'any'),
    occasion: choices(raw.occasion, ['daily', 'birthday', 'anniversary', 'confession'], 'daily'),
    personalityA: mbti(raw.personalityA), personalityB: mbti(raw.personalityB),
    planStyle: choices(raw.planStyle, ['flexible', 'steady'], 'flexible'),
    themes: [...new Set((Array.isArray(raw.themes) ? raw.themes : []).filter(t => themes.includes(t)))].sort(),
  };
}

export function preferencePolicy(ctx, scene, place, tags, graphMatches, exploration, activities = []) {
  const contributions = {}, trace = [], warnings = [];
  const factKeys = {
    SOFT_RAIN: ['weather'], SOFT_WEATHER_MATCH: ['weather'], SOFT_QUIET: ['quietRequired'], SOFT_CROWD: ['crowdAvoidance'],
    SOFT_QUEUE: ['weekPart'], SOFT_INDOOR: ['preferences'], SOFT_MENTAL: ['mentalDemand'], SOFT_RECOVERY: ['energy', 'mood', 'season'],
    SOFT_CYCLE_COMFORT: ['cyclePhase'], SOFT_FIRST_MEETING: ['relationship'], SOFT_RELATIONSHIP: ['relationship', 'reunion'],
    SOFT_HOBBY_EXCHANGE: ['mood', 'preferencesA', 'preferencesB'], SOFT_OCCASION: ['occasion'], SOFT_HOLIDAY: ['season'],
    SOFT_THEMES: ['themes'], SOFT_PERSONALITY: ['personalityA', 'personalityB'], SOFT_STEADY: ['planStyle'],
  };
  const add = (id, amount, message, inputs = []) => {
    if (!amount) return;
    contributions[id] = amount;
    trace.push({ ruleId: id, rule: id, message, strength: 'soft', assertionKind: 'designed', inputFacts: [...(factKeys[id] || []).map(key => ({ id: `context.${key}`, value: ctx[key] })), { id: 'scene.id', value: scene.id }, ...inputs], outputFacts: [{ id: `feature.${id}`, value: amount }], evidenceIds: [] });
  };
  const lowLoad = scene.load <= 1, seated = place.seated === true || place.seating === true || tags.includes('seated') || place.indoor === true && ['meal', 'cafe', 'cinema'].includes(scene.kind);
  const mental = Number(scene.mental ?? scene.mentalDemand ?? 0) || 0;
  // 所选玩法可以改变同一地点的社交性；未选拼桌活动不会增加双人玩法的负担。
  const social = Math.max(scene.socialDemand ?? 1, ...activities.map(a => a.socialDemand ?? 0));
  if (ctx.weather === 'rain') add('SOFT_RAIN', place.indoor || place.sheltered ? 8 : -12, '雨天优先有遮蔽的体验，露天候选仍可选择');
  if (ctx.weather === 'clear' && place.indoor === false) warnings.push('晴天户外记得防晒、补水。');
  if (ctx.weather !== 'cloudy' && place.weather?.length && !place.weather.includes(ctx.weather)) add('SOFT_WEATHER_MATCH', -6, '天气适配作为排序参考');
  if (ctx.quietRequired) add('SOFT_QUIET', place.quiet === true ? 10 : place.quiet === false ? -10 : -3, '安静偏好影响排序');
  if (ctx.crowdAvoidance) add('SOFT_CROWD', place.uncrowded === true ? 10 : place.crowded || place.crowdRisk === 'high' ? -10 : 0, '人少偏好影响排序');
  if (ctx.preferences.includes('indoor')) add('SOFT_INDOOR', place.indoor ? 6 : -6, '室内偏好影响排序');
  if (ctx.mentalDemand !== 'any') {
    const target = { low: 1, medium: 3, high: 5 }[ctx.mentalDemand];
    add('SOFT_MENTAL', 5 - Math.min(12, Math.abs(mental - target) * 3), '认知投入偏好影响排序');
  }
  if (['tired', 'tense', 'relax'].includes(ctx.energy) || ctx.mood === 'low') add('SOFT_RECOVERY', (lowLoad ? 7 : -6) + (seated ? 3 : 0), '当前状态温和偏向轻负荷与可坐下的安排');
  if (['before', 'during'].includes(ctx.cyclePhase)) add('SOFT_CYCLE_COMFORT', (lowLoad ? 5 : -3) + (seated ? 3 : 0) + (scene.kind === 'meal' ? 3 : 0), '经前与经期仅参考舒适度、坐下和正餐，不推断饮食禁忌或意愿');
  if (ctx.relationship === 'first') add('SOFT_FIRST_MEETING', social <= 1 ? 4 : -3, '初次约会温和偏向容易交谈的体验');
  if (['flirting', 'passionate', 'stable', 'longterm'].includes(ctx.relationship)) add('SOFT_RELATIONSHIP', tags.includes('romantic') || tags.includes('shared_hobby') ? 4 : 0, '关系阶段仅提供温和的共同体验参考');
  if (ctx.mood === 'happy') {
    const matches = [...ctx.preferencesA, ...ctx.preferencesB].filter(t => graphMatches.has(t) || tags.includes(t));
    add('SOFT_HOBBY_EXCHANGE', Math.min(12, matches.length * 4) + (tags.includes('shared_hobby') ? 5 : 0), '开心时鼓励体验一方兴趣或交换爱好');
  }
  if (ctx.occasion !== 'daily') add('SOFT_OCCASION', tags.includes(ctx.occasion === 'confession' ? 'confession' : 'celebration') ? 8 : 0, '纪念场合与明确主题匹配');
  if (ctx.season === 'holiday') add('SOFT_HOLIDAY', tags.includes('travel') || tags.includes('celebration') ? 5 : 0, '假期温和鼓励旅行和庆祝体验');
  add('SOFT_THEMES', ctx.themes.filter(t => tags.includes(t)).length * 6, '明示主题匹配');
  const personalities = [ctx.personalityA, ctx.personalityB].filter(Boolean);
  add('SOFT_PERSONALITY', personalities.reduce((sum, p) => sum
    + (p[0] === 'I' && social <= 1 || p[0] === 'E' && social >= 2 ? 0.5 : 0)
    + (p[1] === 'N' && tags.includes('fresh') || p[1] === 'S' && tags.some(t => ['food', 'craft', 'outdoor'].includes(t)) ? 0.5 : 0)
    + (p[2] === 'T' && mental >= 3 || p[2] === 'F' && tags.some(t => ['romantic', 'music', 'art'].includes(t)) ? 0.5 : 0)
    + (p[3] === 'J' && scene.reliable === true || p[3] === 'P' && tags.includes('fresh') ? 0.5 : 0), 0), 'MBTI四组维度均为对称低权重启发式，不判定兼容性或意愿');
  if (ctx.planStyle === 'steady') add('SOFT_STEADY', scene.reliable === false ? -5 : 3, '稳妥安排偏好影响排序');
  if (exploration === 100) add('SOFT_DREAM', scene.dreamOnly || tags.includes('dream') ? 55 : tags.includes('travel') ? 12 : 0, '梦幻模式提高梦幻体验排序，硬约束仍然生效', [{ id: 'exploration', value: exploration }]);
  return { score: Object.values(contributions).reduce((sum, n) => sum + n, 0), contributions, trace, warnings };
}
