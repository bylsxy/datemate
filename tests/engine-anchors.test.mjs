import test from 'node:test';
import assert from 'node:assert/strict';
import { planDate } from '../engine.mjs';
import { catalog } from '../data/catalog.mjs';

test('食堂仅固定地点的必去锚点联合选择实际早餐，不能空场馆冒充用餐', () => {
  // 芷园食堂属于华农泰山区；此用餐锚点案例明确具备对应权限。
  const result = planDate({ area: 'near', school: 'scau', campusArea: 'taishan', periodIds: ['morning'], anchors: [{ id: 'must-eat', sceneId: 'canteen', sceneOnly: true, index: 0 }] }, catalog);
  assert.equal(result.ok, true, result.errors.join(';'));
  const stage = result.stages[0];
  assert.equal(stage.anchorId, 'must-eat');
  assert.equal(stage.sceneId, 'canteen');
  assert.equal(stage.mealRole, 'breakfast');
  const activities = catalog.scenes.find(s => s.id === stage.sceneId).activities;
  assert.ok(stage.activityIds.some(id => activities.some(a => a.id === id && a.provides?.includes('meal_completed') && a.mealRoles?.includes('breakfast'))), '必须选择实际完成早餐的活动');
  assert.equal(result.mealRequirements[0].satisfied, true);
  assert.equal(result.metrics.anchorsSatisfied, true);
  assert.equal(result.anchors[0].sceneOnly, true);
});

test('Switch店仅固定地点仍按双方play兴趣择优玩法，旧精确空活动锚点保持空组合', () => {
  const context = { periodIds: ['afternoon'], preferencesA: ['play'], preferencesB: ['play'] };
  const dynamic = planDate({ ...context, anchors: [{ id: 'play-stop', sceneId: 'switch_store', sceneOnly: true, index: 0 }] }, catalog);
  assert.equal(dynamic.ok, true, dynamic.errors.join(';'));
  assert.equal(dynamic.stages[0].sceneId, 'switch_store');
  assert.equal(dynamic.stages[0].anchorId, 'play-stop');
  assert.ok(dynamic.stages[0].activityIds.length > 0);
  const scene = catalog.scenes.find(s => s.id === 'switch_store');
  assert.ok(dynamic.stages[0].activityIds.some(id => scene.activities.find(a => a.id === id).tags.includes('play')));
  assert.ok(dynamic.stages[0].featureContributions.activityExperienceA > 0);
  assert.ok(dynamic.stages[0].featureContributions.activityExperienceB > 0);
  const exact = planDate({ ...context, anchors: [{ id: 'empty-stop', sceneId: 'switch_store', activityIds: [], index: 0 }] }, catalog);
  assert.equal(exact.ok, true, exact.errors.join(';'));
  assert.deepEqual(exact.stages[0].activityIds, []);
});

test('sceneOnly锚点匹配人工前缀时只比地点，但人工活动仍精确校验且不被清空', () => {
  const input = { area: 'near', school: 'scau', campusArea: 'taishan', periodIds: ['morning'], anchors: [{ id: 'must-eat', sceneId: 'canteen', sceneOnly: true, index: 0 }], fixedPrefix: [{ sceneId: 'canteen', activityIds: ['breakfast_eat'], mealRole: 'breakfast' }] };
  const result = planDate(input, catalog);
  assert.equal(result.ok, true, result.errors.join(';'));
  assert.equal(result.stages[0].anchorId, 'must-eat');
  assert.deepEqual(result.stages[0].activityIds, ['breakfast_eat']);
  const invalid = planDate({ ...input, fixedPrefix: [{ sceneId: 'canteen', activityIds: [] }] }, catalog);
  assert.equal(invalid.status, 'invalid_input');
  assert.match(invalid.errors.join(), /H_MEAL_ACTIVITY/);
  const exact = planDate({ ...input, anchors: [{ id: 'exact-empty', sceneId: 'canteen', activityIds: [], index: 0 }] }, catalog);
  assert.equal(exact.status, 'invalid_input');
  assert.match(exact.errors.join(), /H_ANCHOR_PREFIX/);
});

test('sceneOnly保留固定时间和窗口，未满足准备条件不得为了必去偷偷选玩法', () => {
  const source = { version: 'anchor-test', scenes: [{ id: 'game', kind: 'ordinary', area: 'campus', minutes: 30, cost: [0, 0], load: 0, fit: 70, activities: [{ id: 'play', tags: ['play'], cost: [0, 0], load: 0, requires: ['kit'] }] }] };
  const context = { windows: [{ id: 'evening', startMinute: 1140, endMinute: 1320 }], reserve: 0, robust: false, preferencesA: ['play'], preferencesB: ['play'], anchors: [{ id: 'booking', sceneId: 'game', sceneOnly: true, index: 0, startMinute: 1200, windowId: 'evening' }] };
  const absent = planDate(context, source, { maxStages: 1 });
  assert.equal(absent.ok, true);
  assert.deepEqual(absent.stages[0].activityIds, []);
  const ready = planDate({ ...context, preparedIds: ['kit'] }, source, { maxStages: 1 });
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.stages[0].activityIds, ['play']);
  assert.equal(ready.stages[0].start, 1200);
  assert.equal(ready.stages[0].windowId, 'evening');
  assert.equal(ready.stages[0].anchorId, 'booking');
  const nested = planDate({ ...context, preparedIds: ['kit'], anchors: [{ id: 'nested-booking', choice: { sceneId: 'game', startMinute: 1200, activityIds: ['stale-ignored'] }, sceneOnly: true, index: 0, windowId: 'evening' }] }, source, { maxStages: 1 });
  assert.equal(nested.ok, true);
  assert.equal(nested.stages[0].start, 1200);
  assert.deepEqual(nested.stages[0].activityIds, ['play']);
});
