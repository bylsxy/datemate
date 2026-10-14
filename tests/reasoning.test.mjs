import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardChain, queryGraph, buildKnowledgeGraph, DEFAULT_RULES, canonical } from '../reasoning.mjs';

test('前向链在下一轮消费派生事实，并保存真实输入输出轨迹', () => {
  const rules = [
    { id: 'consume', priority: 10, when: { all: [{ fact: 'derived.ready', op: 'eq', value: true }] }, then: [{ action: 'exclude_scene' }], evidenceIds: ['E1'] },
    { id: 'derive', priority: 1, when: { all: [{ fact: 'context.weather', op: 'eq', value: 'rain' }] }, then: [{ action: 'set_fact', fact: 'derived.ready', value: true }] },
  ];
  const initial = { context: { weather: 'rain' }, scene: { id: 'outside' } };
  const result = forwardChain(initial, rules);
  assert.deepEqual(result.excludedSceneIds, ['outside']);
  assert.deepEqual(result.trace.map(t => [t.ruleId, t.round]), [['derive', 1], ['consume', 2]]);
  assert.deepEqual(result.trace[1].inputFacts, [{ id: 'derived.ready', value: true }]);
  assert.deepEqual(initial, { context: { weather: 'rain' }, scene: { id: 'outside' } });
  assert.equal(result.saturated, true);
});

test('unknown、缺失和false不会混同，已禁用规则不触发', () => {
  const make = (id, op, value) => ({ id, when: { all: [{ fact: 'context.quiet', op, value }] }, then: [{ action: 'set_fact', fact: `derived.${id}`, value: true }] });
  const rules = [make('negative', 'neq', true), make('false', 'eq', false), { ...make('disabled', 'exists', true), enabled: false }];
  assert.equal(forwardChain({ context: {} }, rules).trace.length, 0);
  assert.equal(forwardChain({ context: { quiet: { status: 'unknown' } } }, rules).trace.length, 0);
  assert.deepEqual(forwardChain({ context: { quiet: false } }, rules).trace.map(t => t.ruleId), ['false', 'negative']);
});

test('规则行动按当前场景活动执行，偏好、准备、警告均有输出事实', () => {
  const result = forwardChain({ scene: { id: 'mall' }, activity: { id: 'play', tags: ['play'] }, context: { prefs: ['play'] } }, [{ id: 'rule', when: { all: [{ fact: 'activity.tags', op: 'intersects', value: ['play'] }, { fact: 'context.prefs', op: 'contains', value: 'play' }] }, then: [{ action: 'prefer_scene', amount: 5 }, { action: 'prefer_activity', amount: 7 }, { action: 'require_preparation', preparationId: 'ball' }, { action: 'add_warning', message: '确认场地' }] }]);
  assert.equal(result.scenePreferences.mall, 5);
  assert.equal(result.activityPreferences.play, 7);
  assert.deepEqual(result.requiredPreparations, ['ball']);
  assert.deepEqual(result.warnings, ['确认场地']);
  assert.equal(result.trace[0].outputFacts.length, 4);
});

test('内置雨天规则分两步推导淋雨风险与警告，阴天不触发且不硬排除', () => {
  const rain = forwardChain({ context: { weather: 'rain' }, scene: { id: 'walk', indoor: false }, state: { maxLoad: 2 } }, DEFAULT_RULES);
  assert.deepEqual(rain.excludedSceneIds, []);
  assert.equal(rain.facts['derived.wetRisk'], true);
  assert.ok(rain.trace.some(t => t.ruleId === 'CORE_WET_WARNING' && t.round === 2));
  assert.equal(rain.warnings.length, 1);
  const cloudy = forwardChain({ context: { weather: 'cloudy' }, scene: { id: 'walk', indoor: false }, state: { maxLoad: 2 } }, DEFAULT_RULES);
  assert.deepEqual(cloudy.excludedSceneIds, []);
  assert.equal(cloudy.warnings.length, 0);
});

test('图谱支持多跳、证据合并、深度界限和有环图终止', () => {
  const graph = { edges: [{ id: '1', subject: 'scene', object: 'activity', predicate: 'supports', evidenceIds: ['E1'] }, { id: '2', subject: 'activity', object: 'tag', predicate: 'has', evidenceIds: ['E2'] }, { id: '3', subject: 'tag', object: 'goal', predicate: 'serves', evidenceIds: ['E2'] }, { id: '4', subject: 'tag', object: 'scene', predicate: 'cycle' }] };
  assert.equal(queryGraph(graph, 'scene', 'goal', { maxDepth: 2 }).length, 0);
  const paths = queryGraph(graph, 'scene', 'goal', { maxDepth: 3 });
  assert.deepEqual(paths[0].nodes, ['scene', 'activity', 'tag', 'goal']);
  assert.deepEqual(paths[0].evidenceIds, ['E1', 'E2']);
  assert.equal(queryGraph(graph, 'scene', 'missing').length, 0);
});

test('显式标签构成可查询的场景—属性—偏好路径，输入图谱不变', () => {
  const catalog = { scenes: [{ id: 'walk', tags: ['nature'], evidenceIds: ['E1'], activities: [{ id: 'photo', tags: ['photo'], evidenceIds: ['E2'] }] }], graph: { nodes: [], edges: [] } };
  const before = canonical(catalog);
  const graph = buildKnowledgeGraph(catalog);
  assert.deepEqual(queryGraph(graph, 'walk', 'preference:nature')[0].nodes, ['walk', 'tag:nature', 'preference:nature']);
  assert.equal(queryGraph(graph, 'walk', 'preference:photo')[0].edges.length, 3);
  assert.equal(canonical(catalog), before);
});
