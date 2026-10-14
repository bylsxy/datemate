import test from 'node:test';
import assert from 'node:assert/strict';
import { loadKnowledge, compileKnowledge, serializeArtifacts } from '../tools/build_catalog.mjs';

const input = await loadKnowledge();
const changed = mutate => { const copy = structuredClone(input); mutate(copy.documents); return copy; };
const compiled = compileKnowledge(input);

test('露营是显式跨午夜分别方式，费用按双人一晚设计并进入图谱', () => {
  const camping = compiled.catalog.departures.find(item => item.id === 'camping');
  assert.equal(camping.onlyOvernight, true);
  assert.equal(camping.requiresExplicitChoice, true);
  assert.equal(camping.costUnit, 'CNY_for_two_per_night');
  assert.deepEqual(camping.cost, [120, 300]);
  assert.equal(compiled.catalog.defaultDepartureId, 'separate');
  assert.ok(!compiled.catalog.scenes.some(scene => scene.id === 'camping'));
  const node = compiled.graph.nodes.find(node => node.id === 'camping');
  assert.equal(node.type, 'departure');
  assert.deepEqual(node.cost, camping.cost);
  assert.ok(compiled.graph.edges.some(edge => edge.subject === 'camping' && edge.predicate === 'supported_by'));
});

test('露营限制、费用精度和分别方式登记接受严格校验', () => {
  const edit = mutate => changed(docs => mutate(docs.departures.departures.find(item => item.id === 'camping')));
  for (const flag of ['onlyOvernight', 'requiresExplicitChoice']) assert.throws(() => compileKnowledge(edit(item => item[flag] = false)), /跨午夜.*明确选择/);
  for (const cost of [[-1, 20], [30, 20], [0, 0.001], [0], 'free']) assert.throws(() => compileKnowledge(edit(item => item.cost = cost)), /费用区间/);
  assert.throws(() => compileKnowledge(changed(docs => docs.conditions.conditions.find(item => item.key === 'departureChoice').allowedValues.pop())), /四种离开选择/);
});

test('新场景字段保留到运行目录和图谱，旧场景有兼容默认值', () => {
  const custom = compileKnowledge(changed(docs => Object.assign(docs.scenes.scenes[0], { socialDemand: 3, dreamOnly: true, costByWeekPart: { weekday: [1, 2], weekend: [3, 4] } })));
  const id = input.documents.scenes.scenes[0].id;
  const scene = custom.catalog.scenes.find(item => item.id === id);
  const node = custom.graph.nodes.find(item => item.id === id);
  assert.equal(scene.socialDemand, 3); assert.equal(scene.dreamOnly, true);
  assert.deepEqual(node.costByWeekPart, scene.costByWeekPart);
  assert.equal(node.socialDemand, 3); assert.equal(node.dreamOnly, true);
  assert.ok(custom.graph.edges.some(edge => edge.subject === id && edge.predicate === 'has_socialDemand'));
  const legacy = compileKnowledge(changed(docs => { const scene = docs.scenes.scenes[0]; delete scene.socialDemand; delete scene.dreamOnly; delete scene.costByWeekPart; })).catalog.scenes.find(item => item.id === id);
  assert.equal(legacy.socialDemand, 1); assert.equal(legacy.dreamOnly, false);
  assert.deepEqual(legacy.costByWeekPart, { weekday: legacy.cost, weekend: legacy.cost });
});

test('新场景字段拒绝错误类型、越界需求及不完整周内费用', () => {
  for (const socialDemand of [-1, 4, 1.5, '1']) assert.throws(() => compileKnowledge(changed(docs => docs.scenes.scenes[0].socialDemand = socialDemand)), /socialDemand/);
  assert.throws(() => compileKnowledge(changed(docs => docs.scenes.scenes[0].dreamOnly = 'false')), /dreamOnly/);
  assert.throws(() => compileKnowledge(changed(docs => docs.scenes.scenes[0].costByWeekPart = { weekday: [0, 0] })), /costByWeekPart/);
  assert.throws(() => compileKnowledge(changed(docs => docs.scenes.scenes[0].costByWeekPart = null)), /costByWeekPart/);
  assert.throws(() => compileKnowledge(changed(docs => docs.scenes.scenes[0].costByWeekPart = { weekday: [0, 0], weekend: [5, 2] })), /费用区间/);
});

test('活动 socialDemand 保留在 featureValues 与图谱并拒绝无效值', () => {
  const id = input.documents.activities.activities[0].id;
  const custom = compileKnowledge(changed(docs => docs.activities.activities[0].socialDemand = 3));
  const activity = custom.catalog.activities.find(item => item.id === id);
  assert.equal(activity.socialDemand, 3); assert.equal(activity.featureValues.socialDemand, 3);
  assert.equal(custom.graph.nodes.find(node => node.id === id).socialDemand, 3);
  assert.ok(custom.graph.edges.some(edge => edge.subject === id && edge.predicate === 'has_socialDemand' && edge.object === 'value:socialDemand:3'));
  for (const value of [-1, 4, 1.5, '1', null]) assert.throws(() => compileKnowledge(changed(docs => docs.activities.activities[0].socialDemand = value)), /socialDemand/);
});

test('天气 cloudy 和旧 unknown 均合法，自动天气保留阴天', () => {
  const id = input.documents.scenes.scenes[0].id;
  for (const weather of [['cloudy'], ['unknown'], ['clear', 'rain', 'unknown']]) assert.deepEqual(compileKnowledge(changed(docs => docs.scenes.scenes[0].weather = weather)).catalog.scenes.find(item => item.id === id).weather, weather);
  assert.ok(compileKnowledge(changed(docs => { docs.scenes.scenes[0].weather = []; })).catalog.scenes.find(item => item.id === id).weather.includes('cloudy'));
  assert.throws(() => compileKnowledge(changed(docs => docs.scenes.scenes[0].weather = ['cloudy', 'cloudy'])), /weather/);
});

test('饮食冷食与易上火标签兼容生食和辣味，编译选项和图谱均保留', () => {
  const tags = ['cold', 'heaty', 'raw', 'spicy'];
  const result = compileKnowledge(changed(docs => docs.activities.activities[0].dietaryTags = tags));
  const id = input.documents.activities.activities[0].id;
  assert.deepEqual(result.catalog.activities.find(item => item.id === id).dietaryTags, tags);
  for (const tag of tags) assert.ok(result.graph.edges.some(edge => edge.subject === id && edge.object === 'dietary:' + tag));
  const module = serializeArtifacts(result)['activities.mjs'];
  assert.match(module, /"id":"heaty"/);
  assert.ok(result.conditions.find(item => item.key === 'dietaryRestrictions').allowedValues.includes('heaty'));
});

test('情境条件及产生式的判断和动作有可查询图谱内容', () => {
  const values = Object.fromEntries(compiled.conditions.map(item => [item.key, item]));
  assert.deepEqual(values.weekPart.allowedValues, ['weekday', 'weekend']);
  assert.deepEqual(values.relationship.allowedValues, ['any', 'first', 'flirting', 'passionate', 'stable', 'longterm']);
  assert.equal(values.reunion.type, 'boolean');
  for (const key of ['cyclePhase', 'mood', 'energy', 'season', 'mentalDemand', 'occasion', 'planStyle', 'themes', 'personalityA', 'personalityB']) assert.ok(compiled.graph.nodes.some(node => node.id === 'fact:context.' + key && node.type === 'input_condition'));
  assert.equal(values.personalityA.allowedValues.length, 17);
  assert.deepEqual(values.personalityB.allowedValues, values.personalityA.allowedValues);
  assert.equal(values.themes.type, 'set');
  assert.deepEqual(values.themes.allowedValues, ['chinese', 'japanese', 'romantic', 'fresh']);
  const rule = compiled.rules.find(item => (item.when.all?.length || item.when.any?.length) && item.then.length);
  const node = compiled.graph.nodes.find(item => item.id === rule.id);
  assert.deepEqual(node.when, rule.when); assert.deepEqual(node.then, rule.then);
  assert.ok(compiled.graph.edges.some(edge => edge.subject === rule.id && edge.predicate === 'tests_fact'));
  assert.ok(compiled.graph.edges.some(edge => edge.subject === rule.id && edge.predicate === 'produces_action'));
  assert.throws(() => compileKnowledge(changed(docs => docs.conditions.conditions.find(item => item.key === 'weekPart').default = 'holiday')), /default/);
  assert.throws(() => compileKnowledge(changed(docs => docs.rules.rules[0].when = { all: [{ fact: 'context.relationship', op: 'eq', value: 'unknown_stage' }] })), /条件值未登记/);
});

test('新增标签全部登记且 ID 片段条件与完整引用分别验证', () => {
  const docs = input.documents;
  const tags = new Set(docs.metadata.interestTags);
  for (const item of [...docs.scenes.scenes, ...docs.activities.activities, ...docs.scenes.scenes.flatMap(scene => Object.values(scene.activityOverrides ?? {}))]) for (const tag of item.tags ?? []) assert.ok(tags.has(tag), `未登记标签 ${tag}`);
  for (const tag of ['dream', 'travel', 'celebration', 'confession', 'shared_hobby', 'private', 'night', 'japanese', 'chinese', 'outdoor']) assert.ok(docs.metadata.interestOptions.some(option => option.id === tag));
  assert.doesNotThrow(() => compileKnowledge(changed(docs => docs.rules.rules[0].when = { all: [{ fact: 'scene.id', op: 'contains', value: 'dorm' }] })));
  assert.throws(() => compileKnowledge(changed(docs => docs.rules.rules[0].when = { all: [{ fact: 'scene.id', op: 'eq', value: 'unknown_scene_id' }] })), /条件引用无效/);
});
