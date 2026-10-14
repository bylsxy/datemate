import test from 'node:test';
import assert from 'node:assert/strict';
import { loadKnowledge, compileKnowledge } from '../tools/build_catalog.mjs';
import { normalize, planDate } from '../engine.mjs';
import { preferencePolicy } from '../preference-policy.mjs';

// 直接编译手工源，防止尚未重建的 data 掩盖知识修复。
const compiled = compileKnowledge(await loadKnowledge());
const catalog = { ...compiled.catalog, graph: compiled.graph };
const scene = id => catalog.scenes.find(s => s.id === id);
const context = { windows: [{ startMinute: 840, endMinute: 1260 }], reserve: 0, robust: false, fatigueA: 0, fatigueB: 0, preparedIds: ['opening_checked'] };
function policy(id, input = {}, activityIds = []) {
  const s = scene(id), acts = s.activities.filter(a => activityIds.includes(a.id));
  const tags = [...new Set([...s.tags, ...acts.flatMap(a => a.tags)])];
  return preferencePolicy(normalize(input), s, s, tags, new Set(), 0, acts).contributions;
}
function fixed(id, activityIds = [], input = {}) {
  return planDate({ ...context, ...input, fixedPrefix: [{ sceneId: id, activityIds }] }, catalog, { maxStages: 1, maxCandidateExpandedNodes: 1 });
}

test('真实户外场景：晴天有温和加分，多云中性，雨天降分；室内无晴天奖励', () => {
  assert.equal(policy('park_lake_arrival', { weather: 'clear' }).SOFT_CLEAR_OUTDOOR, 4);
  assert.equal(policy('park_lake_arrival', { weather: 'cloudy' }).SOFT_CLEAR_OUTDOOR, undefined);
  assert.equal(policy('park_lake_arrival', { weather: 'rain' }).SOFT_RAIN, -12);
  assert.equal(policy('reading', { weather: 'clear' }).SOFT_CLEAR_OUTDOOR, undefined);
  assert.equal(policy('reading', { weather: 'rain' }).SOFT_RAIN, 8);
});

test('生日、纪念日、表白匹配具体语义，通用庆祝只获较低奖励', () => {
  assert.equal(policy('birthday_small_celebration', { occasion: 'birthday' }).SOFT_OCCASION, 16);
  assert.equal(policy('friends_theme_party', { occasion: 'birthday' }).SOFT_OCCASION, 8);
  assert.equal(policy('memory_letter_table', { occasion: 'anniversary' }).SOFT_OCCASION, 16);
  assert.equal(policy('quiet_confession_corner', { occasion: 'confession' }).SOFT_OCCASION, 16);
  assert.equal(policy('birthday_small_celebration').SOFT_OCCASION, -8);
  assert.equal(policy('quiet_confession_corner').SOFT_OCCASION, -8);
});

test('临考短会在考试期加分，普通与假期降分但仍可手动安排', () => {
  assert.equal(policy('campus_exam_short_meet', { season: 'exam' }).SOFT_EXAM_CONTEXT, 8);
  for (const season of ['ordinary', 'holiday']) {
    assert.equal(policy('campus_exam_short_meet', { season }).SOFT_EXAM_CONTEXT, -8);
    assert.equal(fixed('campus_exam_short_meet', ['exam_next_break'], { season }).ok, true);
  }
  assert.equal(policy('intercity_outbound', { season: 'holiday' }).SOFT_HOLIDAY, 5);
});

test('周末费用使用真实自助餐价，不只改变解释文案', () => {
  const weekday = fixed('sushi_buffet', ['sushi_cooked'], { weekPart: 'weekday' });
  const weekend = fixed('sushi_buffet', ['sushi_cooked'], { weekPart: 'weekend' });
  assert.equal(weekday.ok, true); assert.equal(weekend.ok, true);
  assert.ok(weekend.stages[0].costCents[1] > weekday.stages[0].costCents[1]);
});

test('MBTI外向维度对真实双人桌游和多人剧本活动给出相反的轻量倾向', () => {
  const i = { personalityA: 'INTP' }, e = { personalityA: 'ENTP' };
  assert.ok(policy('boardgame', i, ['boardgame_coop']).SOFT_PERSONALITY > (policy('boardgame', e, ['boardgame_coop']).SOFT_PERSONALITY || 0));
  assert.ok(policy('mystery_store', e, ['script_mystery']).SOFT_PERSONALITY > (policy('mystery_store', i, ['script_mystery']).SOFT_PERSONALITY || 0));
});

test('经期舒适偏好与明示忌口独立，生食禁忌仍精确拒绝', () => {
  assert.ok(policy('birthday_small_celebration', { cyclePhase: 'during' }).SOFT_CYCLE_COMFORT > 0);
  assert.equal(policy('birthday_small_celebration', { cyclePhase: 'after' }).SOFT_CYCLE_COMFORT, undefined);
  assert.equal(fixed('sushi_buffet', ['sushi_raw'], { cyclePhase: 'during' }).ok, true);
  assert.equal(fixed('sushi_buffet', ['sushi_raw'], { dietaryRestrictions: ['raw'] }).ok, false);
});

test('开心状态以实际兴趣和活动标签加分，未开心无交换奖励', () => {
  assert.equal(policy('craft', { preferencesA: ['creative'] }, ['craft_card']).SOFT_HOBBY_EXCHANGE, undefined);
  const matched = policy('craft', { mood: 'happy', preferencesA: ['creative'] }, ['craft_card']);
  const other = policy('craft', { mood: 'happy', preferencesA: ['music'] }, ['craft_card']);
  assert.ok(matched.SOFT_HOBBY_EXCHANGE > (other.SOFT_HOBBY_EXCHANGE || 0));
});

test('长期关系对宿舍日常的降分规则可触发，重逢触发共同体验规则', () => {
  const ordinary = fixed('dorm_downstairs_shelter');
  const longterm = fixed('dorm_downstairs_shelter', [], { relationship: 'longterm' });
  assert.equal(ordinary.stages[0].trace.some(t => t.ruleId === 'R-longterm-familiar'), false);
  assert.equal(longterm.stages[0].trace.some(t => t.ruleId === 'R-longterm-familiar'), true);
  const reunion = fixed('memory_letter_table', ['memory_choose_three'], { reunion: true });
  assert.equal(reunion.ok, true);
  assert.ok(reunion.stages[0].trace.some(t => t.ruleId === 'R-reunion-activity'));
});

test('中日主题按真实餐馆标签匹配', () => {
  assert.equal(policy('chinese_shared_table', { themes: ['chinese'] }).SOFT_THEMES, 6);
  assert.equal(policy('chinese_shared_table', { themes: ['japanese'] }).SOFT_THEMES, undefined);
  assert.equal(policy('japanese_set_meal', { themes: ['japanese'] }).SOFT_THEMES, 6);
});

test('划船先入湖区可完成，缺前置拒绝；包餐整段的主体活动不重复收费', () => {
  const preparedIds = ['opening_checked', 'venue_checked', 'booking_checked'];
  assert.equal(fixed('park_lake_boating', ['boat_row_pair'], { preparedIds }).ok, false);
  const boat = planDate({ ...context, preparedIds, fixedPrefix: [
    { sceneId: 'park_lake_arrival', activityIds: ['park_dock_check'], minutes: 35 },
    { sceneId: 'park_lake_boating', activityIds: ['boat_row_pair'], minutes: 60 },
  ] }, catalog, { maxStages: 2, maxCandidateExpandedNodes: 1 });
  assert.equal(boat.ok, true);
  for (const s of catalog.scenes.filter(s => s.bundledMeals.length)) {
    assert.equal(s.predecessorIds.length, 0, s.id);
    assert.ok(s.activities.every(a => a.cost.every(n => n === 0)), s.id);
  }
});

test('园内摩天轮包含在游园时段与套票内，城市摩天轮可独立选', () => {
  const base = fixed('amusement_park_day', ['amusement_pick_three']);
  const wheel = fixed('amusement_park_day', ['amusement_pick_three', 'ferris_view']);
  assert.equal(base.ok, true); assert.equal(wheel.ok, true);
  assert.equal(wheel.stages[0].minutes, base.stages[0].minutes);
  assert.deepEqual(wheel.stages[0].costCents, base.stages[0].costCents);
  const city = fixed('ferris_wheel_ride', ['ferris_view']);
  assert.equal(city.ok, true);
  assert.ok(city.stages[0].costCents[0] > 0);
  assert.ok(city.stages[0].minutes < base.stages[0].minutes);
});

test('真实华农泰山专属地点仍要求学校与校区，通用校园短会无需冒用校内权限', () => {
  assert.equal(fixed('teaching4_study', ['read_alone'], { area: 'campus' }).ok, false);
  assert.equal(fixed('teaching4_study', ['read_alone'], { area: 'campus', school: 'scau', campusArea: 'taishan' }).ok, true);
  assert.equal(fixed('campus_exam_short_meet', [], { area: 'campus', season: 'exam' }).ok, true);
});
