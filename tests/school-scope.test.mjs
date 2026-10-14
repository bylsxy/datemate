import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSchoolScope, isSceneInSchoolScope } from '../school-scope.mjs';
import { normalize, planDate } from '../engine.mjs';
import { loadKnowledge, compileKnowledge } from '../tools/build_catalog.mjs';

const loaded = await loadKnowledge();
const { catalog } = compileKnowledge(loaded);
const context = { duration: 120, reserve: 0, robust: false, fatigueA: 0, fatigueB: 0 };
const makeScene = (id, extra = {}) => ({ id, title: id, minutes: 20, cost: [0, 0], load: 0, kind: 'culture', area: 'campus', indoor: true, quiet: true, tags: [], activities: [], ...extra });
const taishan = makeScene('taishan', { place: { universityId: 'scau', campusArea: 'taishan' } });
const university = makeScene('university', { place: { universityId: 'scau', campusArea: '' } });
const generic = makeScene('generic');
const synthetic = { version: 'school-scope-test', scenes: [generic, university, taishan, makeScene('near', { area: 'near' }), makeScene('off', { area: 'off' }), makeScene('rest', { kind: 'rest', area: 'current', load: -2 })] };
const choices = result => [...result.stages.flatMap(s => [s.sceneId, ...s.candidates.map(c => c.sceneId)]), ...(result.mealRequirements || []).flatMap(m => m.candidates.map(c => c.sceneId)), ...result.paretoPlans.flatMap(p => (p.stages || []).map(s => s.sceneId))];

test('学校和宿舍区依赖范围归一化，all和未知选择不能保留专属地点权限', () => {
  const rows = [
    [{}, { school: '', campusArea: '' }],
    [{ area: 'all', school: 'scau', campusArea: 'taishan' }, { school: '', campusArea: '' }],
    [{ area: 'campus', campusArea: 'taishan' }, { school: '', campusArea: '' }],
    [{ area: 'near', school: 'scau' }, { school: 'scau', campusArea: '' }],
    [{ area: 'nearby', school: 'scau', campusArea: 'taishan' }, { school: 'scau', campusArea: 'taishan' }],
    [{ area: 'campus', school: 'other', campusArea: 'taishan' }, { school: '', campusArea: '' }],
    [{ area: 'campus', school: 'scau', campusArea: 'other' }, { school: 'scau', campusArea: '' }],
  ];
  for (const [input, expected] of rows) {
    assert.deepEqual(normalizeSchoolScope(input), expected);
    const normalized = normalize(input);
    assert.deepEqual({ school: normalized.school, campusArea: normalized.campusArea }, expected);
  }
  assert.equal(normalize({ context: { area: 'campus', school: 'scau', campusArea: 'taishan' }, area: 'all' }).school, '');
});

test('通用校园、学校级、泰山区三层权限及活动范围使用同一个helper', () => {
  for (const area of ['all', 'campus', 'near']) {
    assert.equal(isSceneInSchoolScope(generic, { area }), true);
    assert.equal(isSceneInSchoolScope(university, { area }), false);
    assert.equal(isSceneInSchoolScope(taishan, { area }), false);
  }
  assert.equal(isSceneInSchoolScope(university, { area: 'campus', school: 'scau' }), true);
  assert.equal(isSceneInSchoolScope(taishan, { area: 'campus', school: 'scau' }), false);
  assert.equal(isSceneInSchoolScope(taishan, { area: 'near', school: 'scau', campusArea: 'taishan' }), true);
  assert.equal(isSceneInSchoolScope(university, { area: 'campus', school: 'scau', campusArea: 'taishan' }), true);
  assert.equal(isSceneInSchoolScope(taishan, { area: 'all', school: 'scau', campusArea: 'taishan' }), false);
  assert.equal(isSceneInSchoolScope(makeScene('legacy', { scauOnly: true }), { area: 'campus' }), false);
  assert.equal(isSceneInSchoolScope(makeScene('invalid', { place: { campusArea: 'taishan' } }), { area: 'campus', school: 'scau', campusArea: 'taishan' }), false);
  assert.equal(isSceneInSchoolScope(synthetic.scenes.find(s => s.id === 'near'), { area: 'campus' }), false);
  assert.equal(isSceneInSchoolScope(synthetic.scenes.find(s => s.id === 'off'), { area: 'near' }), false);
  assert.equal(isSceneInSchoolScope(synthetic.scenes.find(s => s.id === 'rest'), { area: 'campus' }), true);
});

test('全部场景显式声明学校属性，名称类别描述中的华农地点没有漏标', () => {
  assert.equal(catalog.scenes.length, loaded.documents.scenes.scenes.length);
  assert.ok(catalog.scenes.filter(s => s.place.universityId === '').length >= 29);
  const schoolIds = catalog.scenes.filter(s => s.place.universityId === 'scau').map(s => s.id);
  assert.equal(schoolIds.length, 16);
  assert.equal(catalog.scenes.filter(s => s.place.universityId === 'scau' && s.place.campusArea === '').length, 5);
  assert.equal(catalog.scenes.filter(s => s.place.campusArea === 'taishan').length, 11);
  for (const scene of catalog.scenes) {
    assert.ok(['', 'scau'].includes(scene.place.universityId), scene.id);
    assert.ok(['', 'taishan'].includes(scene.place.campusArea), scene.id);
    assert.equal(scene.scauOnly, scene.place.universityId === 'scau');
    if (/华农|泰山|教四|芷园|紫荆桥/.test([scene.place.name, scene.place.category, scene.description].join(' '))) assert.equal(scene.place.universityId, 'scau', scene.id);
    if (!scene.place.universityId) assert.equal(scene.place.campusArea, '', scene.id);
  }
  const museum = catalog.scenes.find(s => s.id === 'agriculture_museum');
  assert.equal(museum.place.universityId, 'scau');
  assert.equal(museum.place.campusArea, '');
  assert.equal(isSceneInSchoolScope(museum, { area: 'campus' }), false);
  assert.equal(isSceneInSchoolScope(museum, { area: 'campus', school: 'scau' }), true);
});

test('校内游荡保留稳定ID并适用于通用校园，院楼顶楼看星星仍为学校级', () => {
  const wandering = catalog.scenes.find(s => s.id === 'scau_wandering');
  assert.ok(wandering);
  assert.equal(wandering.title, '校内游荡');
  assert.equal(wandering.place.name, '校内游荡');
  assert.equal(wandering.scauOnly, false);
  assert.equal(wandering.place.universityId, '');
  assert.equal(wandering.place.campusArea, '');
  for (const area of ['all', 'campus', 'near']) for (const school of ['', 'other', 'scau']) {
    assert.equal(isSceneInSchoolScope(wandering, { area, school, campusArea: 'taishan' }), true, `${area}/${school}`);
  }
  for (const id of ['faculty_rooftop_stars']) {
    const scene = catalog.scenes.find(s => s.id === id);
    assert.ok(scene, id);
    assert.equal(scene.place.universityId, 'scau', id);
    assert.equal(scene.place.campusArea, '', id);
    for (const area of ['campus', 'near']) {
      for (const campusArea of ['', 'taishan', 'other']) {
        assert.equal(isSceneInSchoolScope(scene, { area, campusArea }), false, `${id}/${area}/${campusArea}`);
        assert.equal(isSceneInSchoolScope(scene, { area, school: 'scau', campusArea }), true, `${id}/${area}/${campusArea}`);
      }
    }
    assert.equal(isSceneInSchoolScope(scene, { area: 'all', school: 'scau', campusArea: 'taishan' }), false, id);
  }
});

test('未选华农的真实目录在校内及周边night自动规划包含通用校园停留', () => {
  for (const area of ['campus', 'near']) for (const school of ['', 'other']) {
    const result = planDate({ ...context, area, school, campusArea: 'taishan', periodIds: ['night'] }, catalog);
    assert.equal(result.ok, true, `${area}/${school}: ${result.errors.join(';')}`);
    assert.ok(result.stages.some(s => ['scau_wandering', 'dorm_downstairs_shelter'].includes(s.sceneId)), `${area}/${school}`);
    assert.ok(choices(result).every(id => isSceneInSchoolScope(catalog.scenes.find(s => s.id === id), result.context)));
    assert.ok(!choices(result).includes('faculty_rooftop_stars'));
    assert.equal(result.metrics.periodCoverageSatisfied, true);
    assert.equal(result.metrics.endingCoverageSatisfied, true);
  }
});

test('构建器拒绝未知学校、未知校区和不一致的专属地点属性', () => {
  const invalid = mutate => { const copy = structuredClone(loaded); mutate(copy.documents.scenes.scenes.find(s => s.id === 'taishan_supermarket_front')); return copy; };
  assert.throws(() => compileKnowledge(invalid(s => { s.place.universityId = 'unknown'; })), /universityId/);
  assert.throws(() => compileKnowledge(invalid(s => { s.place.campusArea = 'unknown'; })), /campusArea/);
  assert.throws(() => compileKnowledge(invalid(s => { s.place.universityId = ''; })), /从属于学校/);
  assert.throws(() => compileKnowledge(invalid(s => { s.area = 'near'; })), /须位于校内/);
  assert.throws(() => compileKnowledge(invalid(s => { s.scauOnly = false; })), /scauOnly 一致/);
});

test('探索和普通候选、最终行程均不泄漏未选择的学校或宿舍区专属场景', () => {
  for (const area of ['all', 'near', 'campus']) for (const exploration of [0, 100]) {
    const result = planDate({ ...context, area, exploration, school: area === 'all' ? 'scau' : '', campusArea: 'taishan' }, synthetic, { maxStages: 3 });
    assert.equal(result.ok, true);
    assert.ok(choices(result).every(id => !['university', 'taishan'].includes(id)));
  }
  const schoolOnly = planDate({ ...context, area: 'campus', school: 'scau', exploration: 100 }, synthetic, { maxStages: 3 });
  assert.equal(schoolOnly.ok, true);
  assert.ok(choices(schoolOnly).includes('university'));
  assert.ok(!choices(schoolOnly).includes('taishan'));
  const district = planDate({ ...context, area: 'campus', school: 'scau', campusArea: 'taishan', fixedPrefix: [{ sceneId: 'taishan' }] }, synthetic, { maxStages: 1 });
  assert.equal(district.ok, true);
});

test('人工固定前缀、锚点、必去地点不能绕过学校或宿舍区校验', () => {
  for (const manual of [{ fixedPrefix: [{ sceneId: 'taishan' }] }, { anchors: [{ sceneId: 'taishan' }] }, { requiredSceneIds: ['taishan'] }]) {
    const rejected = planDate({ ...context, area: 'campus', school: 'scau', ...manual }, synthetic);
    assert.equal(rejected.ok, false);
    assert.ok(rejected.errors.some(e => e.startsWith('H_SCHOOL_SCOPE:')));
  }
});

test('饭点餐卡及未评估菜单过滤学校专属地点，固定餐馆同样校验', () => {
  const eating = { id: 'eat', cost: [0, 0], load: 0, tags: [], provides: ['meal_completed'], mealRoles: ['breakfast'] };
  const meals = { ...synthetic, scenes: [...synthetic.scenes, makeScene('generic_meal', { kind: 'meal', mealRoles: ['breakfast'], activities: [eating] }), makeScene('school_meal', { kind: 'meal', place: taishan.place, mealRoles: ['breakfast'], activities: [eating] })], departures: [{ id: 'separate', minutes: 15, cost: [0, 0] }] };
  const input = { ...context, area: 'campus', periodIds: ['morning'], exploration: 100 };
  const result = planDate(input, meals, { maxStages: 4 });
  assert.equal(result.ok, true);
  assert.ok(result.mealRequirements[0].candidates.some(c => c.sceneId === 'generic_meal'));
  assert.ok(!choices(result).includes('school_meal'));
  const fixed = planDate({ ...input, mealChoices: { breakfast: { mode: 'together', sceneId: 'school_meal', activityIds: ['eat'] } } }, meals);
  assert.equal(fixed.ok, false);
  assert.ok(fixed.errors.some(e => e.startsWith('H_SCHOOL_SCOPE:')));
});

test('通用校园食堂及其挂载活动只有原创设计依据，不把华农地点事实推广到所有学校', () => {
  const canteen = catalog.scenes.find(s => s.id === 'campus_canteen');
  assert.equal(canteen.title, '校园食堂');
  assert.equal(canteen.area, 'campus');
  assert.equal(canteen.place.universityId, '');
  assert.equal(canteen.place.campusArea, '');
  assert.equal(canteen.scauOnly, false);
  assert.equal(canteen.place.verificationStatus, 'awaiting_confirmation');
  assert.equal(canteen.parameterStatus, 'designed_not_measured');
  assert.deepEqual(canteen.mealRoles, ['breakfast', 'lunch', 'dinner']);
  for (const entity of [canteen, ...canteen.activities]) {
    assert.equal(entity.assertionKind, 'designed');
    assert.equal(entity.evidenceStatus, 'user_design_real_world_unverified');
    for (const id of entity.evidenceIds) {
      const evidence = loaded.documents.evidence.evidence.find(e => e.id === id);
      assert.equal(evidence.sourceKind, 'user_design');
      assert.equal(evidence.sourceDocumentId, null);
      assert.equal(evidence.reviewStatus, 'awaiting_confirmation');
    }
  }
});

test('未选华农的真实目录在校内及校内周边均可规划早餐、午餐、晚餐', () => {
  for (const area of ['campus', 'near']) for (const exploration of [0, 100]) {
    const result = planDate({ ...context, area, school: '', campusArea: '', periodIds: ['morning', 'afternoon', 'evening'], exploration }, catalog);
    assert.equal(result.ok, true, `${area}/${exploration}: ${result.errors.join(';')}`);
    assert.deepEqual(result.mealRequirements.map(m => m.mealRole), ['breakfast', 'lunch', 'dinner']);
    for (const meal of result.mealRequirements) {
      assert.equal(meal.satisfied, true);
      const stage = result.stages[meal.stageIndex];
      const scene = catalog.scenes.find(s => s.id === stage.sceneId);
      assert.equal(scene.place.universityId, '');
      assert.ok(stage.activityIds.some(id => scene.activities.some(a => a.id === id && a.provides.includes('meal_completed') && a.mealRoles.includes(meal.mealRole))));
    }
    const breakfast = result.mealRequirements.find(m => m.mealRole === 'breakfast');
    assert.ok(['campus_canteen', 'dorm_takeaway_meal'].includes(breakfast.sceneId));
    assert.ok(choices(result).every(id => isSceneInSchoolScope(catalog.scenes.find(s => s.id === id), result.context)));
    assert.equal(result.metrics.mealSatisfied, true);
    assert.equal(result.metrics.periodCoverageSatisfied, true);
    assert.equal(result.metrics.endingCoverageSatisfied, true);
  }
});
