import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { catalog } from '../data/catalog.mjs';
import { planDate, normalize } from '../engine.mjs';
import { availablePreparationIds, availablePreparationResources, defaultPreparationResources, planPreparations, INTERNAL_PREPARATION_IDS } from '../preparation.mjs';

const stage = (sceneId, activityIds = []) => ({ sceneId, activityIds });
const scene = (id, extra = {}) => ({ id, title: id, minutes: 20, cost: [0, 0], load: 0, kind: id, area: 'campus', indoor: true, tags: [], activities: [], ...extra });
const activity = (id, extra = {}) => ({ id, title: id, cost: [0, 0], load: 0, group: 'play', mode: 'multi', ...extra });
const source = (scenes, ids = ['water', 'paper_pen', 'craft_kit', 'picnic_pack']) => ({ scenes, preparationOptions: ids.map(id => ({ id, label: `准备${id}` })) });
const quantities = preparations => Object.fromEntries(preparations.map(item => [item.id, item.quantity]));
const initialContext = data => ({ duration: 300, reserve: 0, robust: false, fatigueA: 0, fatigueB: 0, preparedIds: availablePreparationIds(data), resources: availablePreparationResources(data) });

test('上下文入口同时返回白名单与足量库存，可直接用于初始化和请求', () => {
  const context = defaultPreparationResources(catalog);
  assert.deepEqual(context.preparedIds, availablePreparationIds(catalog));
  assert.deepEqual(context.resources, availablePreparationResources(catalog));
  assert.equal(context.resources.craft_kit, 25);
  assert.equal(context.resources.picnic_pack, 25);
  for (const id of INTERNAL_PREPARATION_IDS) assert.equal(context.resources[id], undefined);
  context.resources.craft_kit = 0;
  assert.equal(defaultPreparationResources(catalog).resources.craft_kit, 25);
});

test('真实 metadata 白名单只排除六个行程成果，并保留可自行准备的野餐食物', async () => {
  const metadata = JSON.parse(await readFile(new URL('../knowledge/metadata.json', import.meta.url), 'utf8'));
  const knowledge = JSON.parse(await readFile(new URL('../knowledge/activities.json', import.meta.url), 'utf8'));
  const produced = new Set(knowledge.activities.flatMap(item => item.provides || []));
  assert.deepEqual([...produced].filter(id => id !== 'picnic_pack').sort(), [...INTERNAL_PREPARATION_IDS].sort());
  assert.deepEqual(availablePreparationIds(catalog), metadata.preparationOptions.filter(item => !INTERNAL_PREPARATION_IDS.includes(item.id)).map(item => item.id).sort());
  assert.ok(availablePreparationIds(catalog).includes('picnic_pack'));
  assert.equal(availablePreparationIds(catalog).length, 16);
});

test('未知前置项不会自动加入白名单；新的前序产出也不会进入默认库存', () => {
  const data = source([scene('s', { preparationIds: ['unlisted'], activities: [activity('make', { provides: ['new_result'] })] })], ['water', 'new_result', 'meal_completed']);
  assert.deepEqual(availablePreparationIds(data), ['water']);
  assert.deepEqual(availablePreparationResources(data), { water: 1 });
  assert.deepEqual(planPreparations([stage('s')], data), []);
});

test('真实完整阶段清单包含场景与所选活动，按 ID 去重并保留使用阶段', () => {
  const stages = [stage('campus'), stage('agriculture_museum'), stage('campus_tabletennis', ['pingpong_teach', 'pingpong_rally']), stage('craft', ['craft_card']), stage('craft', ['craft_card'])];
  const preparations = planPreparations(stages, catalog);
  assert.deepEqual(quantities(preparations), { ball: 1, craft_kit: 2, opening_checked: 1, racket: 1, water: 1 });
  assert.deepEqual(preparations.find(item => item.id === 'craft_kit'), { id: 'craft_kit', label: '一份手作材料', quantity: 2, stageIndexes: [3, 4] });
  assert.deepEqual(preparations.find(item => item.id === 'racket').stageIndexes, [2]);
});

test('不读取未选玩法、候选项或默认活动，清空玩法后只留下场景要求', () => {
  const stages = [{ ...stage('campus_tabletennis'), candidates: [stage('craft', ['craft_card'])], preparationIds: ['craft_kit'] }];
  assert.deepEqual(planPreparations(stages, catalog), []);
  assert.deepEqual(planPreparations([], catalog), []);
  assert.deepEqual(quantities(planPreparations([stage('campus_picnic')], catalog)), { picnic_mat: 1, water: 1 });
});

test('真实玻璃房桌游覆盖要求生效，不向其他场地的同 ID 活动扩散', () => {
  assert.deepEqual(quantities(planPreparations([stage('taishan_glass', ['boardgame_coop'])], catalog)), { boardgame_kit: 1, venue_checked: 1 });
  const ordinary = catalog.scenes.find(item => item.id !== 'taishan_glass' && item.activities.some(a => a.id === 'boardgame_coop'));
  assert.ok(ordinary);
  assert.deepEqual(planPreparations([stage(ordinary.id, ['boardgame_coop'])], catalog), []);
});

test('真实采购→分享由已选前序供给；第二次分享只需额外准备一份', () => {
  const purchased = [stage('supermarket', ['purchase_picnic']), stage('campus_picnic', ['picnic_share'])];
  assert.deepEqual(quantities(planPreparations(purchased, catalog)), { picnic_mat: 1, water: 1 });
  const repeated = [...purchased, stage('campus_picnic', ['picnic_share'])];
  assert.deepEqual(planPreparations(repeated, catalog).find(item => item.id === 'picnic_pack'), { id: 'picnic_pack', label: '一份野餐食物', quantity: 1, stageIndexes: [1, 2] });
  assert.equal(quantities(planPreparations([stage('campus_picnic', ['picnic_share'])], catalog)).picnic_pack, 1);
});

test('后续采购不能追溯满足更早的使用；产出与消耗均按数量核算', () => {
  const data = source([scene('eat', { consumes: { picnic_pack: 3 } }), scene('buy', { provides: { picnic_pack: 2 } })]);
  assert.equal(quantities(planPreparations([stage('eat'), stage('buy'), stage('eat')], data)).picnic_pack, 4);
  assert.equal(quantities(planPreparations([stage('buy'), stage('eat')], data)).picnic_pack, 1);
});

test('数组与计数字典混合要求取最大值，耗材累计而工具可复用', () => {
  const data = source([scene('s', { preparationIds: ['water', 'water'], requires: { water: 2 }, preconditions: { paper_pen: 3 }, activities: [activity('use', { requires: ['water'], preconditions: { water: 2 }, consumes: { water: 2 } })] })]);
  const result = planPreparations([stage('s', ['use']), stage('s', ['use'])], data);
  assert.deepEqual(quantities(result), { paper_pen: 3, water: 4 });
  assert.deepEqual(result.map(item => item.stageIndexes), [[0, 1], [0, 1]]);
});

test('同阶段活动按前置关系及稳定 ID 排序核算，消费不能提前获得产出', () => {
  const data = source([scene('s', { activities: [activity('z_buy', { provides: ['picnic_pack'] }), activity('a_eat', { predecessorIds: ['z_buy'], consumes: ['picnic_pack'] })] })]);
  assert.deepEqual(planPreparations([stage('s', ['a_eat', 'z_buy'])], data), []);
  assert.throws(() => planPreparations([stage('s', ['a_eat'])], data), /H_PREDECESSOR/);
  const cycle = source([scene('s', { activities: [activity('a', { predecessorIds: ['b'] }), activity('b', { predecessorIds: ['a'] })] })]);
  assert.throws(() => planPreparations([stage('s', ['a', 'b'])], cycle), /H_PREDECESSOR_CYCLE/);
});

test('场景先于活动检查，活动产出只能供同阶段后续活动或后续阶段使用', () => {
  const data = source([scene('s', { requires: ['picnic_pack'], activities: [activity('buy', { provides: ['picnic_pack'] })] })]);
  assert.equal(quantities(planPreparations([stage('s', ['buy'])], data)).picnic_pack, 1);
});

test('真实拍照→冲印及手作链不将共同成果列为外部准备', () => {
  const stages = [stage('street', ['photo_pair']), stage('photo_printing', ['photo_print']), stage('craft', ['craft_card'])];
  assert.deepEqual(quantities(planPreparations(stages, catalog)), { craft_kit: 1 });
  assert.throws(() => planPreparations([stage('photo_printing', ['photo_print'])], catalog), /H_PREDECESSOR/);
});

test('默认有限库存覆盖最大阶段数的多个消耗活动，能经 normalize 和 JSON Worker 传输', () => {
  const data = source([scene('s', { requires: { craft_kit: 3 }, consumes: ['craft_kit'], activities: [activity('a', { consumes: { craft_kit: 2 } }), activity('b', { consumes: { craft_kit: 4 } })] })]);
  const resources = availablePreparationResources(data, { maxStages: 24 });
  assert.equal(resources.craft_kit, 4 + 24 * 7);
  const stages = Array.from({ length: 24 }, () => stage('s', ['a', 'b']));
  assert.ok(resources.craft_kit >= quantities(planPreparations(stages, data)).craft_kit);
  assert.deepEqual(normalize(JSON.parse(JSON.stringify({ preparedIds: availablePreparationIds(data), resources }))).resources, resources);
  assert.throws(() => availablePreparationResources(data, { maxStages: 0 }), /maxStages/);
  assert.throws(() => availablePreparationResources(data, { maxStages: Number.MAX_SAFE_INTEGER }), /安全范围/);
});

test('真实 engine 可连续消费两份手作材料；仅 preparedIds 的一份会失败', () => {
  const stages = [stage('craft', ['craft_card']), stage('craft', ['craft_card'])];
  const context = initialContext(catalog);
  const result = planDate({ ...context, fixedPrefix: stages }, catalog, { maxStages: 2, maxExpandedNodes: 20 });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const insufficient = planDate({ ...context, resources: {}, fixedPrefix: stages }, catalog, { maxStages: 2 });
  assert.equal(insufficient.ok, false);
  assert.ok(insufficient.errors.some(error => /H_PREPARATION|H_RESOURCE/.test(error)));
  assert.ok(result.stages[1].after.resources.craft_kit > 0);
});

test('真实 engine 不因默认准备绕过共同拍照或冲印前置约束', () => {
  const context = { ...initialContext(catalog), explicitConsentIds: ['photo_pair', 'photo_print'] };
  for (const id of INTERNAL_PREPARATION_IDS) assert.equal(context.resources[id], undefined);
  const missing = planDate({ ...context, fixedPrefix: [stage('photo_printing', ['photo_print'])] }, catalog, { maxStages: 1 });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some(error => /H_PREDECESSOR|H_PREPARATION/.test(error)));
  const valid = planDate({ ...context, fixedPrefix: [stage('street', ['photo_pair']), stage('photo_printing', ['photo_print'])] }, catalog, { maxStages: 2, maxExpandedNodes: 20 });
  assert.equal(valid.ok, true, JSON.stringify(valid.errors));
});

test('默认库存不会注入新的内部消耗资源，H_RESOURCE 仍严格执行', () => {
  const data = source([scene('use', { activities: [activity('consume', { consumes: ['result'] })] }), scene('make', { provides: ['result'] })], ['result', 'water']);
  const result = planDate({ ...initialContext(data), fixedPrefix: [stage('use', ['consume'])] }, data, { maxStages: 1 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => /H_RESOURCE/.test(error)));
});

test('扁平活动引用、场景覆盖与独立元数据受支持，未知选择明确失败', () => {
  const data = source([scene('s', { activityIds: ['a'], activities: undefined, activityOverrides: { a: { requires: ['water'] } } })]);
  data.activities = [activity('a', { preparationIds: ['paper_pen'] })];
  assert.deepEqual(quantities(planPreparations([stage('s', ['a'])], data)), { paper_pen: 1, water: 1 });
  assert.throws(() => planPreparations([stage('missing')], data), /未知场景/);
  assert.throws(() => planPreparations([stage('s', ['missing'])], data), /不属于/);
  assert.throws(() => planPreparations(null, data), /stages/);
});

test('不修改 catalog、完整阶段或元数据；各次结果独立且顺序稳定', () => {
  const data = source([scene('s', { preparationIds: ['water', 'paper_pen'] })]);
  const stages = [stage('s')], before = JSON.stringify({ data, stages });
  const first = planPreparations(stages, data), second = planPreparations(stages, data);
  assert.deepEqual(first, second);
  first[0].stageIndexes.push(999);
  first[0].label = 'changed';
  assert.deepEqual(planPreparations(stages, data), second);
  const ids = availablePreparationIds(data);
  ids.pop();
  assert.equal(availablePreparationIds(data).length, 4);
  assert.equal(JSON.stringify({ data, stages }), before);
});
