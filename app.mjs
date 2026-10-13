import { createPlan, formatTime } from "./planner.mjs";

const form = document.querySelector("#planner-form");
const result = document.querySelector("#result");
const resultTitle = document.querySelector("#result-title");
const error = document.querySelector("#form-error");
const status = document.querySelector("#result-status");
const budget = document.querySelector("#budget");
const randomness = document.querySelector("#randomness");
const randomnessValue = document.querySelector("#randomness-value");

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

// 标签和值显式对应现有规划器；单选组也可保持未选择。
function addOptions(target, name, title, options, type = "checkbox") {
  const group = element("fieldset", undefined, "option-group");
  group.append(element("legend", title));
  const choices = element("div", undefined, "choices");
  for (const option of options) {
    const [value, label] = Array.isArray(option) ? option : [option, option];
    const input = document.createElement("input");
    input.type = type;
    input.name = name;
    input.value = value;
    const wrapper = element("label", undefined, "choice");
    wrapper.append(input, document.createTextNode(label));
    choices.append(wrapper);
  }
  group.append(choices);
  document.querySelector(target).append(group);
}

addOptions("#preferences", "environment", "环境", ["安静", "人少", "室内"]);
addOptions("#preferences", "planning", "计划", ["稳定不翻车", "易随机应变"]);
addOptions("#preferences", "diet", "忌口", ["生食", "热气", "辣"]);
addOptions("#preferences", "behavior", "行为", ["日常", "小别", "经后第14天附近"]);
addOptions("#preferences", "themes", "主题", ["中式", "日式", "浪漫", "新鲜"]);
addOptions("#state-options", "relationship", "关系", ["初次约会", "暧昧", "热恋", "稳定", "老夫老妻"], "radio");
addOptions("#state-options", "cycle", "生理状态（仅备注）", ["经期临近", "经期期间"], "radio");
addOptions("#state-options", "culture", "文化体力", [["high", "高"], ["medium", "中"], ["light", "轻松 / 无脑"]], "radio");
addOptions("#current-options", "mood", "心情", ["开心"]);
addOptions("#current-options", "energy", "精力", ["疲惫", "紧张", "想放松"]);
addOptions("#current-options", "period", "时期", ["假期", "临考"]);
addOptions("#time-options", "slots", "一天（多选）", [["morning", "上午"], ["afternoon", "下午"], ["evening", "晚上"]]);
addOptions("#time-options", "week", "一周", ["周中", "周末"], "radio");

function updateControls() {
  const limited = form.elements.budgetMode.value === "limited";
  budget.disabled = !limited;
  budget.required = limited;
  randomnessValue.textContent = randomness.value;
}

function readFacts() {
  const data = new FormData(form);
  const facts = {};
  for (const key of ["environment", "planning", "diet", "behavior", "themes", "energy", "mood", "period", "slots"]) {
    facts[key] = data.getAll(key);
  }
  for (const key of ["relationship", "week", "cycle", "excluded", "scope", "budgetMode", "budget", "weather", "interaction"]) {
    facts[key] = data.get(key) ?? "";
  }
  facts.culture = data.get("culture") ?? "any";
  facts.randomness = Number(data.get("randomness"));
  return facts;
}

function costLabel(min, max) {
  return min === max ? `¥${min}` : `¥${min}–${max}`;
}

function renderEmpty() {
  resultTitle.textContent = "你的约会方案";
  const empty = element("div", undefined, "empty-state");
  empty.append(element("p", "选择条件后，生成你的第一份方案"), element("p", "这里会显示两人预算、活动时间线和实际触发的推荐依据。", "hint"));
  result.replaceChildren(empty);
}

function renderPlan(plan) {
  resultTitle.textContent = "DateLogic · 方案 A";
  const content = document.createDocumentFragment();
  const overview = element("dl", undefined, "overview");
  for (const [label, value] of [["两人合计预算", costLabel(plan.cost.min, plan.cost.max)], ["活动环节", `${plan.steps.length} 个`], ["总时长（含间隔）", `${plan.duration} 分钟`]]) {
    const item = element("div");
    item.append(element("dt", label), element("dd", value));
    overview.append(item);
  }
  content.append(overview);
  if (!plan.steps.length) {
    content.append(element("p", "当前条件下没有可安排的活动，请减少限制或调整时间、预算。"));
  } else {
    content.append(element("h3", "约会时间线"));
    const timeline = element("ol", undefined, "timeline");
    plan.steps.forEach((step, index) => {
      const item = element("li");
      if (index > 0) {
        // gap 包含转场和跨时段等待，不能把整个间隔当成转场。
        const waiting = Math.max(0, step.gap - step.buffer);
        const previous = plan.steps[index - 1];
        const transition = `${formatTime(previous.end)} — ${formatTime(step.start)} · 间隔 ${step.gap} 分钟：估计转场 ${step.buffer} 分钟${waiting ? `，等待 / 自由时间 ${waiting} 分钟` : ""}`;
        item.append(element("p", transition, "transition"));
      }
      item.append(element("p", `${formatTime(step.start)} — ${formatTime(step.end)} · ${step.end - step.start} 分钟`, "time"));
      item.append(element("h4", step.activity.name));
      item.append(element("p", `${step.activity.place} · ${costLabel(...step.activity.cost)}（两人合计）`, "hint"));
      if (step.reasons.length) item.append(element("p", `匹配理由：${step.reasons.join("；")}`, "hint"));
      timeline.append(item);
    });
    content.append(timeline);
  }
  content.append(element("h3", "推荐依据"), element("p", `当前筛选后候选：${plan.candidates} 个。以下为本次实际执行的规则记录。`, "hint"));
  const evidence = element("ul", undefined, "evidence");
  for (const entry of plan.trace) evidence.append(element("li", `${entry.id} · ${entry.text}`));
  content.append(evidence);
  if (plan.notes.length) {
    content.append(element("h3", "备注与使用边界"));
    const notes = element("ul", undefined, "notes");
    for (const note of plan.notes) notes.append(element("li", note));
    content.append(notes);
  }
  content.append(element("p", "活动与场地均为虚构教学示例，请根据实际资料确认场地与费用。", "hint"));
  result.replaceChildren(content);
}

form.addEventListener("change", updateControls);
randomness.addEventListener("input", updateControls);
form.addEventListener("submit", event => {
  event.preventDefault();
  error.hidden = true;
  error.textContent = "";
  try {
    const plan = createPlan(readFacts());
    renderPlan(plan);
    status.textContent = `方案已生成，共 ${plan.steps.length} 个活动，${plan.duration} 分钟。`;
    resultTitle.focus();
  } catch (cause) {
    error.textContent = cause instanceof Error ? cause.message : "暂时无法生成方案，请检查条件后重试。";
    error.hidden = false;
    status.textContent = "生成失败，请检查条件。";
  }
});
form.addEventListener("reset", () => {
  // 默认值在 reset 事件处理结束后恢复，下一任务再同步控件。
  setTimeout(() => {
    updateControls();
    error.hidden = true;
    error.textContent = "";
    renderEmpty();
    status.textContent = "条件和方案已重置。";
  });
});
updateControls();
