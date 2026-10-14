import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadKnowledge, compileKnowledge, serializeArtifacts, main } from '../tools/build_catalog.mjs';
import { catalog, activities, rules, graph, sources, evidence } from '../data/catalog.mjs';

const input = await loadKnowledge();
const compiled = compileKnowledge(input);
const scene = id => catalog.scenes.find(s => s.id === id);
const activity = id => activities.find(a => a.id === id);
const changed = mutate => { const copy = structuredClone(input); mutate(copy.documents); return copy; };
const project = fileURLToPath(new URL('../', import.meta.url));

test('手工源编译与运行时导出一致，规则和图谱挂载完整', async () => {
  assert.deepEqual(compiled.catalog, catalog);
  assert.deepEqual(activities, catalog.activities);
  assert.deepEqual(catalog.rules, rules);
  assert.deepEqual(catalog.graph, graph);
  for (const [file, expected] of Object.entries(serializeArtifacts(compiled))) assert.equal(await readFile(new URL('../data/' + file, import.meta.url), 'utf8'), expected, file);
});

test('地点是名词，合并的玩法归入原去处并移除旧场景节点', () => {
  const expected = { mall: '商场', boardgame: '桌游店', taishan_glass: '泰山十栋玻璃房', switch_store: 'Switch店', mystery_store: '剧本杀店', supermarket: '泰山超市', street: '街区', rest: '休息' };
  for (const [id, name] of Object.entries(expected)) assert.equal(scene(id).title, name);
  assert.ok(catalog.scenes.every(s => s.title === s.place.name));
  const removed = ['arcade', 'groceries', 'architecture', 'photo_walk', 'campus_botany', 'campus_bakery', 'quiet_talk', 'music_corner'];
  for (const id of removed) { assert.equal(scene(id), undefined); assert.ok(!graph.nodes.some(n => n.id === id)); }
  for (const id of ['arcade_claw', 'arcade_basket', 'arcade_race']) assert.ok(scene('mall').activities.some(a => a.id === id));
  assert.equal(activity('mall_arcade'), undefined);
  assert.ok(scene('supermarket').activities.some(a => a.id === 'purchase_picnic'));
  assert.ok(scene('street').activities.some(a => a.id === 'photo_pair'));
  assert.ok(scene('taishan_glass').activities.some(a => a.id === 'breakfast_pack'));
});

test('场地基本体验和所选玩法的兴趣标签明确分开', () => {
  assert.deepEqual(scene('mall').tags, ['indoor', 'daily']);
  assert.deepEqual(activity('mall_stores').tags, ['daily']);
  assert.deepEqual(activity('mall_snacks').tags, ['food', 'daily']);
  for (const id of ['boardgame', 'switch_store', 'mystery_store']) assert.ok(!scene(id).tags.includes('play'));
  for (const id of ['badminton', 'campus_tabletennis', 'ice']) assert.ok(!scene(id).tags.includes('play') && !scene(id).tags.includes('exercise'));
  for (const id of ['aquarium', 'garden', 'street']) assert.ok(!scene(id).tags.includes('photo'));
  for (const id of ['arcade_claw', 'arcade_basket', 'arcade_race', 'boardgame_coop', 'switch_coop', 'script_mystery']) assert.ok(activity(id).tags.includes('play'));
  assert.ok(!graph.edges.some(e => e.subject === 'mall' && e.predicate === 'has_feature' && e.object === 'tag:play'));
  assert.ok(graph.edges.some(e => e.subject === 'mall' && e.predicate === 'allows_activity' && e.object === 'arcade_claw'));
});

test('原地休息无活动，交谈和听歌挂在公共休息区', () => {
  assert.equal(scene('rest').place.kind, '休息');
  assert.equal(scene('rest').area, 'current');
  assert.equal(scene('rest').kind, 'rest');
  assert.deepEqual(scene('rest').activities, []);
  assert.equal(scene('public_lounge').place.kind, 'ordinary');
  for (const id of ['talk_highlight', 'talk_next', 'music_swap', 'music_memory']) assert.ok(scene('public_lounge').activities.some(a => a.id === id));
});

test('桌游活动共享同一ID，玻璃房增量不影响桌游店', () => {
  for (const id of ['boardgame_coop', 'boardgame_cards']) {
    const shared = activity(id), inGlass = scene('taishan_glass').activities.find(a => a.id === id), inStore = scene('boardgame').activities.find(a => a.id === id);
    assert.deepEqual(shared.allowedSceneIds, ['boardgame', 'taishan_glass']);
    assert.equal(activities.filter(a => a.id === id).length, 1);
    assert.deepEqual(inGlass.cost, [0, 0]);
    assert.deepEqual(inGlass.requires, ['boardgame_kit', 'venue_checked']);
    assert.deepEqual(inStore.cost, [20, 50]);
    assert.deepEqual(inStore.requires, []);
    assert.ok(graph.edges.some(e => e.subject === 'activity-at:taishan_glass:' + id && e.predicate === 'requires' && e.object === 'resource:boardgame_kit'));
    assert.ok(!graph.edges.some(e => e.subject === id && e.predicate === 'requires' && e.object === 'resource:boardgame_kit'));
  }
});

test('玻璃房到场和正餐活动分开核算，正餐提供用餐目标', () => {
  const glass = scene('taishan_glass');
  assert.equal(glass.kind, 'explore'); assert.deepEqual(glass.provides, []); assert.deepEqual(glass.cost, [0, 0]);
  for (const id of ['glass_noodle', 'glass_burger']) {
    const meal = glass.activities.find(a => a.id === id);
    assert.ok(meal.provides.includes('meal_completed')); assert.equal(meal.exclusiveKey, 'main_meal');
    assert.equal(meal.compositionMode, 'included'); assert.equal(meal.minutes, 0); assert.ok(meal.cost[1] > 0);
  }
});

test('观影与滑冰票价放在活动，器材要求随所选玩法生效', () => {
  assert.deepEqual(scene('cinema').cost, [0, 0]);
  assert.deepEqual(scene('ice').cost, [0, 0]);
  assert.ok(scene('cinema').requires.includes('opening_checked'));
  assert.deepEqual(activity('film_pick').cost, [60, 100]);
  assert.equal(activity('film_pick').minutes, 0);
  assert.equal(scene('cinema').minutes, 120);
  assert.ok(activity('film_exchange').predecessorIds.includes('film_pick'));
  assert.deepEqual(activity('ice_slow').cost, [100, 160]);
  assert.ok(activity('ice_slow').requires.includes('closed_shoes'));
  assert.deepEqual(scene('campus_tabletennis').requires, []);
  assert.ok(activity('pingpong_rally').requires.includes('racket'));
  const prep = rules.find(r => r.id === 'R-prepare-campus_tabletennis-racket');
  assert.ok(prep.when.all.some(c => c.fact === 'activity.id' && c.value.includes('pingpong_rally')));
});

test('活动源无耗时入口，运行时活动零耗时且场景时长固定', () => {
  assert.equal(catalog.durationPolicy, 'scene_only');
  const forbidden = ['minutes', 'duration', 'durationMinutes', 'compositionMode', 'durationMode'];
  assert.ok(input.documents.activities.activities.every(a => forbidden.every(field => !Object.hasOwn(a, field))));
  assert.ok(catalog.activities.every(a => a.minutes === 0 && a.compositionMode === 'included' && a.durationMode === 'within_scene'));
  assert.ok(catalog.scenes.every(s => s.activities.every(a => a.minutes === 0 && a.compositionMode === 'included' && a.durationMode === 'within_scene')));
  for (const [id, minutes] of Object.entries({ mall: 60, cinema: 120, ice: 60, switch_store: 60, mystery_store: 90, taishan_glass: 45 })) {
    const s = scene(id);
    assert.equal(s.minutes, minutes);
    assert.equal(s.minutes + s.activities.reduce((n, a) => n + a.minutes, 0), s.minutes);
  }
  assert.throws(() => compileKnowledge(changed(d => d.activities.activities[0].minutes = 10)), /不允许活动时间字段/);
  assert.throws(() => compileKnowledge(changed(d => d.scenes.scenes.find(s => s.id === 'taishan_glass').activityOverrides.boardgame_cards.minutes = 5)), /不允许活动时间字段/);
  const edited = compileKnowledge(changed(d => d.scenes.scenes.find(s => s.id === 'mall').minutes = 75));
  assert.equal(edited.catalog.scenes.find(s => s.id === 'mall').minutes, 75);
  assert.ok(edited.catalog.scenes.find(s => s.id === 'mall').activities.every(a => a.minutes === 0));
});

test('151份来源元数据与原创摘要保留，用户设计证据明确待确认', () => {
  assert.equal(sources.length, 151);
  assert.deepEqual(new Set(sources.map(s => s.id)), new Set(input.documents['source-registry'].sources.map(s => s.id)));
  assert.ok(sources.every(s => !s.rawTextIncluded && /^[a-f0-9]{64}$/.test(s.sha256)));
  assert.ok(evidence.every(e => !e.publicExcerptAllowed && !Object.hasOwn(e, 'originalExcerpt')));
  const userEvidence = evidence.filter(e => e.sourceKind === 'user_design');
  assert.equal(userEvidence.length, 8);
  assert.ok(userEvidence.some(e => e.id === 'E-user-scau-night-stops'));
  assert.ok(userEvidence.some(e => e.id === 'E-user-campus-canteen'));
  assert.ok(userEvidence.every(e => e.sourceDocumentId === null && e.reviewStatus === 'awaiting_confirmation'));
  for (const id of ['switch_store', 'mystery_store', 'public_lounge', 'barbecue_stall', 'snack_street']) {
    assert.equal(scene(id).place.verificationStatus, 'awaiting_confirmation');
    assert.equal(scene(id).place.address, undefined); assert.equal(scene(id).place.openingHours, undefined);
  }
});

test('四餐角色均有实际用餐活动，早餐与宵夜适用语义独立', () => {
  const expected = { breakfast: ['campus_canteen', 'canteen', 'taishan_glass'], lunch: ['campus_canteen', 'canteen', 'cantonese', 'meal', 'taishan_glass', 'western'], dinner: ['campus_canteen', 'canteen', 'cantonese', 'meal', 'taishan_glass', 'western'], supper: ['barbecue_stall', 'snack_street'] };
  for (const [role, ids] of Object.entries(expected)) {
    assert.deepEqual(catalog.scenes.filter(s => s.mealRoles.includes(role)).map(s => s.id).sort(), ids.sort());
    for (const id of ids) {
      const s = scene(id), options = s.activities.filter(a => a.mealRoles.includes(role));
      assert.ok(options.length > 0);
      assert.ok(options.every(a => a.provides.includes('meal_completed') && s.mealActivityIds.includes(a.id)));
      assert.ok(!s.provides.includes('meal_completed'));
      assert.deepEqual(s.cost, [0, 0]);
    }
  }
  assert.ok(activity('breakfast_eat').cost[1] <= 20);
  assert.deepEqual(activity('breakfast_eat').mealRoles, ['breakfast']);
  assert.deepEqual(activity('breakfast_pack').provides, ['breakfast_pack']);
  assert.ok(!scene('taishan_glass').mealActivityIds.includes('breakfast_pack'));
  for (const id of ['barbecue_stall', 'snack_street']) {
    assert.equal(scene(id).minutes, 30);
    assert.deepEqual(scene(id).windows, []);
    assert.ok(scene(id).activities.every(a => a.cost[1] > 0 && a.dietaryTags.length > 0));
  }
  for (const id of ['pre_meeting', 'skip']) assert.equal(scene(id), undefined);
  for (const s of catalog.scenes) assert.deepEqual(s.mealActivityIds, s.activities.filter(a => a.provides.includes('meal_completed')).map(a => a.id));
});

test('非法餐次、无用餐活动和空场馆用餐目标在构建前被拒绝', () => {
  assert.throws(() => compileKnowledge(changed(d => d.scenes.scenes[0].mealRoles = ['midnight'])), /餐次无效/);
  assert.throws(() => compileKnowledge(changed(d => d.scenes.scenes[0].mealRoles = ['breakfast', 'breakfast'])), /重复 ID/);
  assert.throws(() => compileKnowledge(changed(d => d.scenes.scenes.find(s => s.id === 'rest').mealRoles = ['breakfast'])), /缺少适用的用餐活动/);
  assert.throws(() => compileKnowledge(changed(d => d.scenes.scenes.find(s => s.id === 'canteen').provides = ['meal_completed'])), /用餐目标须由所选活动提供/);
  assert.throws(() => compileKnowledge(changed(d => d.activities.activities.find(a => a.id === 'breakfast_eat').provides = [])), /用餐活动须提供|缺少适用的用餐活动/);
  assert.throws(() => compileKnowledge(changed(d => d.scenes.scenes.find(s => s.id === 'canteen').mealActivityIds = ['canteen_pair'])), /由构建器生成/);
  assert.throws(() => compileKnowledge(changed(d => d.activities.activities.find(a => a.id === 'breakfast_eat').mealRoles = ['supper'])), /缺少适用的用餐活动|超出地点适用范围/);
  assert.throws(() => compileKnowledge(changed(d => d.activities.activities.find(a => a.id === 'breakfast_eat').mealRoles = [])), /须声明适用餐次/);
});

test('华农自述地点具有校内与泰山区属性，引用本地定位证据', () => {
  const expected = { canteen: '芷园食堂', campus_tabletennis: '泰山区12、15、16栋乒乓球桌', campus: '泰山区宿舍间步道', bridge_walk: '综合体育馆后桥', track_walk: '东区运动场外圈', supermarket: '泰山超市', taishan_glass: '泰山十栋玻璃房', taishan_supermarket_front: '泰山超市门口', teaching4_study: '教四教室', teaching4_slope: '教四后坡路', taishan_lab_garden: '泰山实验楼架空层花园' };
  for (const [id, name] of Object.entries(expected)) {
    const s = scene(id);
    assert.equal(s.title, name); assert.equal(s.scauOnly, true); assert.equal(s.area, 'campus');
    assert.equal(s.place.universityId, 'scau'); assert.equal(s.place.campusArea, 'taishan');
    assert.equal(s.place.verificationStatus, 'awaiting_confirmation');
    assert.ok(s.evidenceIds.some(id => evidence.find(e => e.id === id)?.sourceDocumentId === 'SRC-9d52a0728f3d'));
  }
  assert.match(scene('taishan_glass').description, /西点屋/);
  assert.match(scene('canteen').description, /蜜雪冰城/);
  assert.match(scene('campus_tabletennis').description, /自带球拍和球/);
  assert.throws(() => compileKnowledge(changed(d => d.scenes.scenes.find(s => s.id === 'canteen').area = 'near')), /华农泰山区属性/);
});

test('离开目录独立于地点，默认各自回去且酒店须过夜并明确选择', () => {
  assert.deepEqual(catalog.departures.map(d => d.id), ['hotel', 'separate', 'walk_together']);
  assert.equal(catalog.defaultDepartureId, 'separate'); assert.equal(catalog.defaultCityTier, 'tier1');
  assert.equal(compiled.metadata.defaultContext.departureChoice, 'separate'); assert.equal(compiled.metadata.defaultContext.cityTier, 'tier1');
  for (const d of catalog.departures) {
    assert.equal(scene(d.id), undefined); assert.equal(activity(d.id), undefined);
    assert.equal(d.assertionKind, 'designed'); assert.equal(d.parameterStatus, 'designed_not_measured');
    assert.ok(d.evidenceIds.every(id => evidence.some(e => e.id === id && e.assertionKind === 'designed')));
    assert.ok(graph.nodes.some(n => n.id === d.id && n.type === 'departure'));
    assert.ok(!graph.edges.some(e => e.subject === d.id && e.predicate === 'allows_activity'));
  }
  const byId = Object.fromEntries(catalog.departures.map(d => [d.id, d]));
  assert.equal(byId.separate.minutes, 5); assert.deepEqual(byId.separate.cost, [0, 0]);
  assert.equal(byId.walk_together.minutes, 30); assert.deepEqual(byId.walk_together.cost, [0, 0]);
  assert.equal(byId.hotel.minutes, 15); assert.equal(byId.hotel.onlyOvernight, true); assert.equal(byId.hotel.requiresExplicitChoice, true);
  assert.equal(byId.hotel.costUnit, 'CNY_per_room_for_two_per_night');
  assert.deepEqual(byId.hotel.costByCityTier, { tier1: [200, 400], tier2: [150, 300], tier3: [100, 250] });
  assert.match(evidence.find(e => e.id === 'E-user-departures').verificationBoundary, /初版设计参数/);
  assert.deepEqual(compiled.conditions.find(c => c.key === 'cityTier').allowedValues, ['tier1', 'tier2', 'tier3']);
});

test('非法离开引用、默认住宿、自动住宿与房费在构建前拒绝', () => {
  const hotel = d => d.departures.departures.find(x => x.id === 'hotel');
  assert.throws(() => compileKnowledge(changed(d => d.departures.defaultId = 'hotel')), /defaultId/);
  assert.throws(() => compileKnowledge(changed(d => hotel(d).onlyOvernight = false)), /仅在过夜/);
  assert.throws(() => compileKnowledge(changed(d => hotel(d).requiresExplicitChoice = false)), /明确选择/);
  assert.throws(() => compileKnowledge(changed(d => hotel(d).minutes = 0)), /minutes/);
  assert.throws(() => compileKnowledge(changed(d => hotel(d).evidenceIds = ['E-missing'])), /不存在的 ID/);
  assert.throws(() => compileKnowledge(changed(d => hotel(d).evidenceIds = ['E-campus-food'])), /designed 依据/);
  assert.throws(() => compileKnowledge(changed(d => hotel(d).costByCityTier.tier1 = [-1, 400])), /有效费用区间/);
  assert.throws(() => compileKnowledge(changed(d => delete hotel(d).costByCityTier.tier2)), /完整列出三档/);
  assert.throws(() => compileKnowledge(changed(d => hotel(d).activityIds = [])), /独立离开数据/);
  assert.throws(() => compileKnowledge(changed(d => d.metadata.defaultContext.cityTier = 'tier4')), /cityTier/);
  assert.throws(() => compileKnowledge(changed(d => d.departures.departures.push(hotel(d)))), /ID 重复/);
  assert.notEqual(compileKnowledge(changed(d => hotel(d).costByCityTier.tier1 = [210, 410])).catalog.contentRevision, compiled.catalog.contentRevision);
});

test('图节点与边唯一，证据和端点闭环', () => {
  assert.equal(new Set(graph.nodes.map(n => n.id)).size, graph.nodes.length);
  assert.equal(new Set(graph.edges.map(e => e.id)).size, graph.edges.length);
  const nodes = new Set(graph.nodes.map(n => n.id)), ev = new Set(evidence.map(e => e.id));
  for (const edge of graph.edges) { assert.ok(nodes.has(edge.subject) && nodes.has(edge.object)); assert.ok(edge.evidenceIds.length); assert.ok(edge.evidenceIds.every(id => ev.has(id))); }
  assert.equal(graph.edges.filter(e => e.predicate === 'allows_activity').length, catalog.scenes.reduce((n, s) => n + s.activities.length, 0));
});

test('未知活动、重复ID、悬空override和跨类型冲突在构建前报错', () => {
  assert.throws(() => compileKnowledge(changed(d => d.scenes.scenes[0].activityIds.push('missing_activity'))), /不存在的 ID/);
  assert.throws(() => compileKnowledge(changed(d => d.activities.activities.push(d.activities.activities[0]))), /ID 重复/);
  assert.throws(() => compileKnowledge(changed(d => d.scenes.scenes[0].activityOverrides = { missing_activity: { cost: [0, 0] } })), /未挂载/);
  assert.throws(() => compileKnowledge(changed(d => d.activities.activities[0].id = d.scenes.scenes[0].id)), /地点与活动 ID/);
});

test('未知来源、证据、资源、先行活动和非法规则被拒绝', () => {
  assert.throws(() => compileKnowledge(changed(d => d.evidence.evidence[0].sourceDocumentId = 'SRC-missing')), /来源不存在/);
  assert.throws(() => compileKnowledge(changed(d => d.activities.activities[0].evidenceIds = ['E-missing'])), /不存在的 ID/);
  assert.throws(() => compileKnowledge(changed(d => d.activities.activities[0].requires = ['missing_kit'])), /不存在的 ID/);
  assert.throws(() => compileKnowledge(changed(d => d.activities.activities[0].predecessorIds = ['missing_prior'])), /不存在的 ID/);
  assert.throws(() => compileKnowledge(changed(d => d.rules.rules[0].when.all = [{ fact: 'scene.id', op: 'eq', value: 'arcade' }])), /条件引用无效/);
  assert.throws(() => compileKnowledge(changed(d => d.rules.rules[0].then = [{ action: 'unknown_action' }])), /规则动作无效/);
});

test('原文发布、伪造已核实信息、负价格和休息玩法被拒绝', () => {
  assert.throws(() => compileKnowledge(changed(d => d.evidence.evidence[0].originalExcerpt = '不可公开的原文')), /只允许原创摘要/);
  assert.throws(() => compileKnowledge(changed(d => d.scenes.scenes[0].place.openingHours = '全天营业')), /未核实/);
  assert.throws(() => compileKnowledge(changed(d => d.activities.activities[0].cost = [-1, 10])), /费用区间/);
  assert.throws(() => compileKnowledge(changed(d => d.scenes.scenes.find(s => s.id === 'rest').activityIds = ['music_swap'])), /原地休息须无活动/);
});

test('手工修改可传播且编译不改源，相同输入产生相同字节', () => {
  const before = JSON.stringify(input);
  assert.deepEqual(serializeArtifacts(compileKnowledge(input)), serializeArtifacts(compileKnowledge(input)));
  assert.equal(JSON.stringify(input), before);
  const edit = changed(d => {
    d.scenes.scenes.find(s => s.id === 'mall').place.name = '测试商场';
    d.activities.activities.find(a => a.id === 'arcade_claw').cost = [12, 18];
  });
  const next = compileKnowledge(edit);
  assert.equal(next.catalog.scenes.find(s => s.id === 'mall').title, '测试商场');
  assert.deepEqual(next.catalog.scenes.find(s => s.id === 'mall').activities.find(a => a.id === 'arcade_claw').cost, [12, 18]);
  assert.equal(catalog.scenes.find(s => s.id === 'mall').title, '商场');
});

test('编译器禁止把输出写进手工源', async () => {
  await assert.rejects(main(['--output', fileURLToPath(new URL('../knowledge/', import.meta.url))]), /输出目录不能是手工源/);
});

test('旧语料入口默认拒绝，并在读取语料前阻止覆盖编辑源', { skip: !process.env.DATEMATE_PYTHON }, () => {
  for (const args of [[], ['--extract-candidates', '--output', 'data'], ['--extract-candidates', '--output', 'knowledge/subdir']]) {
    const r = spawnSync(process.env.DATEMATE_PYTHON, ['tools/build_knowledge.py', ...args], { cwd: project, timeout: 10000, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /build_catalog|候选输出不得/);
  }
});
