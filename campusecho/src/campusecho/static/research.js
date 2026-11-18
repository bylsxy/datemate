"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clone = value => JSON.parse(JSON.stringify(value));
const finite = value => typeof value === "number" && Number.isFinite(value);
const list = value => Array.isArray(value) ? value : [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[char]));

const API = Object.freeze({
  graph: "/api/graph",
  questions: "/api/questions",
  search: "/api/search",
  searchRun: runId => `/api/search/${encodeURIComponent(runId)}`,
  adopt: "/api/sandbox/adopt",
});

const ALGORITHMS = {
  bfs: { name: "BFS", caption: "逐层展开", mark: "BFS" },
  astar: { name: "A*", caption: "代价与启发", mark: "A*" },
  ga_astar: { name: "GA-A*", caption: "学习权重", mark: "GA" },
  ga_classifier: { name: "GA+分类器", caption: "路径价值", mark: "ML" },
  mcts: { name: "MCTS", caption: "访问与价值", mark: "MCTS" },
  llm: { name: "LLM 引导", caption: "评分与异常", mark: "LLM" },
};

const PLACES = {
  teaching: "教学楼", library: "图书馆", club: "社团室",
  walkway: "有顶连廊", canteen: "食堂", venue: "活动会场",
};

const TOPICS = {
  find: { name: "找到小汐", answer: "社团室", place: "club", minutes: 11 },
  inform: { name: "传达活动改址", answer: "活动会场", place: "venue", minutes: 18 },
  umbrella: { name: "雨天送伞", answer: "有顶连廊", place: "walkway", minutes: 9 },
};

const FALLBACK_QUESTIONS = [
  { id: "q-method", category: "2 跳推理", title: "Transformer 与 Self-Attention 如何相连？", summary: "从模型沿论文与方法关系找到可核查证据。", query: "Transformer 与 Self-Attention 如何通过论文关系相连？", entities: ["model:attention", "paper:attention", "method:attention"] },
  { id: "q-paper", category: "论文关系", title: "哪些方法来自注意力论文？", summary: "从论文出发，追踪模型、方法、数据集与主题。", query: "Attention Is All You Need 经过多跳关系关联了哪些方法与实体？", entities: ["paper:attention"] },
  { id: "q-campus", category: "校园应用", title: "怎样为活动匹配社团和场地？", summary: "沿成员、活动、地点与协作关系找到可行方案。", query: "在虚构校园中，哪些社团和场地经过多跳关系可以共同支持迎新活动？", entities: ["club:02:0", "event:02:0"] },
];

const FALLBACK_GRAPH = {
  nodes: [
    { id: "xiaxi", label: "小汐", type: "person", x: 50, y: 15 },
    { id: "roommate", label: "室友", type: "person", x: 18, y: 31 },
    { id: "clubmate", label: "社团同学", type: "person", x: 82, y: 31 },
    { id: "library", label: "图书馆", type: "place", x: 17, y: 58 },
    { id: "club", label: "社团室", type: "place", x: 50, y: 51 },
    { id: "walkway", label: "有顶连廊", type: "place", x: 83, y: 58 },
    { id: "venue", label: "活动会场", type: "place", x: 50, y: 84 },
    { id: "old-photo", label: "旧照片", type: "evidence", x: 16, y: 84 },
    { id: "direct-reply", label: "直接回复", type: "evidence", x: 84, y: 84 },
  ],
  edges: [
    { source: "roommate", target: "library", label: "目击" },
    { source: "clubmate", target: "club", label: "线索" },
    { source: "old-photo", target: "library", label: "同源" },
    { source: "direct-reply", target: "xiaxi", label: "来源" },
    { source: "library", target: "club", label: "步行 6" },
    { source: "club", target: "walkway", label: "步行 4" },
    { source: "walkway", target: "venue", label: "步行 7" },
    { source: "xiaxi", target: "club", label: "候选" },
  ],
};

const FALLBACK_TRACE = {
  astar: [
    { id: "root", label: "教学楼", g: 0, h: 9, f: 9, cost: 0, confidence: .18, state: "起点", detail: "从玩家当前位置建立搜索根节点。", evidence: ["位置起点"] },
    { id: "library", label: "图书馆", g: 5, h: 6, f: 11, cost: 5, confidence: .36, state: "展开", detail: "室友线索指向图书馆，但旧照片时间较早。", evidence: ["室友目击", "旧照片"] },
    { id: "club", label: "社团室", g: 8, h: 3, f: 11, cost: 8, confidence: .58, state: "展开", detail: "社团同学线索较新，路径代价与图书馆并列。", evidence: ["社团同学线索", "接收时间较新"] },
    { id: "walkway", label: "有顶连廊", g: 12, h: 2, f: 14, cost: 12, confidence: .71, state: "展开", detail: "从社团室继续扩展，保留通往会场的路径。", evidence: ["社团室候选", "地图边"] },
    { id: "xiaxi", label: "找到小汐", g: 16, h: 0, f: 16, cost: 16, confidence: .82, state: "目标", detail: "当前最可信位置为社团室，先到场核实。", evidence: ["社团同学线索", "旧照片排除", "路线约束"] },
  ],
  ga_astar: [
    { id: "root", label: "教学楼", g: 0, h: 8.7, f: 8.7, cost: 0, confidence: .20, state: "起点", detail: "GA 学习权重读取四维结构特征，建立搜索根节点。", evidence: ["位置起点", "学习启发"] },
    { id: "club", label: "社团室", g: 8, h: 2.3, f: 10.3, cost: 8, confidence: .61, state: "展开", detail: "目标邻近度权重较高，社团室分支优先于旧照片路径。", evidence: ["社团同学线索", "GA 权重"] },
    { id: "library", label: "图书馆", g: 5, h: 5.6, f: 10.6, cost: 5, confidence: .42, state: "保留", detail: "旧照片仍有结构支持，但启发分数低于新近线索。", evidence: ["室友目击", "旧照片"] },
    { id: "walkway", label: "有顶连廊", g: 12, h: 1.4, f: 13.4, cost: 12, confidence: .73, state: "展开", detail: "前沿平衡与路径效率共同保留通往会场的路线。", evidence: ["社团室候选", "地图边"] },
    { id: "xiaxi", label: "找到小汐", g: 16, h: 0, f: 16, cost: 16, confidence: .82, state: "目标", detail: "GA-A* 在相同问题上完成路径排序，候选结论仍由图谱路径验证。", evidence: ["社团同学线索", "路径约束", "学习启发"] },
  ],
  ga_classifier: [
    { id: "root", label: "教学楼", g: 0, h: 8.9, f: 8.9, cost: 0, confidence: .22, state: "起点", detail: "分类器读取路径结构概率，为候选路径补充价值排序。", evidence: ["位置起点", "路径分类器"] },
    { id: "club", label: "社团室", g: 8, h: 2.1, f: 10.1, cost: 8, confidence: .64, state: "展开", detail: "分类器提高新近线索路径的优先级，同时保留 GA 学习权重。", evidence: ["社团同学线索", "分类器评分"] },
    { id: "library", label: "图书馆", g: 5, h: 5.8, f: 10.8, cost: 5, confidence: .39, state: "保留", detail: "旧照片路径获得较低价值分，但未被删除。", evidence: ["室友目击", "旧照片"] },
    { id: "walkway", label: "有顶连廊", g: 12, h: 1.2, f: 13.2, cost: 12, confidence: .75, state: "展开", detail: "路径价值与前沿结构共同保留后续路线。", evidence: ["地图边", "分类器评分"] },
    { id: "xiaxi", label: "找到小汐", g: 16, h: 0, f: 16, cost: 16, confidence: .84, state: "目标", detail: "GA+分类器完成同题排序，最终答案仍来自可核验图谱路径。", evidence: ["社团同学线索", "路径约束", "分类器评分"] },
  ],
  mcts: [
    { id: "root", label: "教学楼", visits: 1, value: .18, state: "根节点", detail: "从起点开始进行选择、扩展与回传。", evidence: ["位置起点"] },
    { id: "library", label: "图书馆", visits: 7, value: .34, state: "扩展", detail: "旧照片分支访问较多，但价值低于新线索。", evidence: ["室友目击", "旧照片"] },
    { id: "club", label: "社团室", visits: 11, value: .61, state: "扩展", detail: "新近线索获得更高平均回报，成为主分支。", evidence: ["社团同学线索"] },
    { id: "walkway", label: "有顶连廊", visits: 8, value: .72, state: "扩展", detail: "沿主分支继续模拟，访问数用于平衡探索。", evidence: ["地图边", "候选路径"] },
    { id: "xiaxi", label: "找到小汐", visits: 14, value: .84, state: "目标", detail: "社团室分支累计价值最高，保留为当前建议。", evidence: ["社团同学线索", "路线约束"] },
  ],
  llm: [
    { id: "root", label: "教学楼", score: .22, state: "起点", detail: "模型读取问题卡与可见实体，生成初始候选。", evidence: ["问题卡"] },
    { id: "library", label: "图书馆", score: .48, state: "评分", detail: "旧照片与室友目击一致，但时间陈旧降低评分。", evidence: ["室友目击", "旧照片"] },
    { id: "club", label: "社团室", score: .78, state: "评分", detail: "社团同学的线索更近，且与任务对象直接相关。", evidence: ["社团同学线索"] },
    { id: "walkway", label: "有顶连廊", score: .66, state: "校验", detail: "地图边可连接候选地点，模型保留路线约束。", evidence: ["地图边"] },
    { id: "xiaxi", label: "找到小汐", score: .86, state: "目标", detail: "候选结论为社团室；旧照片证据出现时间异常，已标记。", evidence: ["社团同学线索", "时间异常"] },
  ],
};

function fallbackTrace(algorithm) {
  if (algorithm === "bfs") {
    return clone(FALLBACK_TRACE.astar).map((step, index) => ({
      ...step,
      state: index === 0 ? "根节点" : "逐层展开",
      detail: `BFS 第 ${index} 层候选；按队列顺序展开。`,
    }));
  }
  return clone(FALLBACK_TRACE[algorithm] ?? FALLBACK_TRACE.astar);
}

const state = {
  view: "search",
  graph: null,
  graphSource: "loading",
  questions: [],
  selectedQuestion: null,
  selectedEntities: new Set(["xiaxi", "club", "old-photo"]),
  algorithm: "astar",
  run: null,
  trace: [],
  traceIndex: 0,
  playing: false,
  playbackTimer: null,
  comparisons: [],
  topic: "find",
  adopted: false,
  adoption: null,
  busy: false,
};

function announce(text) {
  $("#announcement").textContent = text;
}

function toast(message, kind = "info") {
  const node = document.createElement("div");
  node.className = `toast ${kind === "error" ? "error" : ""}`;
  node.textContent = message;
  $("#toast-region").append(node);
  setTimeout(() => node.remove(), 4200);
}

function setConnection(source, message) {
  const pill = $("#connection-pill");
  pill.dataset.state = source === "api" ? "online" : source === "fallback" ? "offline" : "loading";
  $("#connection-text").textContent = message;
}

function setSourceNotice(source, message) {
  const notice = $("#source-notice");
  notice.dataset.state = source;
  $("p", notice).textContent = message;
}

function normalizeGraph(payload) {
  const data = payload?.data ?? payload ?? {};
  const rawNodes = list(data.nodes ?? data.entities ?? data.graph?.nodes);
  const rawEdges = list(data.edges ?? data.relations ?? data.graph?.edges);
  const nodes = rawNodes.map((node, index) => ({
    id: String(node.id ?? node.key ?? node.entity_id ?? `node-${index}`),
    label: String(node.label ?? node.name ?? node.title ?? node.id ?? `节点 ${index + 1}`),
    type: String(node.type ?? node.kind ?? node.category ?? "entity").toLowerCase(),
    x: finite(node.x) ? node.x : finite(node.position?.x) ? node.position.x : null,
    y: finite(node.y) ? node.y : finite(node.position?.y) ? node.position.y : null,
    description: node.description ?? node.summary ?? "",
  }));
  const edges = rawEdges.map((edge, index) => ({
    id: String(edge.id ?? `edge-${index}`),
    source: String(edge.source ?? edge.from ?? edge.head ?? edge.subject ?? ""),
    target: String(edge.target ?? edge.to ?? edge.tail ?? edge.object ?? ""),
    label: String(edge.label ?? edge.relation ?? edge.predicate ?? "关联"),
  })).filter(edge => edge.source && edge.target);
  return { nodes, edges };
}

function normalizeQuestions(payload) {
  const data = payload?.data ?? payload ?? {};
  const raw = list(data.questions ?? data.items ?? payload);
  return raw.map((item, index) => {
    if (typeof item === "string") {
      return { id: `question-${index}`, category: "问题卡", title: item, summary: "从知识图谱中查找相关证据。", query: item, entities: [] };
    }
    return {
      id: String(item.id ?? item.question_id ?? `question-${index}`),
      category: String(item.category ?? item.kind ?? item.type ?? "问题卡"),
      title: String(item.title ?? item.question ?? item.text ?? `问题 ${index + 1}`),
      summary: String(item.summary ?? item.description ?? item.hint ?? "从知识图谱中查找相关证据。"),
      query: String(item.query ?? item.prompt ?? item.question ?? item.text ?? item.title ?? ""),
      entities: list(item.entities ?? item.entity_ids ?? item.focus).map(String),
    };
  });
}

async function requestJson(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      headers: { "Accept": "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
      signal: controller.signal,
    });
    let body = null;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) body = await response.json();
    else {
      const text = await response.text();
      try { body = JSON.parse(text); } catch { body = { detail: text }; }
    }
    if (!response.ok) {
      const detail = body?.detail ?? body?.message ?? `接口返回 ${response.status}`;
      const compactDetail = String(detail).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      const error = new Error(Array.isArray(detail) ? detail.map(row => row.msg || JSON.stringify(row)).join("；") : compactDetail.slice(0, 180));
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时，请检查本地服务后重试。");
    if (error instanceof TypeError) throw new Error("暂时连接不到接口，已保留当前界面状态。");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function setBusy(value) {
  state.busy = value;
  $("#run-search").disabled = value;
  $("#run-comparison").disabled = value;
  $("#refresh-sources").disabled = value;
  $("#adopt-plan").disabled = value || state.adopted;
  $("#run-search span").textContent = value ? "搜索中…" : "运行组合搜索";
}

function graphStats() {
  $("#graph-node-count").textContent = String(state.graph?.nodes?.length ?? "—");
  $("#graph-edge-count").textContent = String(state.graph?.edges?.length ?? "—");
  $("#question-count").textContent = String(state.questions.length || "—");
}

function renderQuestions() {
  const root = $("#question-cards");
  root.replaceChildren();
  (state.questions.length ? state.questions : FALLBACK_QUESTIONS).slice(0, 3).forEach((question, index) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `question-card${question.id === state.selectedQuestion?.id ? " is-selected" : ""}`;
    card.dataset.questionId = question.id;
    card.innerHTML = `<div class="question-card-top"><span>${escapeHtml(question.category || `问题 ${index + 1}`)}</span><b>${question.entities?.length || 0} 个实体</b></div><h3>${escapeHtml(question.title)}</h3><p>${escapeHtml(question.summary)}</p>`;
    card.addEventListener("click", () => selectQuestion(question));
    root.append(card);
  });
}

function selectQuestion(question) {
  state.selectedQuestion = question;
  $("#query-input").value = question.query;
  state.selectedEntities = new Set(question.entities || []);
  renderQuestions();
  renderEntityChips();
  renderGraph();
  announce(`已选择问题：${question.title}`);
}

function renderEntityChips() {
  const root = $("#entity-chips");
  root.replaceChildren();
  const nodes = new Map((state.graph?.nodes || FALLBACK_GRAPH.nodes).map(node => [node.id, node]));
  for (const id of state.selectedEntities) {
    const node = nodes.get(id) || { label: id, type: "entity" };
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "entity-chip";
    chip.dataset.entity = id;
    chip.innerHTML = `<span>${escapeHtml(typeLabel(node.type))}</span>${escapeHtml(node.label)}<svg class="icon"><use href="#i-close"/></svg>`;
    chip.addEventListener("click", () => {
      state.selectedEntities.delete(id);
      renderEntityChips();
      renderGraph();
    });
    root.append(chip);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.className = "entity-add";
  add.id = "focus-graph";
  add.textContent = "+ 从图谱添加";
  add.addEventListener("click", () => {
    $("#graph-panel").scrollIntoView({ behavior: "smooth", block: "center" });
    $("#graph-filter").focus();
  });
  root.append(add);
}

function typeLabel(type) {
  if (["person", "actor", "人物"].includes(type)) return "人物";
  if (["place", "location", "地点"].includes(type)) return "地点";
  if (["evidence", "observation", "证据", "source"].includes(type)) return "证据";
  return "实体";
}

function nodeType(type) {
  if (["person", "actor", "人物"].includes(type)) return "person";
  if (["place", "location", "地点"].includes(type)) return "place";
  if (["evidence", "observation", "证据", "source"].includes(type)) return "evidence";
  return "entity";
}

function fallbackPositions(nodes) {
  const positions = {
    xiaxi: [50, 15], roommate: [18, 31], clubmate: [82, 31],
    library: [17, 58], club: [50, 51], walkway: [83, 58], venue: [50, 84],
    "old-photo": [16, 84], "direct-reply": [84, 84], teaching: [14, 12], canteen: [84, 84],
  };
  return nodes.map((node, index) => {
    const known = positions[node.id];
    if (known) return { ...node, x: known[0], y: known[1] };
    const ring = Math.floor(index / 8) + 1;
    const angle = (index % 8) / 8 * Math.PI * 2;
    return { ...node, x: 50 + Math.cos(angle) * Math.min(38, 18 + ring * 8), y: 49 + Math.sin(angle) * Math.min(36, 16 + ring * 8) };
  });
}

function renderGraph() {
  const container = $("#knowledge-graph");
  if (!state.graph) return;
  const filter = $("#graph-filter").value.trim().toLowerCase();
  const nodes = fallbackPositions(state.graph.nodes);
  const byId = new Map(nodes.map(node => [node.id, node]));
  container.replaceChildren();
  const edgeLayer = document.createElement("div");
  edgeLayer.className = "graph-edge-layer";
  for (const edge of state.graph.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    const x1 = source.x * 6.8, y1 = source.y * 3.28;
    const x2 = target.x * 6.8, y2 = target.y * 3.28;
    const length = Math.hypot(x2 - x1, y2 - y1);
    const angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
    const line = document.createElement("i");
    line.className = `graph-edge${state.selectedEntities.has(edge.source) && state.selectedEntities.has(edge.target) ? " is-active" : ""}`;
    line.style.cssText = `left:${x1 / 6.8}%;top:${y1 / 3.28}%;width:${length / 6.8}%;transform:rotate(${angle}deg)`;
    edgeLayer.append(line);
    const label = document.createElement("span");
    label.className = "graph-edge-label";
    label.textContent = edge.label;
    label.style.cssText = `left:${(source.x + target.x) / 2}%;top:${(source.y + target.y) / 2}%`;
    edgeLayer.append(label);
  }
  container.append(edgeLayer);
  for (const node of nodes) {
    const kind = nodeType(node.type);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `graph-node ${kind}${state.selectedEntities.has(node.id) ? " is-selected" : ""}${filter && !node.label.toLowerCase().includes(filter) ? " is-dimmed" : ""}`;
    button.style.cssText = `left:${node.x}%;top:${node.y}%`;
    button.dataset.nodeId = node.id;
    button.setAttribute("aria-label", `${typeLabel(node.type)}：${node.label}${state.selectedEntities.has(node.id) ? "，已加入查询" : "，点击加入查询"}`);
    button.innerHTML = `<span class="node-icon">${kind === "person" ? "人" : kind === "place" ? "地" : kind === "evidence" ? "证" : "实"}</span><strong>${escapeHtml(node.label)}</strong><small>${escapeHtml(node.id)}</small>`;
    button.addEventListener("click", () => {
      if (state.selectedEntities.has(node.id)) state.selectedEntities.delete(node.id);
      else state.selectedEntities.add(node.id);
      renderEntityChips();
      renderGraph();
      announce(`${node.label}${state.selectedEntities.has(node.id) ? "已加入" : "已移出"}查询`);
    });
    container.append(button);
  }
}

function normalizeTrace(payload, algorithm) {
  const data = payload?.data ?? payload ?? {};
  const raw = list(data.steps ?? data.trace ?? data.states ?? data.tree?.steps);
  if (!raw.length) return fallbackTrace(algorithm);
  return raw.map((step, index) => ({
    id: String(step.id ?? step.node_id ?? `step-${index}`),
    nodeId: String(step.node_id ?? step.id ?? `step-${index}`),
    parentId: step.parent_id == null ? null : String(step.parent_id),
    path: list(step.path).map(item => String(item)),
    label: String(step.label ?? step.name ?? step.node ?? step.entity ?? `步骤 ${index + 1}`),
    state: String(step.state ?? step.status ?? (index === raw.length - 1 ? "目标" : "展开")),
    detail: String(step.detail ?? step.reason ?? step.explanation ?? step.summary ?? "搜索推进到下一个候选。"),
    evidence: list(step.evidence ?? step.evidence_ids ?? step.sources).map(item => typeof item === "string" ? item : item.label ?? item.id ?? "证据"),
    g: finite(step.g) ? step.g : null, h: finite(step.h) ? step.h : null, f: finite(step.f) ? step.f : null,
    visits: finite(step.visits ?? step.visit_count) ? (step.visits ?? step.visit_count) : null,
    value: finite(step.value ?? step.mean_value) ? (step.value ?? step.mean_value) : null,
    score: finite(step.score ?? step.confidence) ? (step.score ?? step.confidence) : null,
    anomaly: step.anomaly ?? step.warning ?? null,
    cost: finite(step.cost ?? step.path_cost) ? (step.cost ?? step.path_cost) : finite(step.g) ? step.g : null,
    confidence: finite(step.confidence) ? step.confidence : null,
    depth: finite(step.depth) ? step.depth : null,
    eventKind: String(step.event_kind ?? step.kind ?? "candidate"),
    order: finite(step.order) ? step.order : index,
  }));
}

function normalizeTree(payload) {
  if (!payload || !Array.isArray(payload.nodes) || !payload.nodes.length) return null;
  return {
    rootId: payload.root_id ?? payload.rootId ?? null,
    nodes: payload.nodes.map((node, index) => ({
      id: String(node.id ?? `node-${index}`),
      parentId: node.parent_id == null ? null : String(node.parent_id),
      label: String(node.label ?? node.entity_id ?? node.id ?? `节点 ${index + 1}`),
      path: list(node.path).map(item => String(item)),
      depth: node.depth != null && finite(Number(node.depth)) ? Number(node.depth) : null,
      order: node.order != null && finite(Number(node.order)) ? Number(node.order) : index,
      status: String(node.status ?? "frontier"),
      statusLabel: String(node.status_label ?? node.status ?? "前沿"),
      detail: String(node.detail ?? ""),
      g: finite(node.g) ? node.g : null,
      h: finite(node.h) ? node.h : null,
      f: finite(node.f) ? node.f : null,
      visits: finite(node.visits) ? node.visits : null,
      value: finite(node.value) ? node.value : null,
      score: finite(node.score) ? node.score : null,
    })),
    edges: list(payload.edges).map((edge, index) => ({
      id: String(edge.id ?? `edge-${index}`),
      source: String(edge.source ?? ""),
      target: String(edge.target ?? ""),
      order: edge.order != null && finite(Number(edge.order)) ? Number(edge.order) : index,
    })).filter(edge => edge.source && edge.target),
    counts: payload.counts ?? {},
    rolloutWorkload: Number(payload.rollout_workload ?? 0),
  };
}

function normalizeRun(payload, algorithm, question) {
  const data = payload?.data ?? payload ?? {};
  const trace = normalizeTrace(data, algorithm);
  const tree = normalizeTree(data.tree);
  if (tree) {
    const traceOrder = new Map(
      trace.map((step, index) => [step.path.join("|"), index])
    );
    tree.nodes.forEach(node => {
      const order = traceOrder.get(node.path.join("|"));
      if (order != null) node.order = order;
    });
  }
  const answer = data.answer ?? data.result ?? data.conclusion ?? {};
  const answerLabel = typeof answer === "string" ? answer : answer.label ?? answer.title ?? answer.candidate ?? answer.entity ?? trace.at(-1)?.label ?? "暂无结论";
  const confidence = finite(data.confidence) ? data.confidence : finite(answer.confidence) ? answer.confidence : finite(trace.at(-1)?.confidence) ? trace.at(-1).confidence : finite(trace.at(-1)?.score) ? trace.at(-1).score : .72;
  const metrics = data.metrics ?? {};
  return {
    id: String(data.run_id ?? payload?.run_id ?? `local-${Date.now()}`),
    status: String(data.status ?? "completed"),
    algorithm,
    question: question?.title ?? $("#query-input").value,
    query: $("#query-input").value,
    entities: [...state.selectedEntities],
    answer: String(answerLabel),
    answerDetail: String(data.explanation ?? answer.detail ?? answer.summary ?? trace.at(-1)?.detail ?? ""),
    confidence: Math.max(0, Math.min(1, confidence)),
    expanded: Number(data.expanded_nodes ?? metrics.expanded_nodes ?? trace.length),
    cost: Number(data.path_cost ?? metrics.path_cost ?? trace.at(-1)?.cost ?? trace.at(-1)?.g ?? 0),
    anomaly: data.anomaly ?? data.warning ?? trace.find(step => step.anomaly)?.anomaly ?? null,
    trace,
    tree,
    evidence: list(data.evidence_path ?? data.evidence ?? answer.evidence ?? trace.at(-1)?.evidence).map((item, index) => typeof item === "string" ? { title: item, detail: "", source: "" } : { title: item.title ?? item.label ?? item.id ?? `证据 ${index + 1}`, detail: item.detail ?? item.summary ?? "", source: item.source ?? item.source_id ?? "" }),
  };
}

function renderAlgorithmSummary() {
  const root = $("#algorithm-summary");
  const run = state.run;
  const algo = ALGORITHMS[state.algorithm];
  const values = run ? [algo.name, String(run.expanded), formatNumber(run.cost), formatPercent(run.confidence)] : [algo.name, "—", "—", "—"];
  ["算法", "展开节点", "路径代价", "置信度"].forEach((label, index) => {
    const cell = root.children[index];
    $("span", cell).textContent = label;
    $("strong", cell).textContent = values[index];
  });
}

function formatNumber(value) {
  if (!finite(value)) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatPercent(value) {
  return finite(value) ? `${Math.round(value * 100)}%` : "—";
}

function traceLayout(trace) {
  const positions = [];
  const count = trace.length;
  for (let index = 0; index < count; index += 1) {
    const row = Math.floor(index / 3);
    const inRow = index % 3;
    const rowCount = Math.min(3, count - row * 3);
    const x = rowCount === 1 ? 50 : rowCount === 2 ? 31 + inRow * 38 : 19 + inRow * 31;
    const y = count <= 1 ? 50 : 16 + row * (68 / Math.max(1, Math.ceil(count / 3) - 1));
    positions.push({ x, y });
  }
  return positions;
}

function treeLayout(tree) {
  const byId = new Map(tree.nodes.map(node => [node.id, node]));
  const children = new Map(tree.nodes.map(node => [node.id, []]));
  tree.edges.forEach(edge => {
    if (byId.has(edge.source) && byId.has(edge.target)) {
      children.get(edge.source).push(edge.target);
    }
  });
  children.forEach(items => items.sort((a, b) => {
    const left = byId.get(a), right = byId.get(b);
    return (left?.order ?? 0) - (right?.order ?? 0) || a.localeCompare(b);
  }));
  let leaf = 0;
  const maxDepth = Math.max(1, ...tree.nodes.map(node => node.depth ?? 0));
  const visited = new Set();
  const visit = (id, depth) => {
    if (visited.has(id)) return null;
    visited.add(id);
    const node = byId.get(id);
    if (!node) return null;
    const kids = children.get(id) ?? [];
    const positions = kids.map(child => visit(child, depth + 1)).filter(Boolean);
    let x;
    if (!positions.length) {
      x = leaf;
      leaf += 1;
    } else {
      x = positions.reduce((sum, value) => sum + value, 0) / positions.length;
    }
    node.layoutX = x;
    node.layoutY = 7 + (Math.max(0, depth) / maxDepth) * 86;
    return x;
  };
  const rootId = tree.rootId && byId.has(tree.rootId) ? tree.rootId : tree.nodes[0]?.id;
  if (rootId) visit(rootId, 0);
  tree.nodes.forEach(node => {
    if (!visited.has(node.id)) visit(node.id, 0);
  });
  const width = Math.max(1, leaf - 1);
  tree.nodes.forEach(node => {
    node.layoutX = 5 + ((node.layoutX ?? 0) / width) * 90;
  });
  return tree.nodes;
}

function treeNodeMetric(node, algorithm) {
  if (algorithm === "astar") {
    return `<span>g ${formatNumber(node.g)} · h ${formatNumber(node.h)}</span><small>f ${formatNumber(node.f)}</small>`;
  }
  if (algorithm === "mcts") {
    return `<span>深度 ${formatNumber(node.depth)}</span><small>${escapeHtml(node.statusLabel)}</small>`;
  }
  return `<span>深度 ${formatNumber(node.depth)}</span><small>${escapeHtml(node.statusLabel)}</small>`;
}

function renderPlayback(trace) {
  const timeline = $("#trace-timeline");
  timeline.disabled = false;
  timeline.max = String(trace.length - 1);
  timeline.value = String(state.traceIndex);
  $("#step-counter").textContent = `${state.traceIndex + 1} / ${trace.length}`;
  $("#trace-prev").disabled = state.traceIndex === 0;
  $("#trace-next").disabled = state.traceIndex === trace.length - 1;
  $("#trace-play").disabled = false;
  $("#trace-play").innerHTML = `<svg class="icon"><use href="#${state.playing ? "i-pause" : "i-play"}"/></svg>`;
  renderStepDetail();
  renderEvidence();
}

function renderTree() {
  const stage = $("#trace-stage");
  const tree = state.run.tree;
  const nodes = treeLayout(tree);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const previousScroll = stage.scrollLeft;
  const density = Math.max(100, Math.ceil(nodes.length / 14) * 100);
  const treeRoot = document.createElement("div");
  treeRoot.className = "trace-tree is-hierarchy";
  treeRoot.style.width = `${density}%`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "trace-tree-lines");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  tree.edges.forEach(edge => {
    const source = byId.get(edge.source), target = byId.get(edge.target);
    if (!source || !target) return;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(source.layoutX));
    line.setAttribute("y1", String(source.layoutY));
    line.setAttribute("x2", String(target.layoutX));
    line.setAttribute("y2", String(target.layoutY));
    line.setAttribute("class", `tree-edge${target.order <= state.traceIndex ? " is-active" : ""}`);
    svg.append(line);
  });
  treeRoot.append(svg);
  nodes
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id))
    .forEach(node => {
      const element = document.createElement("button");
      element.type = "button";
      element.dataset.nodeId = node.id;
      element.className = `trace-node is-${node.status}${node.order <= state.traceIndex ? " is-visited" : ""}${node.order === state.traceIndex ? " is-current" : ""}${node.status === "goal" ? " is-solution" : ""}`;
      element.style.cssText = `left:${node.layoutX}%;top:${node.layoutY}%`;
      element.innerHTML = `<strong>${escapeHtml(node.label)}</strong>${treeNodeMetric(node, state.algorithm)}`;
      element.title = `${node.statusLabel}：${node.detail}`;
      element.addEventListener("click", () => {
        stopPlayback();
        state.traceIndex = Math.max(0, Math.min(state.trace.length - 1, node.order));
        renderTrace();
      });
      treeRoot.append(element);
    });
  stage.replaceChildren(treeRoot);
  stage.classList.add("is-tree");
  requestAnimationFrame(() => {
    const centered = Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2);
    stage.scrollLeft = previousScroll > 0 ? previousScroll : centered;
  });
  renderPlayback(state.trace);
}

function renderTrace() {
  const stage = $("#trace-stage");
  const trace = state.trace;
  renderAlgorithmSummary();
  if (!trace.length) {
    stage.classList.remove("is-tree");
    stage.innerHTML = `<div class="trace-empty"><span class="empty-orbit"><svg class="icon"><use href="#i-route"/></svg></span><h3>运行一次搜索</h3><p>搜索树会按节点展开顺序出现，可逐帧查看算法指标。</p></div>`;
    $("#trace-prev").disabled = true;
    $("#trace-play").disabled = true;
    $("#trace-next").disabled = true;
    $("#trace-timeline").disabled = true;
    $("#step-counter").textContent = "0 / 0";
    return;
  }
  if (state.run?.tree) {
    renderTree();
    return;
  }
  stage.classList.remove("is-tree");
  const positions = traceLayout(trace);
  stage.replaceChildren();
  const tree = document.createElement("div");
  tree.className = "trace-tree";
  for (let index = 1; index <= state.traceIndex; index += 1) {
    const from = positions[index - 1];
    const to = positions[index];
    if (!from || !to) continue;
    const x1 = from.x * 4.6, y1 = from.y * 2.64, x2 = to.x * 4.6, y2 = to.y * 2.64;
    const line = document.createElement("i");
    line.className = "tree-edge is-active";
    line.style.cssText = `left:${from.x}%;top:${from.y}%;width:${Math.hypot(x2 - x1, y2 - y1) / 4.6}%;transform:rotate(${Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI}deg)`;
    tree.append(line);
  }
  trace.forEach((step, index) => {
    const node = document.createElement("div");
    node.className = `trace-node${index <= state.traceIndex ? " is-visited" : ""}${index === state.traceIndex ? " is-current" : ""}${index === trace.length - 1 && index <= state.traceIndex ? " is-solution" : ""}`;
    node.style.cssText = `left:${positions[index].x}%;top:${positions[index].y}%`;
    node.innerHTML = `<strong>${escapeHtml(step.label)}</strong>${traceMetric(step)}`;
    tree.append(node);
  });
  stage.append(tree);
  renderPlayback(trace);
}

function traceMetric(step) {
  if (state.algorithm === "bfs") return `<span>深度 ${formatNumber(step.depth)}</span><small>逐层展开</small>`;
  if (["astar", "ga_astar", "ga_classifier"].includes(state.algorithm)) return `<span>g ${formatNumber(step.g)} · h ${formatNumber(step.h)}</span><small>f ${formatNumber(step.f)}</small>`;
  if (state.algorithm === "mcts") return `<span>访问 ${formatNumber(step.visits)}</span><small>价值 ${formatNumber(step.value)}</small>`;
  return `<span>评分 ${formatNumber(step.score)}</span><small>${step.anomaly ? "异常" : "正常"}</small>`;
}

function renderStepDetail() {
  const step = state.trace[state.traceIndex];
  if (!step) return;
  $(".step-index", $("#step-detail")).textContent = String(state.traceIndex + 1).padStart(2, "0");
  $(".step-detail-head h3", $("#step-detail")).textContent = step.label;
  $(".step-state", $("#step-detail")).textContent = step.state;
  $(".step-detail > p", $("#step-detail")).textContent = step.detail;
  const status = $("#trace-status");
  status.dataset.state = state.playing ? "running" : state.traceIndex === state.trace.length - 1 ? "done" : "idle";
  $("span", status).textContent = state.playing ? "播放中" : state.traceIndex === state.trace.length - 1 ? "搜索完成" : "可逐步查看";
}

function renderEvidence() {
  if (!state.run) return;
  const visibleStep = state.trace[state.traceIndex];
  const evidence = visibleStep?.evidence?.length ? visibleStep.evidence : state.run.evidence.map(item => item.title);
  $("#answer-card h3").textContent = state.traceIndex === state.trace.length - 1 ? state.run.answer : "正在核实候选";
  $("#answer-card p").textContent = state.traceIndex === state.trace.length - 1 ? state.run.answerDetail || "搜索路径已完成。" : visibleStep?.detail || "继续播放以查看结论。";
  $("#evidence-count").textContent = `${evidence.length} 条`;
  const root = $("#evidence-path");
  root.replaceChildren();
  if (!evidence.length) {
    root.innerHTML = `<li class="evidence-empty"><span><svg class="icon"><use href="#i-link"/></svg></span><p>当前步骤没有新增证据。</p></li>`;
  } else {
    evidence.forEach((item, index) => {
      const li = document.createElement("li");
      li.className = `evidence-step${index === evidence.length - 1 ? " is-active" : ""}`;
      const detail = typeof item === "string" ? state.run.evidence.find(row => row.title === item) : item;
      li.innerHTML = `<span>${String(index + 1).padStart(2, "0")}</span><div><strong>${escapeHtml(typeof item === "string" ? item : item.title)}</strong>${detail?.detail ? `<p>${escapeHtml(detail.detail)}</p>` : ""}${detail?.source ? `<em>${escapeHtml(detail.source)}</em>` : ""}</div>`;
      root.append(li);
    });
  }
  const confidence = state.traceIndex === state.trace.length - 1 ? state.run.confidence : visibleStep?.confidence ?? visibleStep?.score ?? visibleStep?.value ?? 0;
  $("#evidence-confidence").style.width = `${Math.max(0, Math.min(1, confidence)) * 100}%`;
  $("#evidence-confidence-text").textContent = formatPercent(confidence);
  $("#send-to-sandbox").disabled = state.traceIndex !== state.trace.length - 1;
}

function renderComparison() {
  const body = $("#comparison-body");
  if (!state.comparisons.length) {
    body.innerHTML = `<tr class="table-empty"><td colspan="8">运行搜索后，这里会并排展示 BFS、A*、GA-A*、GA+分类器、MCTS 与受限 LLM 引导结果。</td></tr>`;
    return;
  }
  const bestCost = Math.min(...state.comparisons.map(row => finite(row.cost) ? row.cost : Infinity));
  body.replaceChildren();
  state.comparisons.forEach(row => {
    const tr = document.createElement("tr");
    const relative = finite(row.cost) && Number.isFinite(bestCost) ? row.cost === bestCost ? "最低" : `+${formatNumber(row.cost - bestCost)}` : "—";
    const barWidth = finite(row.cost) && bestCost > 0 ? Math.min(64, Math.max(8, row.cost / bestCost * 30)) : 8;
    tr.innerHTML = `<td><span class="strategy-cell"><i class="strategy-mark ${row.algorithm}"></i>${escapeHtml(ALGORITHMS[row.algorithm].name)}</span></td><td class="answer-cell" title="${escapeHtml(row.answer)}">${escapeHtml(row.answer)}</td><td class="metric-cell">${formatNumber(row.expanded)}</td><td class="metric-cell">${formatNumber(row.cost)}</td><td class="metric-cell">${formatPercent(row.confidence)}</td><td><span class="anomaly-badge ${row.anomaly ? "warn" : ""}">${row.anomaly ? escapeHtml(String(row.anomaly)) : "无"}</span></td><td><div class="relative-bar"><i style="width:${barWidth}px"></i><span>${escapeHtml(relative)}</span></div></td><td><button type="button" class="compare-run" data-run-algorithm="${row.algorithm}">查看</button></td>`;
    $(".compare-run", tr).addEventListener("click", () => loadComparison(row));
    body.append(tr);
  });
}

function loadComparison(row) {
  state.algorithm = row.algorithm;
  $(`input[name="algorithm"][value="${row.algorithm}"]`).checked = true;
  state.run = row;
  state.trace = row.trace;
  state.traceIndex = row.trace.length - 1;
  renderAlgorithmSummary();
  renderTrace();
  announce(`已切换到${ALGORITHMS[row.algorithm].name}搜索结果`);
}

function localRun(algorithm, question) {
  const run = normalizeRun({ data: { run_id: `local-${algorithm}-${Date.now()}`, answer: algorithm === "mcts" ? "社团室（价值最高）" : algorithm === "llm" ? "社团室（含时间异常）" : algorithm === "bfs" ? "社团室（逐层基线）" : TOPICS[state.topic]?.answer || "社团室", confidence: algorithm === "llm" ? .86 : algorithm === "mcts" ? .84 : .82, anomaly: algorithm === "llm" ? "旧照片时间异常" : null } }, algorithm, question);
  run.trace = fallbackTrace(algorithm);
  run.expanded = run.trace.length;
  run.cost = algorithm === "astar" ? 16 : algorithm === "mcts" ? 14 : algorithm === "bfs" ? 18 : 12;
  run.evidence = [
    { title: "社团同学线索", detail: "消息指向社团室，接收时间晚于旧照片。", source: "clubmate" },
    { title: "室友目击", detail: "图书馆目击与旧照片同源，不能视为独立支持。", source: "roommate" },
    { title: "路线约束", detail: "从教学楼到社团室再到会场，仍需预留到场时间。", source: "campus-map" },
  ];
  return run;
}

async function runSearch(algorithm = state.algorithm, question = state.selectedQuestion) {
  if (state.busy) return null;
  setBusy(true);
  stopPlayback();
  state.algorithm = algorithm;
  state.run = null;
  state.trace = [];
  state.traceIndex = 0;
  $("#trace-status").dataset.state = "running";
  $("#trace-status span").textContent = "请求搜索";
  $("#trace-stage").innerHTML = `<div class="trace-empty"><span class="empty-orbit"><svg class="icon"><use href="#i-route"/></svg></span><h3>正在展开搜索树</h3><p>${escapeHtml(ALGORITHMS[algorithm].name)} 正在读取问题卡、图谱和证据路径。</p></div>`;
  try {
    const payload = await requestJson(API.search, {
      method: "POST",
      body: JSON.stringify({
        question: $("#query-input").value.trim(),
        question_id: question?.id ?? null,
        entities: [...state.selectedEntities],
        algorithm,
        max_steps: 24,
      }),
    });
    const initial = normalizeRun(payload, algorithm, question);
    state.run = initial;
    if (initial.status === "pending" || initial.status === "running") {
      state.run = await pollRun(initial.id, algorithm, question);
    }
    state.graphSource = "api";
    setConnection("api", "知识库已连接");
    setSourceNotice("api", `接口已返回 ${ALGORITHMS[algorithm].name} 搜索轨迹。`);
  } catch (error) {
    state.run = localRun(algorithm, question);
    state.graphSource = "fallback";
    setConnection("fallback", "演示数据");
    setSourceNotice("fallback", `接口暂不可用，正在使用明确标注的本地演示轨迹（${error.status ? `HTTP ${error.status}` : "网络未连接"}）。`);
    toast("搜索接口暂不可用，已切换本地演示轨迹。", "error");
  }
  state.trace = state.run.trace;
  state.traceIndex = 0;
  $("#comparison-question").textContent = state.run.question;
  renderTrace();
  setBusy(false);
  startPlayback();
  return state.run;
}

async function pollRun(runId, algorithm, question) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(650);
    const payload = await requestJson(API.searchRun(runId), {}, 12000);
    const run = normalizeRun(payload, algorithm, question);
    if (!["pending", "running", "queued"].includes(run.status)) return run;
  }
  throw new Error("搜索运行超时，请稍后在对照区重试。");
}

async function runComparison() {
  if (state.busy) return;
  setBusy(true);
  const question = state.selectedQuestion;
  const rows = [];
  try {
    for (const algorithm of ["bfs", "astar", "ga_astar", "ga_classifier", "mcts", "llm"]) {
      const payload = await requestJson(API.search, {
        method: "POST",
        body: JSON.stringify({ question: $("#query-input").value.trim(), question_id: question?.id ?? null, entities: [...state.selectedEntities], algorithm, max_steps: 24 }),
      });
      let run = normalizeRun(payload, algorithm, question);
      if (["pending", "running", "queued"].includes(run.status)) run = await pollRun(run.id, algorithm, question);
      rows.push(run);
    }
    setSourceNotice("api", "六种策略已使用同一问题与实体组合完成对照。");
  } catch (error) {
    const fallback = Object.keys(ALGORITHMS).map(algorithm => localRun(algorithm, question));
    rows.splice(0, rows.length, ...fallback);
    setSourceNotice("fallback", `对照接口暂不可用，当前六行均为本地演示数据（${error.status ? `HTTP ${error.status}` : "网络未连接"}）。`);
    toast("对照接口暂不可用，已展示本地演示对照。", "error");
  }
  state.comparisons = rows;
  renderComparison();
  setBusy(false);
  announce("六种策略同题搜索对照已更新。");
}

function startPlayback() {
  if (!state.trace.length) return;
  stopPlayback();
  state.playing = true;
  renderTrace();
  schedulePlayback();
}

function schedulePlayback() {
  clearTimeout(state.playbackTimer);
  if (!state.playing) return;
  if (state.traceIndex >= state.trace.length - 1) {
    state.playing = false;
    renderTrace();
    return;
  }
  const speed = Number($("#trace-speed").value);
  state.playbackTimer = setTimeout(() => {
    if (!state.playing) return;
    state.traceIndex = Math.min(state.trace.length - 1, state.traceIndex + 1);
    renderTrace();
    schedulePlayback();
  }, speed);
}

function stopPlayback() {
  state.playing = false;
  clearTimeout(state.playbackTimer);
}

function togglePlayback() {
  if (!state.trace.length) return;
  if (state.playing) stopPlayback();
  else {
    if (state.traceIndex >= state.trace.length - 1) state.traceIndex = 0;
    state.playing = true;
    schedulePlayback();
  }
  renderTrace();
}

function moveTrace(delta) {
  if (!state.trace.length) return;
  stopPlayback();
  state.traceIndex = Math.max(0, Math.min(state.trace.length - 1, state.traceIndex + delta));
  renderTrace();
}

function renderLinkedAnswer() {
  const root = $("#linked-answer");
  if (!state.run) {
    root.innerHTML = `<b>尚未带入</b><p>完成知识搜索后，可把候选答案与证据一起送入沙盒。</p>`;
    return;
  }
  root.innerHTML = `<b>${escapeHtml(state.run.answer)}</b><p>${escapeHtml(ALGORITHMS[state.run.algorithm].name)} · 置信度 ${formatPercent(state.run.confidence)} · ${state.run.evidence.length} 条证据</p>`;
}

function renderMapRoutes() {
  const routes = [["teaching", "library", 5], ["teaching", "walkway", 4], ["library", "club", 6], ["club", "walkway", 4], ["walkway", "canteen", 5], ["walkway", "venue", 7], ["canteen", "venue", 8]];
  const points = { teaching: [109, 94], library: [333, 66], club: [544, 98], walkway: [224, 242], canteen: [88, 312], venue: [544, 304] };
  const routeRoot = $("#sandbox-routes");
  const labelRoot = $("#sandbox-route-labels");
  routeRoot.replaceChildren();
  labelRoot.replaceChildren();
  routes.forEach(([from, to, minutes]) => {
    const [x1, y1] = points[from];
    const [x2, y2] = points[to];
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M${x1} ${y1}L${x2} ${y2}`);
    path.setAttribute("class", "route");
    routeRoot.append(path);
    const inner = document.createElementNS("http://www.w3.org/2000/svg", "path");
    inner.setAttribute("d", path.getAttribute("d"));
    inner.setAttribute("class", "route-inner");
    routeRoot.append(inner);
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String((x1 + x2) / 2));
    label.setAttribute("y", String((y1 + y2) / 2 - 8));
    label.textContent = `${minutes}′`;
    labelRoot.append(label);
  });
  $$(".map-node", $("#campus-map")).forEach(node => {
    node.style.left = `${node.dataset.x}%`;
    node.style.top = `${node.dataset.y}%`;
  });
}

function renderSandbox() {
  const topic = TOPICS[state.topic];
  $$(".topic-card").forEach(card => card.classList.toggle("is-selected", card.dataset.topic === state.topic));
  $$(".map-node", $("#campus-map")).forEach(node => {
    node.classList.toggle("is-current", node.dataset.place === "teaching");
    node.classList.toggle("is-candidate", node.dataset.place === topic.place);
    node.classList.toggle("is-target", node.dataset.place === "venue");
  });
  $("#xiaxi-marker").hidden = topic.place !== "club";
  $("#clue-marker").hidden = topic.place !== "club";
  $("#sandbox-location").innerHTML = `<svg class="icon"><use href="#i-pin"/></svg>教学楼`;
  $("#map-summary").textContent = state.adopted ? `已采纳：沿教学楼 → 社团室 → 活动会场推进，预留 ${topic.minutes + 7} 分钟。` : `先核对${PLACES[topic.place]}线索，再决定是否前往活动会场。`;
  $("#time-budget-value").textContent = `${$("#time-budget").value} 分钟`;
  const selectedPeople = $$("#people-list input:checked").length;
  const score = Math.min(98, 54 + selectedPeople * 11 + (Number($("#time-budget").value) >= 30 ? 9 : 0) + (state.run ? 8 : 0));
  $("#plan-score").textContent = `适配度 ${score}%`;
  $("#plan-warning p").textContent = state.adopted ? "方案已写入任务，角色现场与路线状态已同步。" : `当前先核实${PLACES[topic.place]}，预计剩余 ${Math.max(0, Number($("#time-budget").value) - topic.minutes)} 分钟；保留到场缓冲。`;
  renderLinkedAnswer();
  renderProofSteps();
}

function renderProofSteps() {
  const ready = {
    search: Boolean(state.run) || state.adopted,
    people: $$("#people-list input:checked").length > 0 || state.adopted,
    resources: Number($("#time-budget").value) >= 20 || state.adopted,
    world: state.adopted,
  };
  $$("#proof-steps li").forEach(item => {
    const key = item.dataset.proof;
    item.classList.toggle("is-ready", ready[key]);
    $("small", item).textContent = state.adopted ? key === "world" ? "已同步" : "已采纳" : ready[key] ? "已就绪" : "待采纳";
  });
  const stateBox = $("#sandbox-state");
  stateBox.classList.toggle("is-adopted", state.adopted);
  $("strong", stateBox).textContent = state.adopted ? "已采纳" : "待配置";
  $("small", stateBox).textContent = state.adopted ? "角色现场已更新" : "尚未采纳";
  $("#adopt-plan").disabled = state.busy || state.adopted;
  $("#adopt-plan span").textContent = state.adopted ? "方案已采纳" : "采纳方案并写入任务";
}

function localAdoption() {
  const topic = TOPICS[state.topic];
  return {
    adoption_id: `local-${Date.now().toString(36)}`,
    status: "adopted",
    topic: state.topic,
    run_id: state.run?.id ?? null,
    evidence_count: state.run?.evidence?.length ?? 0,
    people: $$("#people-list input:checked").map(input => input.value),
    resources: { minutes: Number($("#time-budget").value), travel_mode: $("#travel-mode").value, umbrella: $("#carry-umbrella").checked },
    route: ["teaching", topic.place, "venue"],
    world_state: { task_status: "active", next_place: topic.place, remaining_minutes: Number($("#time-budget").value) },
  };
}

async function adoptPlan() {
  if (state.adopted || state.busy) return;
  setBusy(true);
  const status = $("#adopt-status");
  status.dataset.state = "loading";
  $("span", status).textContent = "正在提交方案…";
  const payload = {
    question: $("#query-input").value.trim(),
    question_id: state.selectedQuestion?.id ?? null,
    run_id: state.run?.id ?? null,
    topic: state.topic,
    evidence_ids: state.run?.evidence?.map(item => item.source || item.title) ?? [],
    people: $$("#people-list input:checked").map(input => input.value),
    resources: { minutes: Number($("#time-budget").value), travel_mode: $("#travel-mode").value, umbrella: $("#carry-umbrella").checked },
  };
  try {
    const response = await requestJson(API.adopt, { method: "POST", body: JSON.stringify(payload) });
    state.adoption = response?.data ?? response;
    state.adopted = true;
    status.dataset.state = "success";
    $("span", status).textContent = "采纳成功，角色现场已同步";
    setSourceNotice("api", "校园方案已采纳，服务端回执和角色状态已更新。");
  } catch (error) {
    state.adoption = localAdoption();
    state.adopted = true;
    status.dataset.state = "success";
    $("span", status).textContent = "本地演示已采纳；服务端回执待接入";
    setSourceNotice("fallback", `采纳接口暂不可用，当前回执为本地演示（${error.status ? `HTTP ${error.status}` : "网络未连接"}）。`);
    toast("采纳接口暂不可用，已用本地演示展示状态变化。", "error");
  }
  renderReceipt();
  renderSandbox();
  updateRoleScene();
  setBusy(false);
  announce("方案已采纳，校园路线与角色现场已更新。");
}

function renderReceipt() {
  const adoption = state.adoption;
  $("#receipt-state").textContent = state.adopted ? "已写入" : "未生成";
  $("#receipt-topic").textContent = TOPICS[state.topic].name;
  $("#receipt-run").textContent = state.run?.id ?? "—";
  $("#receipt-evidence").textContent = `${adoption?.evidence_count ?? state.run?.evidence?.length ?? 0} 条`;
  $("#receipt-id").textContent = adoption?.adoption_id ?? adoption?.receipt_id ?? adoption?.id ?? "—";
  $("#receipt-note").textContent = state.adopted ? (adoption?.message ?? "方案已写入校园任务；路线、资源与角色现场已同步。") : "采纳成功后在此显示服务端回执与状态变化。";
}

function updateRoleScene() {
  const topic = TOPICS[state.topic];
  $("#role-location").textContent = state.adopted ? `正在前往${PLACES[topic.place]}` : `可能位于${PLACES[topic.place]}`;
  $("#role-copy").textContent = state.adopted ? `方案已采纳。玩家将从教学楼出发，先到${PLACES[topic.place]}核实，再前往活动会场。` : `${PLACES[topic.place]}线索较新，旧照片来自更早时间。先核实再行动。`;
  $("#role-time").textContent = `剩余 ${$("#time-budget").value} 分钟`;
  $("#role-place").textContent = PLACES[topic.place];
  $("#role-state-dot").style.background = state.adopted ? "var(--green)" : "var(--gold)";
  if (state.adopted) {
    $("#role-events").innerHTML = `<li><span>${state.adoption?.adoption_id ? "回执" : "已采纳"}</span><p>方案写入校园任务，${PLACES[topic.place]}成为下一核实地点。</p></li><li><span>路线</span><p>教学楼 → ${PLACES[topic.place]} → 活动会场，行动时间已预留。</p></li><li><span>当前</span><p>角色现场已进入执行状态，等待下一步动作。</p></li>`;
  }
}

function switchView(view) {
  state.view = view;
  document.body.dataset.view = view;
  $("#search").hidden = view !== "search";
  $("#sandbox").hidden = view !== "sandbox";
  $$("[data-view-target]").forEach(button => {
    const active = button.dataset.viewTarget === view;
    button.classList.toggle("is-active", active);
    if (button.closest(".main-nav")) {
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  });
  if (view === "sandbox") renderSandbox();
  window.scrollTo({ top: 0, behavior: "smooth" });
  announce(view === "search" ? "已切换到知识搜索" : "已切换到校园任务沙盒");
}

function openRolePanel() {
  const drawer = $("#role-drawer");
  drawer.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  setTimeout(() => $("#close-role-panel").focus(), 20);
}

function closeRolePanel() {
  const drawer = $("#role-drawer");
  drawer.classList.remove("is-open");
  drawer.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  $("#open-role-panel").focus();
}

async function loadSources() {
  // 重试时先移除旧数据，避免把上一次接口结果误标成当前实时状态。
  state.graph = null;
  state.questions = [];
  setConnection("loading", "正在连接知识库");
  setSourceNotice("loading", "正在读取问题卡与知识图谱…");
  $("#graph-status").textContent = "读取中";
  $("#graph-status").dataset.state = "loading";
  const results = await Promise.allSettled([
    requestJson(API.graph, {}, 9000),
    requestJson(API.questions, {}, 9000),
  ]);
  let apiCount = 0;
  if (results[0].status === "fulfilled") {
    const graph = normalizeGraph(results[0].value);
    if (graph.nodes.length) {
      state.graph = graph;
      state.graphSource = "api";
      apiCount += 1;
    }
  }
  if (!state.graph) {
    state.graph = clone(FALLBACK_GRAPH);
    state.graphSource = "fallback";
  }
  if (results[1].status === "fulfilled") {
    const questions = normalizeQuestions(results[1].value);
    if (questions.length) {
      state.questions = questions;
      apiCount += 1;
    }
  }
  if (!state.questions.length) state.questions = clone(FALLBACK_QUESTIONS);
  state.selectedQuestion = state.questions[0];
  state.selectedEntities = new Set(state.selectedQuestion.entities?.length ? state.selectedQuestion.entities : ["model:attention", "paper:attention", "method:attention"]);
  $("#query-input").value = state.selectedQuestion.query;
  renderQuestions();
  renderEntityChips();
  renderGraph();
  graphStats();
  $("#graph-status").textContent = state.graphSource === "api" ? "实时图谱" : "演示图谱";
  $("#graph-status").dataset.state = state.graphSource === "api" ? "online" : "fallback";
  if (apiCount === 2) {
    setConnection("api", "知识库已连接");
    setSourceNotice("api", "问题卡与知识图谱已从接口载入。");
  } else if (apiCount === 1) {
    setConnection("fallback", "部分接口可用");
    setSourceNotice("fallback", "问题卡或知识图谱只有一项可用；缺失部分以演示数据补齐。");
  } else {
    setConnection("fallback", "演示数据");
    setSourceNotice("fallback", "搜索接口尚未就绪；当前显示明确标注的本地演示问题卡与图谱，运行搜索仍会优先请求接口。");
  }
}

function bindEvents() {
  $$("[data-view-target]").forEach(button => button.addEventListener("click", () => switchView(button.dataset.viewTarget)));
  $("#query-form").addEventListener("submit", event => {
    event.preventDefault();
    runSearch();
  });
  $$("input[name=\"algorithm\"]").forEach(input => input.addEventListener("change", () => {
    state.algorithm = input.value;
    renderAlgorithmSummary();
    if (state.trace.length) {
      state.run = null;
      state.trace = [];
      state.traceIndex = 0;
      renderTrace();
    }
  }));
  $("#graph-filter").addEventListener("input", renderGraph);
  $("#reset-graph").addEventListener("click", () => {
    $("#graph-filter").value = "";
    state.selectedEntities = new Set();
    renderEntityChips();
    renderGraph();
  });
  $("#refresh-sources").addEventListener("click", loadSources);
  $("#run-comparison").addEventListener("click", runComparison);
  $("#trace-prev").addEventListener("click", () => moveTrace(-1));
  $("#trace-next").addEventListener("click", () => moveTrace(1));
  $("#trace-play").addEventListener("click", togglePlayback);
  $("#trace-timeline").addEventListener("input", event => {
    stopPlayback();
    state.traceIndex = Number(event.target.value);
    renderTrace();
  });
  $("#trace-speed").addEventListener("change", () => {
    if (state.playing) schedulePlayback();
  });
  $("#send-to-sandbox").addEventListener("click", () => {
    if (!state.run) return;
    switchView("sandbox");
    toast("搜索结论与证据已带入校园沙盒。");
  });
  $$(".topic-card").forEach(card => card.addEventListener("click", () => {
    state.topic = card.dataset.topic;
    state.adopted = false;
    state.adoption = null;
    $("#adopt-status").dataset.state = "";
    $("#adopt-status span").textContent = "等待采纳";
    renderReceipt();
    renderSandbox();
    updateRoleScene();
  }));
  $$("#people-list input, #time-budget, #travel-mode, #carry-umbrella").forEach(input => input.addEventListener("change", renderSandbox));
  $("#time-budget").addEventListener("input", renderSandbox);
  $("#adopt-plan").addEventListener("click", adoptPlan);
  $("#open-role-panel").addEventListener("click", openRolePanel);
  $("#mobile-role").addEventListener("click", openRolePanel);
  $("#close-role-panel").addEventListener("click", closeRolePanel);
  $("[data-close-role]").addEventListener("click", closeRolePanel);
  $("#drawer-open-sandbox").addEventListener("click", () => {
    closeRolePanel();
    switchView("sandbox");
  });
  $("#focus-graph")?.addEventListener("click", () => $("#graph-panel").scrollIntoView({ behavior: "smooth", block: "center" }));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && $("#role-drawer").classList.contains("is-open")) closeRolePanel();
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      runSearch();
    }
    if (document.activeElement === $("#trace-timeline")) {
      if (event.key === "ArrowLeft") moveTrace(-1);
      if (event.key === "ArrowRight") moveTrace(1);
    }
  });
}

async function init() {
  renderMapRoutes();
  bindEvents();
  renderAlgorithmSummary();
  renderComparison();
  renderReceipt();
  renderSandbox();
  await loadSources();
}

init().catch(error => {
  console.error(error);
  setConnection("fallback", "界面已降级");
  setSourceNotice("error", `页面初始化失败：${error.message}`);
  toast("页面初始化失败，请刷新后重试。", "error");
});
