import os from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { createPlanner, VERSION, CONFIG } from '../engine.mjs';
import { defaultContext } from '../planner.mjs';
import { catalog, rules, graph } from '../data/catalog.mjs';

const planner = createPlanner({ ...catalog, rules, graph });
const base = defaultContext();
const shared = { ...base, preferencesA: ['nature', 'photo'], preferencesB: ['nature', 'photo'] };
const mallThree = [{ sceneId: 'mall', activityIds: ['mall_arcade', 'mall_stores', 'mall_snacks'] }];
const scenarios = [
  { id: 'default', context: base },
  { id: 'shared-nature-photo', context: shared },
  { id: 'shared-clear', context: { ...shared, weather: 'clear' } },
  { id: 'shared-rain', context: { ...shared, weather: 'rain' } },
  { id: 'shared-rain-fatigue8', context: { ...shared, weather: 'rain', fatigueA: 8, fatigueB: 8 } },
  { id: 'shared-rain-fatigue9', context: { ...shared, weather: 'rain', fatigueA: 9, fatigueB: 9 } },
  { id: 'shared-rain-budget0', context: { ...shared, weather: 'rain', budget: 0 } },
  { id: 'shared-rain-budget20', context: { ...shared, weather: 'rain', budget: 20 } },
  { id: 'shared-rain-budget50', context: { ...shared, weather: 'rain', budget: 50 } },
  { id: 'mall-one', context: shared, prefix: [{ sceneId: 'mall', activityIds: ['mall_arcade'] }] },
  { id: 'mall-two', context: shared, prefix: [{ sceneId: 'mall', activityIds: ['mall_arcade', 'mall_stores'] }] },
  { id: 'mall-three', context: shared, prefix: mallThree },
  { id: 'mall-cleared', context: shared, prefix: [{ sceneId: 'mall', activityIds: [] }] },
  { id: 'shared-explore90', context: shared, exploration: 90 },
  { id: 'shared-explore0-restored', context: shared, exploration: 0 },
  { id: 'rain-explore90', context: { ...shared, weather: 'rain' }, exploration: 90 },
  { id: 'different-interests', context: { ...base, preferencesA: ['culture', 'learning'], preferencesB: ['play', 'music'] } },
  { id: 'meal-required', context: { ...base, mealNeed: true } },
  { id: 'two-windows', context: { ...shared, duration: 240, windows: [{ id: 'pm', startMinute: 840, endMinute: 960 }, { id: 'eve', startMinute: 1080, endMinute: 1200 }], mealNeed: true } },
  { id: 'timed-anchor', context: { ...base, anchors: [{ id: 'booking', choice: { sceneId: 'mall', activityIds: [] }, windowId: 'default', startMinute: 930, index: 1 }] } },
];

// 预热与计时相分离；performance只测工具脚本，不进入规划请求。
for (let i = 0; i < 5; i++) assert.equal(planner.plan(base, 0).ok, true);
const measured = [];
for (const scenario of scenarios) {
  const started = performance.now();
  const result = planner.plan(scenario.context, scenario.exploration || 0, scenario.prefix || []);
  const elapsedMs = performance.now() - started;
  assert.equal(result.ok, true, `${scenario.id}: ${result.errors.join(';')}`);
  assert.ok(result.stages.every(s => s.after.fatigue.every(f => f <= result.context.maxLoad)));
  assert.ok(result.stages.every(s => result.context.windows.some(w => s.start >= w.startMinute && s.end + s.reserve <= w.endMinute)));
  assert.ok(result.context.budgetHighCents === null || result.totalCostCents[1] <= result.context.budgetHighCents);
  if (scenario.context.weather === 'rain') assert.ok(result.stages.every(s => catalog.scenes.find(x => x.id === s.sceneId).indoor === true));
  measured.push({ id: scenario.id, input: scenario.context, exploration: scenario.exploration || 0, fixedPrefix: scenario.prefix || [], elapsedMs: +elapsedMs.toFixed(3), status: result.status, outputDigest: result.outputFingerprint, stageCount: result.stages.length, scenes: result.stages.map(s => s.sceneId), stages: result.stages.map(s => ({ sceneId: s.sceneId, activityIds: s.activityIds, startMinute: s.start, endMinute: s.end, loadBefore: s.before.fatigue, loadAfter: s.after.fatigue, costCents: s.costCents, reserveMinutes: s.reserve, ruleIds: [...new Set(s.trace.map(t => t.ruleId))] })), metrics: result.metrics, candidateCount: result.stages[0].candidates.length, search: result.search });
}
const durations = measured.map(r => r.elapsedMs).sort((a, b) => a - b);
const percentile = p => durations[Math.max(0, Math.ceil(durations.length * p) - 1)];
const byId = id => measured.find(r => r.id === id);
assert.equal(byId('shared-nature-photo').outputDigest, byId('shared-explore0-restored').outputDigest);
assert.equal(byId('mall-three').stages[1].sceneId, 'rest');
assert.equal(byId('mall-three').stages[0].loadAfter[0], 10);
assert.ok(byId('shared-rain-fatigue9').stages.some(s => s.sceneId === 'rest'));
assert.notEqual(byId('shared-nature-photo').outputDigest, byId('shared-explore90').outputDigest);
const cpu = os.cpus();
const report = {
  protocol: { warmupRuns: 5, measuredRuns: 20, repetitionsPerScenario: 1, percentileMethod: 'nearest_rank', timingScope: '本机桌面Node同步规划，包括目录编译、搜索、规则、图谱、候选与Pareto；不含浏览器Worker通信和页面渲染。', interpretation: '20种固定请求各测一次；本批p95不能表示单一输入的长期p95，也不是手机或浏览器测试结果。' },
  environmentFile: 'benchmark-environment.json',
  versions: { engine: VERSION, score: CONFIG.scoreVersion, knowledge: catalog.version },
  counts: { scenes: catalog.scenes.length, activities: catalog.activities.length, rules: rules.length, graphEdges: graph.edges.length },
  summary: { p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: durations.at(-1), minMs: durations[0], meanMs: +(durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(3), allFeasible: measured.every(r => r.status === 'feasible'), provedOptimal: false, nodeLimitedCases: measured.filter(r => r.search.nodeBudgetReached).map(r => r.id) },
  observations: measured,
};
const environment = { node: process.version, platform: process.platform, architecture: process.arch, osType: os.type(), osRelease: os.release(), cpuModel: cpu[0]?.model || 'unknown', logicalCpuCount: cpu.length, totalMemoryGiB: +(os.totalmem() / 1024 ** 3).toFixed(2), benchmarkProtocol: report.protocol };
const output = fileURLToPath(new URL('./reports/benchmark.json', import.meta.url));
const environmentOutput = fileURLToPath(new URL('./reports/benchmark-environment.json', import.meta.url));
mkdirSync(fileURLToPath(new URL('./reports/', import.meta.url)), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2));
writeFileSync(environmentOutput, JSON.stringify(environment, null, 2));
console.log(JSON.stringify({ output, environmentOutput, environment, summary: report.summary }, null, 2));
