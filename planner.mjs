import { activities } from "./data/activities.mjs";

const windows = {
  morning: { label: "上午", start: 9 * 60, end: 12 * 60 },
  afternoon: { label: "下午", start: 14 * 60, end: 18 * 60 },
  evening: { label: "晚上", start: 18 * 60, end: 21 * 60 },
};

// 产生式规则将输入事实推导为筛选条件；记录来自实际执行。
const rules = [
  { id: "R01", when: f => f.environment.includes("室内") || f.weather === "rain", then: c => { c.indoor = true; }, text: "选择室内或预计下雨 → 筛选室内活动。" },
  { id: "R02", when: f => f.energy.includes("疲惫"), then: c => { c.lowEnergy = true; }, text: "当前疲惫 → 筛选低体力活动。" },
  { id: "R03", when: f => f.environment.includes("安静"), then: c => { c.quiet = true; }, text: "偏好安静 → 筛选标记为安静的活动。" },
  { id: "R04", when: f => f.environment.includes("人少"), then: c => { c.uncrowded = true; }, text: "偏好人少 → 筛选标记为人少的活动。" },
  { id: "R05", when: f => f.scope === "campus", then: c => { c.campus = true; }, text: "活动范围仅校内 → 排除周边活动。" },
  { id: "R06", when: f => f.diet.length > 0, then: c => { c.diet = true; }, text: "填写忌口 → 排除带有相应餐饮标签的活动。" },
  { id: "R07", when: f => f.culture === "light", then: c => { c.lightCulture = true; }, text: "文化体力选择轻松 → 筛选轻松类活动。" },
];

export function normalizeFacts(input = {}) {
  const facts = { environment: [], planning: [], diet: [], behavior: [], themes: [], energy: [], mood: [], period: [], slots: [], excluded: "", scope: "nearby", budgetMode: "none", budget: "", weather: "any", culture: "any", interaction: "any", randomness: 0, ...input };
  for (const key of ["environment", "planning", "diet", "behavior", "themes", "energy", "mood", "period", "slots"]) {
    facts[key] = Array.isArray(facts[key]) ? facts[key] : [];
  }
  facts.limit = Infinity;
  if (facts.budgetMode === "saving") facts.limit = 50;
  if (facts.budgetMode === "limited") {
    const validType = typeof facts.budget === "string" || typeof facts.budget === "number";
    if (!validType || String(facts.budget).trim() === "" || !Number.isFinite(Number(facts.budget)) || Number(facts.budget) < 0) {
      throw new Error("请填写有效的预算上限（0 或更大的数字）。");
    }
    facts.limit = Number(facts.budget);
  }
  facts.randomness = Math.min(100, Math.max(0, Number(facts.randomness) || 0));
  return facts;
}

export const formatTime = minutes => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

function scoreActivity(activity, facts, random) {
  let score = 0;
  const reasons = [];
  const matchedThemes = facts.themes.filter(theme => activity.themes.includes(theme));
  if (matchedThemes.length) { score += 4; reasons.push(`贴合${matchedThemes.join("、")}主题`); }
  if (facts.planning.includes("稳定不翻车") && activity.reliable) { score += 2; reasons.push("示例标记为容易安排"); }
  if (facts.planning.includes("易随机应变") && activity.flexible) { score += 2; reasons.push("示例标记为可灵活调整"); }
  if (facts.energy.includes("想放松") && activity.energy === "low") { score += 2; reasons.push("体力需求较低"); }
  if (facts.interaction !== "any" && activity.interaction === facts.interaction) { score += 2; reasons.push("互动程度符合选择"); }
  if (facts.culture !== "any" && activity.culture === facts.culture) { score += 2; reasons.push("文化体力符合选择"); }
  if (activity.category === "meal") score += 1;
  // 随机性只影响候选排序，预算、范围等约束始终有效。
  const ratio = facts.randomness / 100;
  return { activity, score: score * (1 - ratio) + (ratio ? random() * 10 * ratio : 0), reasons };
}

export function createPlan(input = {}, library = activities, random = Math.random) {
  const facts = normalizeFacts(input);
  const constraints = {};
  const trace = [];
  for (const rule of rules) {
    if (rule.when(facts)) { rule.then(constraints); trace.push({ id: rule.id, text: rule.text }); }
  }
  const excluded = String(facts.excluded).split(/[，,、;；\n]/u).map(s => s.trim().toLocaleLowerCase()).filter(Boolean);
  if (excluded.length) trace.push({ id: "R08", text: `排除地点关键词：${excluded.join("、")}。` });
  if (Number.isFinite(facts.limit)) trace.push({ id: "R09", text: `以费用区间上限控制总预算 ≤ ¥${facts.limit}（两人合计）。` });
  const selectedWindows = Object.entries(windows).filter(([key]) => facts.slots.includes(key)).map(([, value]) => value);
  const availableWindows = selectedWindows.length ? selectedWindows : [windows.afternoon];
  const candidates = library.filter(a =>
    (!constraints.indoor || a.indoor) && (!constraints.lowEnergy || a.energy === "low") &&
    (!constraints.quiet || a.quiet) && (!constraints.uncrowded || a.uncrowded) &&
    (!constraints.campus || a.area === "campus") && (!constraints.lightCulture || a.culture === "light") &&
    !a.foodTags.some(tag => facts.diet.includes(tag)) &&
    !excluded.some(word => `${a.name} ${a.place}`.toLocaleLowerCase().includes(word))
  ).map(a => scoreActivity(a, facts, random)).sort((a, b) => b.score - a.score || a.activity.id.localeCompare(b.activity.id));

  const steps = [];
  const categories = new Set();
  let min = 0, max = 0, cursor = availableWindows[0].start, windowIndex = 0;
  for (const candidate of candidates) {
    if (steps.length >= 3) break;
    const a = candidate.activity;
    if (categories.has(a.category) || max + a.cost[1] > facts.limit) continue;
    const previous = steps.at(-1);
    const buffer = previous ? (previous.activity.area === a.area ? 10 : 20) : 0;
    let start = cursor + buffer;
    let nextWindow = windowIndex;
    while (nextWindow < availableWindows.length && start + a.duration > availableWindows[nextWindow].end) {
      nextWindow += 1;
      if (nextWindow < availableWindows.length) start = Math.max(cursor + buffer, availableWindows[nextWindow].start);
    }
    if (nextWindow >= availableWindows.length) continue;
    windowIndex = nextWindow;
    steps.push({ activity: a, start, end: start + a.duration, buffer, gap: previous ? start - cursor : 0, reasons: candidate.reasons });
    cursor = start + a.duration;
    min += a.cost[0]; max += a.cost[1]; categories.add(a.category);
  }
  trace.push({ id: "R10", text: `在${availableWindows.map(w => w.label).join("、")}安排${steps.length}个不同类型的活动；同范围预留10分钟，跨范围预留20分钟转场。` });
  const notes = [];
  if (facts.relationship || facts.week || facts.behavior.length || facts.mood.length || facts.period.length || facts.cycle) {
    notes.push("关系、行为、心情、时期及生理状态已记录为本次备注，当前示例规则暂未采用这些信息。");
  }
  if (steps.length) notes.push("实际营业时间、人流、费用与路线请出发前确认。转场时间为示例估计。");
  return { facts, steps, cost: { min, max }, trace, notes, candidates: candidates.length, duration: steps.length ? steps.at(-1).end - steps[0].start : 0 };
}
