import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, planDate, createContinuationSearch } from '../engine.mjs';

const scene = (id, extra = {}) => ({ id, title: id, minutes: 20, cost: [0, 0], load: 0, kind: id, area: 'campus', indoor: true, fit: 70, activities: [], ...extra });
const data = scenes => ({ version: 'required-scenes-regression', scenes, transfers: { campus: { campus: 0 } } });
const context = { duration: 150, reserve: 0, robust: false, fatigueA: 0, fatigueB: 0 };
const options = { maxStages: 3, beamWidth: 8, maxExpandedNodes: 3000, maxCandidateExpandedNodes: 0 };
const visitIds = result => result.stages.map(stage => stage.sceneId);
function feasible(result, required) {
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  for (const id of required) assert.ok(visitIds(result).includes(id), `未访问必去地点 ${id}`);
}
function finish(iterator) {
  const progress = [];
  for (let i = 0; i < 10000; i++) {
    const step = iterator.next();
    if (step.done) return { result: step.value, progress };
    progress.push(step.value);
  }
  assert.fail('生成器超过有界推进次数');
}

test('normalize 对必去集合去重并与输入隔离', () => {
  const input = { ...context, requiredSceneIds: ['play', 'prepare', 'play'], bans: ['avoid-a', 'avoid-b'] };
  const before = structuredClone(input);
  const normalized = normalize(input);
  assert.deepEqual([...normalized.requiredSceneIds].sort(), ['play', 'prepare']);
  normalized.requiredSceneIds.push('other');
  normalized.bans.push('other');
  assert.deepEqual(input, before);
});

test('必去输入为体验→准备，搜索按真实资源依赖调整为准备→体验且两者均访问', () => {
  const source = data([scene('play', { requires: ['kit'] }), scene('prepare', { provides: ['kit'] })]);
  const input = { ...context, requiredSceneIds: ['play', 'prepare'] };
  const before = structuredClone({ input, source });
  const result = planDate(input, source, { ...options, maxStages: 2 });
  feasible(result, input.requiredSceneIds);
  assert.deepEqual(visitIds(result), ['prepare', 'play']);
  assert.equal(result.stages[0].after.resources.kit, 1);
  assert.deepEqual({ input, source }, before);
});

test('多项不去全部排除，即使被排除地点具有更高评分', () => {
  const source = data([scene('avoid-a', { fit: 100 }), scene('avoid-b', { fit: 100 }), scene('allowed', { fit: 1 })]);
  const result = planDate({ ...context, bans: ['avoid-a', 'avoid-b'], requiredSceneIds: ['allowed'] }, source, options);
  feasible(result, ['allowed']);
  assert.ok(visitIds(result).every(id => !['avoid-a', 'avoid-b'].includes(id)));
});

test('必去与不去冲突或必去地点不存在时明确返回 H_REQUIRED_SCENE', () => {
  const source = data([scene('a'), scene('b')]);
  for (const input of [
    { requiredSceneIds: ['a', 'b'], bans: ['b'] },
    { requiredSceneIds: ['a', 'missing'] },
  ]) {
    const result = planDate({ ...context, ...input }, source, options);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'invalid_input');
    assert.match(result.errors.join(';'), /H_REQUIRED_SCENE/);
  }
});

test('集合必去与固定前缀、未来预约共存，不改变前缀活动及预约时间窗口', () => {
  const source = data([
    scene('intro', { activities: [{ id: 'hello', cost: [0, 0], load: 0 }] }),
    scene('prepare', { provides: ['kit'] }), scene('play', { requires: ['kit'] }), scene('booking'),
  ]);
  const input = {
    ...context, windows: [{ id: 'pm', startMinute: 840, endMinute: 1040 }],
    requiredSceneIds: ['play', 'prepare'], fixedPrefix: [{ sceneId: 'intro', activityIds: ['hello'] }],
    anchors: [{ id: 'reserved', index: 3, sceneOnly: true, sceneId: 'booking', startMinute: 940, windowId: 'pm' }],
  };
  const result = planDate(input, source, { ...options, maxStages: 4 });
  feasible(result, input.requiredSceneIds);
  assert.deepEqual(visitIds(result), ['intro', 'prepare', 'play', 'booking']);
  assert.deepEqual(result.stages[0].activityIds, ['hello']);
  assert.equal(result.stages[3].start, 940);
  assert.equal(result.stages[3].windowId, 'pm');
  assert.equal(result.stages[3].anchorId, 'reserved');
});

test('束宽 1 保留低分必去的访问进度，不能被高分非必去分支吞掉', () => {
  const source = data([scene('popular-a', { fit: 100 }), scene('popular-b', { fit: 100 }), scene('required-a', { fit: 1 }), scene('required-b', { fit: 1 })]);
  const required = ['required-b', 'required-a'];
  const result = planDate({ ...context, requiredSceneIds: required }, source, { ...options, maxStages: 2, beamWidth: 1 });
  feasible(result, required);
  assert.equal(result.stages.length, 2);
  assert.ok(result.search.beamPruned > 0, '应实际触发束剪枝');
});

test('分片生成器经过实际 yield 后仍满足所有必去及多个不去约束', () => {
  const source = data([
    scene('prepare', { provides: ['kit'] }), scene('play', { requires: ['kit'] }),
    ...Array.from({ length: 20 }, (_, i) => scene(`other-${i}`, { fit: 100 })),
  ]);
  const input = { ...context, requiredSceneIds: ['play', 'prepare'], bans: ['other-0', 'other-1'] };
  const { result, progress } = finish(createContinuationSearch(input, source, { ...options, beamWidth: 8 }));
  feasible(result, input.requiredSceneIds);
  assert.ok(progress.length > 0, '必须实际跨分片执行');
  assert.ok(visitIds(result).indexOf('prepare') < visitIds(result).indexOf('play'));
  assert.ok(visitIds(result).every(id => !input.bans.includes(id)));
});

test('阶段上限不足时同步与生成器均不得将遗漏必去的部分计划判为成功', () => {
  const source = data([scene('a'), scene('b')]);
  const input = { ...context, requiredSceneIds: ['a', 'b'] };
  const config = { ...options, maxStages: 1 };
  assert.equal(planDate(input, source, config).ok, false);
  assert.equal(finish(createContinuationSearch(input, source, config)).result.ok, false);
});
