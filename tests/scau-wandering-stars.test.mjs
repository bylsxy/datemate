import test from 'node:test';
import assert from 'node:assert/strict';
import { planDate } from '../engine.mjs';
import { isSceneAvailableInContext, isSceneOpenDuring, sceneDailyWindows, sceneDurationAt } from '../scene-time.mjs';
import { loadKnowledge, compileKnowledge } from '../tools/build_catalog.mjs';

const { catalog } = compileKnowledge(await loadKnowledge());
const ids = ['scau_wandering', 'faculty_rooftop_stars'];
const sceneById = id => {
  const scene = catalog.scenes.find(s => s.id === id);
  assert.ok(scene, `目录缺少${id}`);
  return scene;
};
const context = { area: 'campus', school: 'scau', reserve: 0, robust: false, fatigueA: 0, fatigueB: 0, exploration: 0 };
const fixed = (id, startMinute) => ({ sceneId: id, startMinute, activityIds: ['campus_watch'] });

test('两场景登记60分钟规划停留及各自每日时段', () => {
  const wandering = sceneById(ids[0]);
  const stars = sceneById(ids[1]);
  assert.deepEqual(wandering.dailyWindows, [{ startMinute: 0, endMinute: 1440 }]);
  assert.deepEqual(stars.dailyWindows, [{ startMinute: 0, endMinute: 360 }, { startMinute: 1140, endMinute: 1440 }]);
  for (const scene of [wandering, stars]) {
    assert.equal(scene.minutes, 60, scene.id);
    assert.equal(sceneDurationAt(scene, 540), 60, scene.id);
    assert.equal(sceneDurationAt(scene, 1430), 60, scene.id);
  }
});

test('校内游荡上午及夜晚均允许，跨午夜仍连续开放', () => {
  const scene = sceneById(ids[0]);
  for (const period of ['morning', 'afternoon', 'evening', 'night']) {
    assert.equal(isSceneAvailableInContext(scene, { periodIds: [period] }), true, period);
  }
  for (const start of [0, 540, 840, 1140, 1430, 1440, 1799]) {
    assert.equal(isSceneOpenDuring(scene, start, start + 60), true, String(start));
  }
});

test('看星星19点至次日06点连续开放，18:59和白天拒绝且停留须完整覆盖', () => {
  const scene = sceneById(ids[1]);
  assert.equal(isSceneOpenDuring(scene, 1139, 1199), false);
  assert.equal(isSceneOpenDuring(scene, 1140, 1200), true);
  assert.equal(isSceneOpenDuring(scene, 1740, 1800), true);
  assert.equal(isSceneOpenDuring(scene, 1741, 1801), false);
  assert.equal(isSceneOpenDuring(scene, 1800, 1860), false);
  for (const start of [360, 540, 840, 1080]) {
    assert.equal(isSceneOpenDuring(scene, start, start + 60), false, String(start));
  }
  assert.deepEqual(sceneDailyWindows(scene, 1380, 1800), [{ startMinute: 1380, endMinute: 1800 }]);
  assert.equal(isSceneOpenDuring(scene, 1430, 1490), true);
  for (const period of ['morning', 'afternoon']) assert.equal(isSceneAvailableInContext(scene, { periodIds: [period] }), false, period);
  for (const period of ['evening', 'night']) assert.equal(isSceneAvailableInContext(scene, { periodIds: [period] }), true, period);
});

test('真实引擎夜晚固定前缀允许校内游荡和学校级看星星且不限定宿舍区', () => {
  // 夜晚结束于1560；跨午夜停留至1495，加各自回去5分钟恰好满足末段覆盖。
  for (const id of ids) for (const campusArea of ['', 'taishan', 'other']) {
    const result = planDate({ ...context, campusArea, periodIds: ['night'], fixedPrefix: [fixed(id, 1435)] }, catalog, { maxStages: 1 });
    assert.equal(result.ok, true, `${id}/${campusArea}: ${result.errors.join(';')}`);
    const stage = result.stages[0];
    assert.equal(stage.sceneId, id);
    assert.equal(stage.start, 1435);
    assert.equal(stage.minutes, 60);
    assert.equal(stage.end, 1495);
    assert.deepEqual(stage.activityIds, ['campus_watch']);
    assert.equal(result.metrics.endingCoverageSatisfied, true);
  }
});

test('通用校内游荡的真实夜晚前缀不要求华农权限', () => {
  const scene = sceneById(ids[0]);
  assert.equal(scene.title, '校内游荡');
  assert.equal(scene.place.name, '校内游荡');
  assert.equal(scene.scauOnly, false);
  assert.equal(scene.place.universityId, '');
  assert.equal(scene.place.campusArea, '');
  for (const area of ['campus', 'near']) for (const school of ['', 'other']) {
    const result = planDate({ ...context, area, school, periodIds: ['night'], fixedPrefix: [fixed(ids[0], 1435)] }, catalog, { maxStages: 1 });
    assert.equal(result.ok, true, `${area}/${school}: ${result.errors.join(';')}`);
    assert.equal(result.stages[0].sceneId, ids[0]);
    assert.equal(result.stages[0].minutes, 60);
    assert.equal(result.metrics.endingCoverageSatisfied, true);
  }
});

test('真实引擎固定前缀不能绕过看星星的华农权限或下午关闭时段', () => {
  for (const school of ['', 'other']) {
    const id = ids[1];
    const result = planDate({ ...context, school, campusArea: 'taishan', periodIds: ['night'], fixedPrefix: [fixed(id, 1430)] }, catalog, { maxStages: 1 });
    assert.equal(result.ok, false, id);
    assert.ok(result.errors.some(e => e.startsWith('H_SCHOOL_SCOPE:')), `${id}: ${result.errors.join(';')}`);
  }
  // 会面后入场转场需要10分钟，900不会先被840起点的转场边界拒绝。
  const result = planDate({ ...context, periodIds: ['afternoon'], fixedPrefix: [fixed(ids[1], 900)] }, catalog, { maxStages: 3 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith('H_SCENE_HOURS:')), result.errors.join(';'));
});
