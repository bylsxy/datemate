import test from 'node:test';
import assert from 'node:assert/strict';
import { loadKnowledge, compileKnowledge } from '../tools/build_catalog.mjs';

const input = await loadKnowledge();
const { catalog } = compileKnowledge(input);
const scene = id => catalog.scenes.find(s => s.id === id);
const activity = id => catalog.activities.find(a => a.id === id);

test('通用宿舍楼下基础停留全天避雨，安静低负担且不靠消费或室内大厅', () => {
  const s = scene('dorm_downstairs_shelter');
  assert.equal(s.scauOnly, false);
  assert.equal(s.place.universityId, '');
  assert.equal(s.place.campusArea, '');
  assert.equal(s.indoor, false);
  assert.equal(s.sheltered, true);
  assert.equal(s.quiet, true);
  assert.equal(s.crowdRisk, 'low');
  assert.equal(s.kind, 'everyday');
  assert.equal(s.minutes, 60);
  assert.ok(s.load <= 0);
  assert.deepEqual(s.cost, [0, 0]);
  assert.deepEqual(s.dailyWindows, [{ startMinute: 0, endMinute: 1440 }]);
  assert.ok(s.weather.includes('rain'));
  assert.ok(s.activities.length > 0);
  for (const a of s.activities) {
    assert.deepEqual(a.cost, [0, 0]);
    assert.equal(a.load, 0);
    assert.deepEqual(a.requires, []);
  }
});

test('有盖场景均可避雨，泰超门口保持非室内和略贵提醒', () => {
  for (const s of catalog.scenes) {
    assert.equal(typeof s.sheltered, 'boolean', s.id);
    if (s.sheltered) assert.ok(s.weather.includes('rain'), s.id);
  }
  assert.equal(scene('taishan_supermarket_front').indoor, false);
  assert.equal(scene('taishan_supermarket_front').sheltered, true);
  // 手工源明确说明架空层花园的椅子会湿，不能因名称推断可避雨。
  assert.equal(scene('taishan_lab_garden').indoor, false);
  assert.equal(scene('taishan_lab_garden').sheltered, false);
  assert.ok(!scene('taishan_lab_garden').weather.includes('rain'));
  assert.match(scene('taishan_supermarket_front').description, /吧台/);
  assert.match(scene('taishan_supermarket_front').description, /略贵/);
  for (const id of ['garden', 'camellia_garden', 'orchid_garden', 'faculty_rooftop_stars']) {
    assert.equal(scene(id).sheltered, false);
  }
});

test('校园打包路线四餐上界60元，不承诺安静，餐食由付费活动提供', () => {
  const s = scene('dorm_takeaway_meal');
  assert.equal(s.scauOnly, false);
  assert.equal(s.place.universityId, '');
  assert.equal(s.place.campusArea, '');
  assert.equal(s.area, 'campus');
  assert.equal(s.kind, 'meal');
  assert.equal(s.quiet, false);
  assert.equal(s.crowdRisk, 'low');
  assert.equal(s.sheltered, true);
  assert.ok(s.weather.includes('rain'));
  assert.deepEqual(s.cost, [0, 0]);
  assert.deepEqual(s.provides, []);
  assert.deepEqual(s.mealRoles, ['breakfast', 'lunch', 'dinner', 'supper']);
  assert.deepEqual(s.dailyWindows, [{ startMinute: 0, endMinute: 1440 }]);
  const picks = ['campus_budget_breakfast', 'campus_budget_meal', 'campus_budget_meal', 'campus_budget_supper'];
  assert.equal(picks.reduce((sum, id) => sum + activity(id).cost[1], 0), 60);
  for (const role of s.mealRoles) {
    const options = s.activities.filter(a => a.mealRoles.includes(role));
    assert.ok(options.length > 0, role);
    for (const a of options) {
      assert.ok(a.cost[0] > 0);
      assert.ok(a.provides.includes('meal_completed'));
      assert.equal(a.exclusiveKey, 'main_meal');
    }
  }
  assert.deepEqual(activity('canteen_pair').cost, [40, 70]);
  assert.deepEqual(activity('meal_style_c').cost, [140, 140]);
  assert.deepEqual(activity('breakfast_pack').provides, ['breakfast_pack']);
});

test('所有说明及场地覆盖文案都描述玩法，后台证据口吻不进入约会卡片', () => {
  const descriptions = [
    ...input.documents.scenes.scenes.map(s => s.description),
    ...input.documents.activities.activities.map(a => a.description),
    ...input.documents.scenes.scenes.flatMap(s => Object.values(s.activityOverrides ?? {}).flatMap(a => a.description ? [a.description] : [])),
  ];
  for (const text of descriptions) {
    assert.ok(text.trim().length > 0);
    assert.doesNotMatch(text, /用户提供|用户指定|原型假设|设计扩展|设计区间|设计拆分|原语料|不等于|官方未核实|不是原作事实/);
    assert.ok(text.length <= 100, text);
  }
});
