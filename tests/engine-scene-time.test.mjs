import test from 'node:test';
import assert from 'node:assert/strict';
import { planDate, verifyPlanWitness } from '../engine.mjs';
import { sceneDailyWindows, sceneDurationAt, isSceneOpenDuring, isSceneAvailableInContext, sceneOpenWindows } from '../scene-time.mjs';
import { catalog } from '../data/catalog.mjs';

const scene = (id, extra = {}) => ({ id, kind: 'ordinary', area: 'campus', minutes: 20, cost: [0, 0], load: 0, activities: [], ...extra });
const fixture = scenes => ({ scenes, departures: [{ id: 'separate', minutes: 15, cost: [0, 0] }], transfers: { campus: { campus: 0 } } });
const ctx = { periodIds: ['night'], reserve: 0, robust: false, fatigueA: 0, fatigueB: 0 };
const choice = (sceneId, startMinute, activityIds = []) => ({ sceneId, startMinute, activityIds });
const allDay = [{ startMinute: 0, endMinute: 1440 }];

test('每日窗口重复到次日，跨午夜和相邻分段合并，真实关门间隙保留', () => {
  const crossing = scene('s', { dailyWindows: [{ startMinute: 1140, endMinute: 30 }] });
  assert.deepEqual(sceneDailyWindows(crossing, 1380, 1560), [{ startMinute: 1380, endMinute: 1470 }]);
  assert.equal(isSceneOpenDuring(crossing, 1430, 1470), true);
  assert.equal(isSceneOpenDuring(crossing, 1430, 1471), false);
  const split = scene('s', { dailyWindows: [{ startMinute: 1140, endMinute: 1440 }, { startMinute: 0, endMinute: 360 }] });
  assert.deepEqual(sceneDailyWindows(split, 1380, 1560), [{ startMinute: 1380, endMinute: 1560 }]);
  assert.equal(isSceneOpenDuring(split, 1430, 1490), true);
  assert.equal(isSceneOpenDuring(scene('gap', { dailyWindows: [{ startMinute: 0, endMinute: 20 }, { startMinute: 30, endMinute: 360 }] }), 1450, 1490), false);
  assert.equal(isSceneOpenDuring(scene('unspecified'), 1430, 1490), true);
});

test('晚间19点及次日06点边界、跨入晚间、饭点与休息不误延长', () => {
  const s = scene('s');
  assert.equal(sceneDurationAt(s, 1120), 20);
  assert.equal(sceneDurationAt(s, 1121), 60);
  assert.equal(sceneDurationAt(s, 1140), 60);
  assert.equal(sceneDurationAt(s, 1799), 60);
  assert.equal(sceneDurationAt(s, 1800), 20);
  assert.equal(sceneDurationAt(s, 1450, { mealRole: 'supper' }), 30);
  for (const mealRole of ['breakfast', 'lunch', 'dinner']) assert.equal(sceneDurationAt(s, 1450, { mealRole }), 20);
  assert.equal(sceneDurationAt(scene('r', { kind: 'rest' }), 1450), 20);
  assert.equal(sceneDurationAt(s, 1450, { clockMode: false }), 20);
});

test('每日营业和原有绝对预约窗口取交集', () => {
  const s = scene('s', { dailyWindows: [{ startMinute: 1140, endMinute: 30 }], windows: [{ startMinute: 1440, endMinute: 1460 }] });
  assert.deepEqual(sceneOpenWindows(s, { startMinute: 1380, endMinute: 1560 }, true), [{ startMinute: 1440, endMinute: 1460 }]);
});

test('普通夜间阶段的end、schedule、activeMinutes、候选和trace使用真实60分钟', () => {
  const s = scene('open', { dailyWindows: allDay, activities: [{ id: 'talk', cost: [0, 0], load: 0 }] });
  const result = planDate({ ...ctx, fixedPrefix: [choice('open', 1450, ['talk'])] }, fixture([s]), { maxStages: 1 });
  assert.equal(result.ok, true, result.errors.join(';'));
  const stage = result.stages[0];
  assert.equal(stage.minutes, 60);
  assert.equal(stage.end, 1510);
  assert.equal(stage.schedule[0].endOffset, 60);
  assert.equal(result.metrics.activeMinutes, 60);
  assert.equal(result.metrics.totalMinutes, 145); // 70分钟真实等候 + 60分钟阶段 + 15分钟分别。
  assert.equal(result.departure.minutes, 15);
  assert.equal(stage.trace.find(t => t.ruleId === 'RESOURCE_ACCOUNTING').outputFacts.find(f => f.id === 'minutes').value, 60);
  assert.ok(stage.candidates.every(c => c.end - c.start === c.minutes));
});

test('开放结束恰好覆盖完整阶段可行，多一分钟或闭店前缀、锚点、见证均拒绝', () => {
  const s = scene('s', { dailyWindows: [{ startMinute: 1140, endMinute: 70 }] });
  const c = fixture([s]);
  assert.equal(verifyPlanWitness(ctx, c, { knownPlan: [choice('s', 1450)] }).ok, true);
  for (const result of [
    planDate({ ...ctx, fixedPrefix: [choice('s', 1451)] }, c),
    planDate({ ...ctx, anchors: [{ id: 'a', startMinute: 1451, choice: { sceneId: 's', activityIds: [] } }] }, c),
    verifyPlanWitness(ctx, c, { knownPlan: [choice('s', 1451)] }),
  ]) {
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.startsWith('H_SCENE_HOURS:')) || result.search.constraintRejections.H_SCENE_HOURS > 0);
  }
});

test('自动安排和候选只包含完整开放的地点', () => {
  const c = fixture([scene('open', { dailyWindows: allDay }), scene('closed', { fit: 999, dailyWindows: [{ startMinute: 600, endMinute: 1320 }] })]);
  const result = planDate(ctx, c);
  assert.equal(result.ok, true, result.errors.join(';'));
  assert.ok(result.stages.every(s => s.sceneId === 'open' && s.minutes === 60));
  assert.ok(result.stages.flatMap(s => s.candidates).every(s => s.sceneId !== 'closed'));
});

test('非时钟合成测试忽略每日窗口且保留基础时长，绝对预约仍有效', () => {
  const s = scene('s', { dailyWindows: [{ startMinute: 600, endMinute: 1320 }], windows: [{ startMinute: 100, endMinute: 200 }] });
  const input = { duration: 100, windows: [{ startMinute: 100, endMinute: 200 }], reserve: 0, robust: false, fixedPrefix: [choice('s', 120)] };
  assert.equal(planDate(input, fixture([s]), { maxStages: 1 }).stages[0].minutes, 20);
  const rejected = planDate({ ...input, fixedPrefix: [choice('s', 195)] }, fixture([s]));
  assert.ok(rejected.errors.some(e => e.startsWith('H_TIME_WINDOW:')));
  assert.equal(isSceneAvailableInContext(s, { duration: 100 }), true);
});

test('时钟UI过滤按实际停留及饭点判断，不以原20分钟误判营业容量', () => {
  assert.equal(isSceneAvailableInContext(scene('short', { dailyWindows: [{ startMinute: 1380, endMinute: 1410 }] }), ctx), false);
  assert.equal(isSceneAvailableInContext(scene('open', { dailyWindows: allDay }), ctx), true);
  const meal = scene('food', { kind: 'meal', mealRoles: ['supper'], dailyWindows: [{ startMinute: 1140, endMinute: 30 }] });
  assert.equal(isSceneAvailableInContext(meal, { periodIds: ['evening', 'night'] }), true);
  assert.equal(isSceneAvailableInContext(meal, { periodIds: ['evening', 'night'], mealChoices: { supper: 'skip' } }), false);
});

test('空每日窗口和无效时钟分钟作为目录错误拒绝', () => {
  for (const dailyWindows of [[], [{ startMinute: 0, endMinute: 0 }], [{ startMinute: 1440, endMinute: 1500 }]]) {
    const result = planDate(ctx, fixture([scene('bad', { dailyWindows })]));
    assert.equal(result.status, 'invalid_data');
    assert.ok(result.errors.some(e => e.startsWith('H_DATA:')));
  }
});

test('活动预约窗及整体容量也按延长后的实际停留校验', () => {
  const s = scene('s', { dailyWindows: allDay, activities: [{ id: 'talk', cost: [0, 0], load: 0, windows: [{ startMinute: 1450, endMinute: 1480 }] }] });
  for (const fixedPrefix of [[choice('s', 1450, ['talk'])], [choice('s', 1500)]]) {
    const result = planDate({ ...ctx, fixedPrefix }, fixture([s]));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.startsWith('H_TIME_WINDOW:')));
  }
});

test('宵夜30分钟真实计入阶段与活动，分别保持15分钟', () => {
  const meal = scene('food', { kind: 'meal', mealRoles: ['supper'], dailyWindows: [{ startMinute: 1140, endMinute: 30 }], activities: [{ id: 'eat', cost: [0, 0], load: 0, provides: ['meal_completed'], mealRoles: ['supper'] }] });
  const c = fixture([scene('walk', { dailyWindows: allDay }), meal]);
  const knownPlan = [choice('walk', 1140), choice('walk', 1320), { ...choice('food', 1380, ['eat']), mealRole: 'supper' }, choice('walk', 1450)];
  const result = verifyPlanWitness({ ...ctx, periodIds: ['evening', 'night'] }, c, { knownPlan });
  assert.equal(result.ok, true, result.errors.join(';'));
  assert.equal(result.stages[2].minutes, 30);
  assert.equal(result.stages[2].end, 1410);
  assert.equal(result.stages[2].schedule[0].endOffset, 30);
  assert.equal(result.metrics.activeMinutes, 210);
  assert.equal(result.metrics.departureMinutes, 15);
});

test('原地休息不能凭空开始或延续到已进入地点闭店之后', () => {
  const rest = scene('rest', { kind: 'rest', area: 'current', load: -6, dailyWindows: allDay });
  const c = fixture([rest]);
  const result = planDate({ ...ctx, fatigueA: 6, fatigueB: 6 }, c);
  assert.equal(result.ok, false);
  assert.ok(result.search.constraintRejections.H_REST_PLACE > 0);
  const c2 = fixture([scene('walk', { dailyWindows: [{ startMinute: 1380, endMinute: 1440 }] }), rest]);
  const rejected = planDate({ ...ctx, fixedPrefix: [choice('walk', 1380), choice('rest', 1440)] }, c2);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.errors.some(e => e.startsWith('H_SCENE_HOURS:')));
});

test('真实目录night无学校有通用游荡，scau夜晚及晚上+夜晚均有真实开放阶段', () => {
  const generic = planDate({ ...ctx, area: 'campus', school: '' }, catalog);
  assert.equal(generic.ok, true, generic.errors.join(';'));
  assert.ok(generic.stages.some(s => ['scau_wandering','dorm_downstairs_shelter'].includes(s.sceneId)));
  assert.ok(generic.stages.every(s => s.sceneId !== 'faculty_rooftop_stars'));
  for (const periodIds of [['night'], ['evening', 'night']]) {
    const result = planDate({ ...ctx, periodIds, area: 'near', school: 'scau' }, catalog);
    assert.equal(result.ok, true, result.errors.join(';'));
    const ordinary=result.stages.filter(s => !s.mealRole && s.sceneId !== 'rest');
    assert.ok(ordinary.length >= (periodIds.length===1?1:2));
    if(periodIds.length===1)assert.equal(ordinary.length,1,'单个夜晚默认连续停留，不强制换地方');
    for (const stage of result.stages) {
      const source = catalog.scenes.find(s => s.id === stage.sceneId);
      assert.equal(isSceneOpenDuring(source, stage.start, stage.end), true, stage.sceneId);
      if (!stage.mealRole && stage.sceneId !== 'rest') assert.ok(stage.minutes >= 60);
    }
    assert.equal(result.metrics.activeMinutes, result.stages.reduce((sum, s) => sum + s.minutes, 0));
  }
});
