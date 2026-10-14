import test from 'node:test';
import assert from 'node:assert/strict';
import { loadKnowledge, compileKnowledge } from '../tools/build_catalog.mjs';

const input = await loadKnowledge();
const scenes = compileKnowledge(input).catalog.scenes;
const allows = (scene, minute) => scene.dailyWindows.some(w => w.startMinute <= minute && minute < w.endMinute);

test('全部场景显式登记规划默认时段，凌晨仅校园线索地点、宵夜和原地休息', () => {
  assert.ok(scenes.every(s => s.dailyWindows.length && s.availabilityBasis === 'planning_default' && s.availabilityNote));
  assert.deepEqual(scenes.filter(s => allows(s, 1410)).map(s => s.id).sort(), ['barbecue_stall', 'camellia_garden', 'east_lab_stop', 'faculty_rooftop_stars', 'orchid_garden', 'rest', 'scau_wandering', 'snack_street']);
  assert.deepEqual(scenes.filter(s => allows(s, 60)).map(s => s.id).sort(), ['camellia_garden', 'east_lab_stop', 'faculty_rooftop_stars', 'orchid_garden', 'rest', 'scau_wandering']);
  for (const id of ['barbecue_stall', 'snack_street']) {
    const scene = scenes.find(s => s.id === id);
    assert.equal(scene.minutes, 30);
    assert.ok(allows(scene, 29)); assert.equal(allows(scene, 30), false);
  }
});

test('用户新增华农夜间停留地是学校级归属，未冒用泰山或官方开放结论', () => {
  for (const id of ['east_lab_stop', 'camellia_garden', 'orchid_garden']) {
    const scene = scenes.find(s => s.id === id);
    assert.equal(scene.place.universityId, 'scau'); assert.equal(scene.place.campusArea, '');
    assert.equal(scene.scauOnly, true); assert.equal(scene.minutes, 60);
    assert.equal(scene.availabilityClueSource, 'user-provided');
    assert.equal(scene.place.verificationStatus, 'awaiting_confirmation');
    assert.equal(scene.place.openingHours, undefined);
  }
});

test('构建拒绝省略、空、越界、重叠或未排序每日时段及不明时间依据', () => {
  for (const change of [s => delete s.dailyWindows, s => s.dailyWindows = [], s => s.dailyWindows = [{ startMinute: 1200, endMinute: 1500 }], s => s.dailyWindows = [{ startMinute: 600, endMinute: 900 }, { startMinute: 800, endMinute: 1000 }], s => s.availabilityBasis = 'official']) {
    const copy = structuredClone(input); change(copy.documents.scenes.scenes[0]);
    assert.throws(() => compileKnowledge(copy), /dailyWindows|availabilityBasis/);
  }
});

test('既有绝对时间窗保留，不与每日时段互相替换', () => {
  const raw = input.documents.scenes.scenes.find(s => s.id === 'agriculture_museum');
  assert.deepEqual(scenes.find(s => s.id === raw.id).windows, raw.windows);
});
