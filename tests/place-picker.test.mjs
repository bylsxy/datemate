import test from 'node:test';
import assert from 'node:assert/strict';
import { searchPlaces, addPlace, createPlacePicker } from '../place-picker.mjs';

const scenes = [
  { id: 'campus_library', title: '华农图书馆', aliases: ['Library', '读书空间'], keywords: ['安静', '室内'] },
  { id: 'lake_walk', title: '湖边散步', aliases: ['Lakeside'], keywords: ['户外', '拍照'] },
  { id: 'coffee_shop', title: '咖啡馆', aliases: ['Cafe'], keywords: ['室内'] },
  { id: 'rest', title: '休息', kind: 'rest', aliases: ['Library', '休息空间'] },
];
const ids = matches => matches.map(scene => scene.id);
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

test('地点搜索支持中文、英文 ID、aliases、keywords 和大小写空白', () => {
  for (const query of ['图书', 'CAMPUS_LIBRARY', ' library ', '读书空间', '安静']) {
    assert.deepEqual(ids(searchPlaces(scenes, query)), ['campus_library'], query);
  }
  assert.deepEqual(ids(searchPlaces(scenes, 'lakeside')), ['lake_walk']);
});

test('多词要求全部匹配，空查询可浏览，无匹配返回空列表，始终排除 rest', () => {
  assert.deepEqual(ids(searchPlaces(scenes, '华农   LIBRARY\t室内')), ['campus_library']);
  assert.deepEqual(searchPlaces(scenes, '图书馆 户外'), []);
  assert.deepEqual(searchPlaces(scenes, '不存在地点'), []);
  assert.deepEqual(searchPlaces(scenes, '休息'), []);
  assert.deepEqual(ids(searchPlaces(scenes, '  ')), ['campus_library', 'lake_walk', 'coffee_shop']);
  const before = structuredClone(scenes);
  searchPlaces(freeze(structuredClone(scenes)), 'library');
  assert.deepEqual(scenes, before);
});

for (const kind of ['bans', 'requiredSceneIds']) {
  test(`${kind} 可添加多个地点并去重，返回独立数组且不改变原输入`, () => {
    const other = kind === 'bans' ? 'requiredSceneIds' : 'bans';
    const input = freeze({ [kind]: ['campus_library'], [other]: ['coffee_shop'] });
    const next = addPlace(input, kind, 'lake_walk', scenes);
    assert.deepEqual(next[kind], ['campus_library', 'lake_walk']);
    assert.deepEqual(next[other], ['coffee_shop']);
    const repeated = addPlace(next, kind, 'lake_walk', scenes);
    assert.deepEqual(repeated, next);
    assert.notEqual(next[kind], input[kind]);
    assert.notEqual(next[other], input[other]);
    repeated[kind].push('new');
    assert.deepEqual(next[kind], ['campus_library', 'lake_walk']);
    assert.deepEqual(input[kind], ['campus_library']);
  });

  test(`${kind} 拒绝对侧冲突、缺失和休息地点，失败不改变输入`, () => {
    const other = kind === 'bans' ? 'requiredSceneIds' : 'bans';
    const input = freeze({ [kind]: ['campus_library'], [other]: ['lake_walk'] });
    const before = structuredClone(input);
    assert.throws(() => addPlace(input, kind, 'lake_walk', scenes), /已在.*请先移除/);
    for (const id of ['', 'missing', 'rest']) {
      assert.throws(() => addPlace(input, kind, id, scenes), /选择一个地点/);
    }
    assert.deepEqual(input, before);
  });
}

test('缺省两类列表可初始化，非法类别明确拒绝', () => {
  assert.deepEqual(addPlace({}, 'bans', 'lake_walk', scenes), { bans: ['lake_walk'], requiredSceneIds: [] });
  assert.deepEqual(addPlace({}, 'requiredSceneIds', 'lake_walk', scenes), { bans: [], requiredSceneIds: ['lake_walk'] });
  assert.throws(() => addPlace({}, 'anchor', 'lake_walk', scenes), /不去或必去/);
});

// 只模拟事件与控件状态，验证提交边界；不加载浏览器或第三方 DOM。
function pickerFixture() {
  const elements = new Map();
  const listeners = new Map();
  for (const id of ['place-search', 'place-select', 'place-choice-error', 'add-exclude', 'add-anchor', 'excluded-places', 'anchored-places']) {
    const handlers = new Map();
    elements.set(`#${id}`, {
      value: '', innerHTML: '', textContent: '', disabled: false, focused: false,
      addEventListener: (event, handler) => handlers.set(event, handler),
      emit: (event, detail = {}) => handlers.get(event)?.(detail),
      focus() { this.focused = true; },
    });
  }
  const root = { querySelector: id => elements.get(id), addEventListener: (event, handler) => listeners.set(event, handler) };
  let changes = 0;
  const picker = createPlacePicker({ root, scenes, onChange: () => changes++ });
  return { picker, element: id => elements.get(`#${id}`), changes: () => changes,
    remove: (kind, id) => listeners.get('click')({ target: { closest: () => ({ dataset: { kind, removePlace: id } }) } }) };
}

test('搜索与下拉浏览不提交规划，实际添加/删除才提交，重复及冲突只显示提示', () => {
  const f = pickerFixture();
  f.element('place-search').value = '湖边';
  f.element('place-search').emit('input');
  assert.equal(f.element('place-select').value, 'lake_walk');
  assert.equal(f.changes(), 0);
  let prevented = false;
  f.element('place-search').emit('keydown', { key: 'Enter', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.element('place-select').focused, true);
  f.element('place-select').emit('change');
  assert.equal(f.changes(), 0);
  f.element('add-anchor').emit('click');
  assert.deepEqual(f.picker.getChoices(), { bans: [], requiredSceneIds: ['lake_walk'] });
  assert.equal(f.changes(), 1);
  f.element('add-anchor').emit('click');
  assert.match(f.element('place-choice-error').textContent, /已经添加/);
  f.element('add-exclude').emit('click');
  assert.match(f.element('place-choice-error').textContent, /已在必去/);
  assert.equal(f.changes(), 1);
  f.remove('requiredSceneIds', 'lake_walk');
  assert.deepEqual(f.picker.getChoices(), { bans: [], requiredSceneIds: [] });
  assert.equal(f.changes(), 2);
  f.element('place-search').value = '不存在';
  f.element('place-search').emit('input');
  assert.equal(f.element('place-select').disabled, true);
  assert.equal(f.element('add-exclude').disabled, true);
  assert.equal(f.element('add-anchor').disabled, true);
  assert.equal(f.changes(), 2);
});

test('恢复多个地点及旧 sceneOnly 数据不提交，读写结果与调用方数组隔离', () => {
  const f = pickerFixture();
  const input = { bans: ['lake_walk', 'coffee_shop'], requiredSceneIds: ['campus_library'] };
  f.picker.setChoices(input);
  input.bans.push('missing');
  const output = f.picker.getChoices();
  output.requiredSceneIds.length = 0;
  assert.deepEqual(f.picker.getChoices(), { bans: ['lake_walk', 'coffee_shop'], requiredSceneIds: ['campus_library'] });
  f.picker.setChoices({ anchors: [
    { sceneOnly: true, choice: { sceneId: 'lake_walk' } },
    { sceneOnly: false, choice: { sceneId: 'coffee_shop' } },
  ] });
  assert.deepEqual(f.picker.getChoices(), { bans: [], requiredSceneIds: ['lake_walk'] });
  assert.equal(f.changes(), 0);
});
