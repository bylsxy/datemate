import test from 'node:test';
import assert from 'node:assert/strict';
import { loadKnowledge, compileKnowledge } from '../tools/build_catalog.mjs';
import { verifyPlanWitness } from '../engine.mjs';

const input = await loadKnowledge();
const scenes = input.documents.scenes.scenes;
const activities = input.documents.activities.activities;
const scene = id => scenes.find(s => s.id === id);
const activity = id => activities.find(a => a.id === id);
const extraTags = ['dream', 'travel', 'celebration', 'confession', 'shared_hobby', 'private', 'night', 'japanese', 'chinese'];
// 主线负责元数据登记；此夹具仅在内存补齐标签，以独立验证知识分支，不写生成数据。
const fixtureInput = structuredClone(input);
fixtureInput.documents.metadata.interestTags = [...new Set([...fixtureInput.documents.metadata.interestTags, ...extraTags])];
const compiled = compileKnowledge(fixtureInput);

test('新增原创知识可编译，标签与活动挂载完整', () => {
  assert.ok(scenes.length >= 86);
  assert.ok(activities.length >= 150);
  assert.equal(compiled.audit.checks.status, 'passed');
  for (const a of activities) assert.ok(scenes.some(s => s.activityIds.includes(a.id)), a.id);
});

test('社交要求覆盖场景与具体活动，区分独处、课堂和多人参与', () => {
  for (const item of [...scenes, ...activities]) assert.ok(Number.isInteger(item.socialDemand) && item.socialDemand >= 0 && item.socialDemand <= 3, item.id);
  for (const id of ['ktv_duet', 'ktv_soundtrack', 'arboretum_portrait', 'photo_pair']) assert.equal(activity(id).socialDemand, 0);
  assert.equal(activity('dance_basic_step').socialDemand, 2);
  assert.equal(activity('script_mystery').socialDemand, 3);
  assert.equal(scene('friends_theme_party').socialDemand, 3);
});

test('自助餐工作日与周末为两人示例，餐食活动不重复收费', () => {
  for (const id of ['sushi_buffet', 'grill_buffet']) {
    const s = scene(id);
    assert.deepEqual(s.cost, s.costByWeekPart.weekday);
    assert.ok(s.costByWeekPart.weekend[1] > s.costByWeekPart.weekday[1]);
    for (const aid of s.activityIds) assert.deepEqual(activity(aid).cost, [0, 0]);
    assert.match(s.availabilityNote, /两人.*示例/);
  }
  assert.equal(activity('sushi_cooked').exclusiveKey, activity('sushi_raw').exclusiveKey);
});

test('树木园仅白天，观萤保留季节与不保证出现的限制', () => {
  const arboretum = scene('scau_arboretum_day');
  assert.equal(arboretum.place.universityId, 'scau');
  assert.ok(arboretum.dailyWindows.every(w => w.startMinute >= 480 && w.endMinute <= 1050));
  assert.match(arboretum.availabilityNote, /晚上缺灯/);
  assert.match(arboretum.availabilityNote, /不安排捕捞/);
  assert.match(scene('scau_orchid_firefly').availabilityNote, /不保证全年或每晚/);
});

test('园区划船、摩天轮和营地晚间保留真实前置，旅行卡独立包含往返与餐食', () => {
  for (const [next, prior] of [['park_lake_boating', 'park_lake_arrival'], ['ferris_wheel_ride', 'amusement_park_day'], ['camp_evening', 'camp_day_setup']]) {
    assert.ok(scene(next).predecessorIds.includes(prior));
    for (const aid of scene(next).activityIds) assert.ok(activity(aid).predecessorIds.includes(prior));
    assert.ok(compiled.graph.edges.some(e => e.subject === next && e.predicate === 'follows' && e.object === prior));
  }
  for (const id of ['intercity_outbound', 'intercity_oldtown', 'intercity_return', 'coast_outbound', 'seaside_sunrise', 'coast_return']) {
    assert.equal(scene(id).area, 'off');
    assert.ok(scene(id).durationRange[0] >= 300);
    assert.ok(scene(id).cost[0] >= 320);
    assert.ok(scene(id).bundledMeals.length > 0);
    assert.deepEqual(scene(id).predecessorIds ?? [], []);
    assert.ok(scene(id).dailyWindows.every(w => w.startMinute >= 450 && w.endMinute <= 1440));
    assert.match(scene(id).availabilityNote, /往返交通.*餐次/);
    for (const aid of scene(id).activityIds) {
      assert.deepEqual(activity(aid).predecessorIds ?? [], []);
      assert.deepEqual(activity(aid).requires ?? [], []);
      assert.deepEqual(activity(aid).consumes ?? [], []);
      assert.deepEqual(activity(aid).cost, [0, 0]);
    }
  }
});

test('真实引擎拒绝未到公园就划船，按序入园划船可重放', () => {
  const ids = ['park_lake_arrival', 'park_lake_boating'];
  const catalog = { ...compiled.catalog, scenes: compiled.catalog.scenes.filter(s => ids.includes(s.id)), transfers: {off: {off: 0}} };
  const ctx = {duration: 150, startMinute: 600, reserve: 0, robust: false, fatigueA: 0, fatigueB: 0, preparedIds: ['opening_checked', 'venue_checked'], resources: {opening_checked: 1, venue_checked: 1}};
  const boating = {sceneId: 'park_lake_boating', activityIds: ['boat_row_pair']};
  const invalid = verifyPlanWitness(ctx, catalog, {knownPlan: [boating]});
  assert.equal(invalid.ok, false);
  assert.match(JSON.stringify(invalid), /H_PREDECESSOR/);
  const valid = verifyPlanWitness(ctx, catalog, {knownPlan: [{sceneId: 'park_lake_arrival', activityIds: ['park_dock_check']}, boating]});
  assert.equal(valid.ok, true, JSON.stringify(valid));
});

test('梦幻场景仅标记少数大型计划；忌口标签沿用现有词表', () => {
  const dreams = scenes.filter(s => s.dreamOnly);
  assert.equal(dreams.length, 3);
  assert.ok(dreams.every(s => s.tags.includes('dream') && s.durationRange[0] >= 180));
  const dietary = new Set(input.documents.metadata.dietaryOptions.map(t => t.id));
  for (const a of activities) for (const tag of a.dietaryTags ?? []) assert.ok(dietary.has(tag), `${a.id}:${tag}`);
});

test('独立往返旅行不能压缩为三小时，梦幻长卡含餐，热气球保留下午入口', () => {
  const ids = ['intercity_outbound', 'intercity_oldtown', 'intercity_return', 'coast_outbound', 'seaside_sunrise', 'coast_return'];
  const ctx = {duration: 180, reserve: 0, robust: false, fatigueA: 0, fatigueB: 0, resources: {booking_checked: 1, venue_checked: 1}};
  for (const id of ids) {
    const s = scene(id);
    const result = verifyPlanWitness(ctx, compiled.catalog, {knownPlan: [{sceneId: id, activityIds: [s.activityIds[0]]}]});
    assert.equal(result.ok, false, id);
    assert.match(result.errors.join(';'), /H_TIME_WINDOW/, id);
  }
  for (const id of ['dream_island_day', 'dream_concert_trip']) {
    assert.deepEqual(scene(id).bundledMeals, ['lunch', 'dinner']);
    assert.match(scene(id).description, /往返.*午晚餐/);
  }
  assert.equal(scene('dream_balloon_trip').dailyWindows[0].startMinute, 780);
  assert.match(scene('dream_balloon_trip').description, /系留/);
  assert.match(scene('camp_day_setup').availabilityNote, /不含过夜住宿/);
  assert.deepEqual(scene('camp_day_setup').cost, [80, 240]);
});
