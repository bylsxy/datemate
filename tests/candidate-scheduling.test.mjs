import test from 'node:test';
import assert from 'node:assert/strict';
import {createCandidateScheduler} from '../candidate-validation.mjs';

// 等待时间和计算时间分开推进；保留已取消回调，用于模拟旧轮回调迟到。
class ManualClock {
  time = 0;
  serial = 0;
  turn = 0;
  queue = new Map();
  history = new Map();
  cancelled = new Set();
  scheduled = [];
  ticks = [];

  now = () => this.time;
  schedule = (callback, delay) => {
    assert.ok(Number.isFinite(delay) && delay >= 0, '调度延迟必须有限且非负');
    const id = ++this.serial;
    const task = {callback, delay, at:this.time + delay};
    this.queue.set(id, task);
    this.history.set(id, task);
    this.scheduled.push({id, delay});
    return id;
  };
  cancel = id => {
    this.cancelled.add(id);
    this.queue.delete(id);
  };
  work(ms) {this.time += ms;}
  pendingId() {
    assert.equal(this.queue.size, 1, '同一调度器只能等待一个回调');
    return this.queue.keys().next().value;
  }
  next() {
    const pending = [...this.queue].sort((a,b) => a[1].at-b[1].at || a[0]-b[0])[0];
    assert.ok(pending, '应有待执行的调度回调');
    const [id, task] = pending;
    this.queue.delete(id);
    this.time = Math.max(this.time, task.at);
    const started = this.time;
    this.turn++;
    task.callback();
    this.ticks.push({turn:this.turn, computeMs:this.time-started});
  }
  fireCancelled(id) {
    assert.ok(this.cancelled.has(id), '只能重放已取消的回调');
    this.turn++;
    this.history.get(id).callback();
  }
  drain(limit = 1000) {
    for (let count=0; this.queue.size && count<limit; count++) this.next();
    assert.equal(this.queue.size, 0, '有限任务应完成并停止调度');
  }
}

function entry(key, viewKey, extra = {}) {
  const fields = {actionKey:key, viewKey, stageIndex:0, actionType:'scene', sceneId:key, selected:false, ...extra};
  return {
    ...fields, key, actionFields:{...fields},
    candidate:{sceneId:fields.sceneId, activityIds:[], fitScore:null},
    reference:{prefixUtility:0, referenceUtility:80},
  };
}
const success = job => ({
  ok:true, status:'feasible', q:job.q ?? 80, prefixUtility:0, referenceUtility:80,
  scoreVersion:'scheduling-test', search:{expandedNodes:1},
  continuationWitness:[{sceneId:job.sceneId, activityIds:[]}],
});
const noCertificate = () => ({ok:false, status:'no_plan_found'});

function harness(t, {verifyCandidate, ...settings} = {}) {
  const clock = new ManualClock(), events = [], updates = [], created = [], closed = [];
  const memory = {live:0, peak:0};
  const record = (type, job, extra = {}) => events.push({type, key:job.key, viewKey:job.viewKey, revision:job.revision, turn:clock.turn, ...extra});
  const api = createCandidateScheduler({
    ...settings, schedule:clock.schedule, cancel:clock.cancel, now:clock.now,
    ...(verifyCandidate ? {verifyCandidate:(job, profile) => {
      clock.work(job.verifyMs ?? 0.25);
      record('verify', job);
      return verifyCandidate(job, profile);
    }} : {}),
    createSearch:(job, profile) => {
      created.push({key:job.key, revision:job.revision, profile});
      record('create', job);
      return (function* () {
        memory.live++;
        memory.peak = Math.max(memory.peak, memory.live);
        try {
          for (let step=0; step<=(job.yields ?? 2); step++) {
            clock.work(job.stepMs ?? 1);
            record('step', job, {step});
            if (step < (job.yields ?? 2)) yield {expandedNodes:step+1};
            else return success(job);
          }
        } finally {
          memory.live--;
          closed.push({key:job.key, revision:job.revision});
        }
      })();
    },
    onResult:update => {
      updates.push({...update, at:clock.time});
      record('result', update);
    },
  });
  t.after(() => api.dispose());
  return {api, clock, events, updates, created, closed, memory};
}
const steps = run => run.events.filter(event => event.type === 'step');

test('快证书先覆盖各阶段的已选与主要选项，再补更多项；全部快验先于慢搜索', t => {
  const definitions = [
    {view:'stage-a', type:'scene'}, {view:'stage-b', type:'scene'},
    {view:'meal-lunch', type:'meal_option'}, {view:'departure', type:'departure'},
  ];
  const entries = definitions.flatMap(({view, type}) => [
    entry(`${view}:activity`, view, {actionType:'activity', selected:true}),
    entry(`${view}:extra`, view, {actionType:'duration'}),
    entry(`${view}:other-1`, view, {actionType:type}),
    entry(`${view}:other-2`, view, {actionType:type}),
    entry(`${view}:slow`, view, {actionType:'duration', noCertificate:true, yields:4}),
    entry(`${view}:selected`, view, {actionType:type, selected:true, ...(type === 'departure' ? {departureId:'separate'} : {})}),
  ]);
  const run = harness(t, {verifyCandidate:job => job.noCertificate ? noCertificate() : success(job)});
  run.api.reset('fast-first', entries);
  run.clock.drain();

  const firstRound = run.updates.slice(0, definitions.length);
  assert.equal(new Set(firstRound.map(update => update.viewKey)).size, definitions.length,
    '同阶段更多项不能延迟其他阶段的第一个结果');
  for (const {view} of definitions) {
    assert.equal(run.updates.find(update => update.viewKey === view).key, `${view}:selected`,
      '每组当前选中场景或分别方式应先有结果，已选活动不能抢在其前面');
  }
  const initialOptions = run.updates.slice(0, definitions.length * 3);
  assert.ok(initialOptions.every(update => ['scene','departure','meal_option'].includes(update.actionType)),
    '各组前三个主要选项应先于活动、时长等更多项');
  for (const {view} of definitions) assert.equal(initialOptions.filter(update => update.viewKey === view).length, 3);

  const checks = run.events.filter(event => event.type === 'verify');
  assert.equal(checks.length, entries.length, '每个待核项均应先尝试快验');
  assert.equal(new Set(checks.map(event => event.key)).size, entries.length);
  assert.ok(run.events.findIndex(event => event.type === 'create') > run.events.findLastIndex(event => event.type === 'verify'),
    '尚有待核证书时不能启动昂贵搜索');
  assert.deepEqual(new Set(run.created.map(job => job.key)), new Set(entries.filter(job => job.noCertificate).map(job => job.key)));
  assert.equal(run.updates.length, entries.length);
  assert.ok(run.updates.every(update => update.validationStatus === 'verified'));
});

test('可见阶段抢占未开始的后台项，单个慢可见阶段不能霸占另一可见阶段', t => {
  const run = harness(t, {verifyCandidate:noCertificate, maxStepsPerTick:1});
  const entries = [
    entry('background', 'offscreen', {yields:3, stepMs:8}),
    entry('a-current', 'visible-a', {selected:true, yields:30, stepMs:8}),
    entry('a-more', 'visible-a', {yields:30, stepMs:8}),
    entry('b-current', 'visible-b', {selected:true, yields:1, stepMs:8}),
  ];
  run.api.reset('visible', entries);
  run.api.prioritize('a-current');
  while (run.events.filter(event => event.type === 'verify').length < entries.length) run.clock.next();
  run.clock.next();
  assert.equal(steps(run).at(-1).key, 'a-current', '可见卡应先于未开始的后台搜索');
  const before = steps(run).length;
  run.api.prioritize('a-more');
  run.api.prioritize('b-current');
  for (let turn=0; turn<4 && !run.updates.some(update => update.key === 'b-current'); turn++) run.clock.next();

  assert.ok(run.updates.some(update => update.key === 'b-current'),
    '另一可见阶段的两个短片段应在少量轮转内完成，不能等待当前慢搜索结束');
  assert.ok(!run.updates.some(update => update.key === 'a-current'));
  assert.ok(steps(run).slice(before).every(event => event.key !== 'background'),
    '已有可见阶段待推进时，不应把片段交给未开始的后台项');
  run.clock.drain();
  assert.equal(run.updates.length, entries.length);
  assert.equal(run.memory.live, 0);

  // 两个槽位可能先被同阶段的普通项与可见项占用；后出现的可见阶段仍须及时推进。
  const occupied = harness(t, {verifyCandidate:noCertificate, maxStepsPerTick:1});
  const occupiedEntries = [
    entry('a-ordinary', 'visible-a', {selected:true, yields:30, stepMs:8}),
    entry('a-visible', 'visible-a', {yields:30, stepMs:8}),
    entry('b-visible', 'visible-b', {selected:true, yields:1, stepMs:8}),
    entry('b-extra', 'visible-b', {actionType:'duration', yields:0, stepMs:8}),
  ];
  occupied.api.reset('occupied', occupiedEntries);
  while (occupied.events.filter(event => event.type === 'verify').length < occupiedEntries.length) occupied.clock.next();
  occupied.clock.next();
  assert.equal(steps(occupied).at(-1).key, 'a-ordinary');
  occupied.api.prioritize('a-visible');
  occupied.clock.next();
  assert.equal(steps(occupied).at(-1).key, 'a-visible', '新可见项应抢占普通搜索');
  occupied.api.prioritize('b-visible');
  for (let turn=0; turn<4 && !occupied.updates.some(update => update.key === 'b-visible'); turn++) occupied.clock.next();
  assert.ok(occupied.updates.some(update => update.key === 'b-visible'),
    '同一阶段已占搜索槽位不能阻止另一可见阶段短任务及时取得结果');
  assert.ok(occupied.memory.peak <= 2, '恢复公平性仍需遵守两棵搜索树的内存上限');
  occupied.clock.drain();
  assert.equal(occupied.updates.length, occupiedEntries.length);
});

test('大量跨阶段待项与连续可见提优，最多保留两棵搜索树且最终全部回包', t => {
  const run = harness(t, {verifyCandidate:noCertificate, maxStepsPerTick:1});
  const entries = Array.from({length:60}, (_, index) => entry(`card-${index}`, `view-${Math.floor(index/3)}`, {yields:3, stepMs:0.25}));
  run.api.reset('many', entries);
  for (let index=0; index<entries.length; index+=2) run.api.prioritize(entries[index].key);
  // 边推进边出现更多可见卡，而非仅在 reset 前提供固定优先级。
  for (let turn=0; turn<80 && run.clock.queue.size; turn++) {
    run.clock.next();
    if (turn < entries.length) run.api.prioritize(entries[turn].key);
  }
  run.clock.drain();

  assert.ok(run.memory.peak <= 2, `活动搜索树峰值为 ${run.memory.peak}，不能随阶段数增长`);
  assert.equal(run.memory.live, 0);
  assert.equal(run.updates.length, entries.length);
  assert.equal(new Set(run.updates.map(update => update.key)).size, entries.length, '每个待项只能回包一次');
});

test('默认调度批处理短 yield，受步数和约8ms预算约束，片间没有额外80ms等待', t => {
  // 廉价片段触及步数上限，较贵片段触及时间预算；均使用默认调度参数。
  for (const [label, yields, stepMs] of [['cheap',95,0.125], ['costly',23,1]]) {
    const run = harness(t);
    run.api.reset(label, [entry(label, label, {yields, stepMs})]);
    run.clock.next();
    assert.ok(steps(run).length > 1, '一个回调应合并多个短片段，不能每次 yield 都重新等计时器');
    run.clock.drain();

    assert.ok(run.clock.scheduled.every(task => task.delay <= 4), '默认首次及片间等待均不得残留80ms延迟');
    for (const tick of run.clock.ticks) {
      assert.ok(steps(run).filter(event => event.turn === tick.turn).length <= 32, '廉价片段也必须有每轮步数上限');
      assert.ok(tick.computeMs <= 9, `单轮占用 ${tick.computeMs}ms，超过约8ms预算及一个短片段的容差`);
    }
    assert.equal(run.updates.length, 1);
    assert.ok(run.updates[0].at <= 60, '短工作应及时回包，不能累积按 yield 计的空闲等待');
    assert.equal(run.updates[0].candidate.validation.computeMs, (yields+1)*stepMs,
      '计算耗时应排除片间的定时等待');
  }
});

test('暂停保留生成器进度，暂停中的提优与换轮不启动任务，恢复无重复计算', t => {
  const run = harness(t, {maxStepsPerTick:1});
  run.api.reset('resume', [entry('card', 'stage', {yields:3, stepMs:1})]);
  run.clock.next();
  run.api.pause(true);
  const count = steps(run).length;
  run.api.prioritize('card');
  run.clock.work(1000);
  run.clock.drain();
  assert.equal(steps(run).length, count);
  assert.equal(run.created.length, 1);
  assert.equal(run.closed.length, 0, '暂停应保留当前搜索树');
  assert.equal(run.updates.length, 0);
  run.api.pause(false);
  run.clock.drain();
  assert.deepEqual(steps(run).map(event => event.step), [0,1,2,3], '恢复不能重算已完成片段');
  assert.equal(run.created.length, 1);
  assert.equal(run.closed.length, 1);
  assert.equal(run.updates[0].candidate.validation.computeMs, 4);

  run.api.reset('old-paused', [entry('shared', 'stage', {revision:'old', yields:5})]);
  run.clock.next();
  run.api.pause(true);
  run.api.reset('new-paused', [entry('shared', 'stage', {revision:'new', yields:0})]);
  assert.ok(run.closed.some(job => job.revision === 'old'), '暂停中换轮仍须关闭旧搜索树');
  assert.equal(run.clock.queue.size, 0);
  assert.ok(!run.created.some(job => job.revision === 'new'));
  run.api.pause(false);
  run.clock.drain();
  assert.deepEqual(run.updates.map(update => update.generation), ['resume','new-paused']);
});

test('reset、取消与暂停的迟到回调不能推进旧任务或侵入新轮', t => {
  const run = harness(t, {maxStepsPerTick:1});
  run.api.reset('old', [entry('shared', 'stage', {revision:'old', yields:5, q:10})]);
  run.clock.next();
  const oldTimer = run.clock.pendingId();
  run.api.reset('new', [entry('shared', 'stage', {revision:'new', yields:0, q:90})]);
  const newTimer = run.clock.pendingId();
  const count = steps(run).length;
  run.clock.fireCancelled(oldTimer);
  assert.equal(steps(run).length, count, '旧轮迟到回调不能推进同 key 的新任务');
  assert.equal(run.clock.pendingId(), newTimer, '旧回调不能抢走新轮计时器');
  assert.ok(run.closed.some(job => job.revision === 'old'));
  run.clock.drain();
  assert.deepEqual(run.updates.map(update => [update.generation, update.candidate.q]), [['new',90]]);

  run.api.reset('cancelled', [entry('shared', 'stage', {revision:'cancelled', yields:5})]);
  run.clock.next();
  const cancelledTimer = run.clock.pendingId();
  run.api.dispose();
  assert.equal(run.memory.live, 0, '取消应释放活动搜索树');
  assert.equal(run.clock.queue.size, 0);
  run.api.reset('latest', [entry('shared', 'stage', {revision:'latest', yields:0})]);
  const latestTimer = run.clock.pendingId();
  run.clock.fireCancelled(cancelledTimer);
  assert.equal(run.clock.pendingId(), latestTimer);
  assert.ok(!run.created.some(job => job.revision === 'latest'));
  run.clock.drain();
  assert.deepEqual(run.updates.map(update => update.generation), ['new','latest']);

  run.api.reset('paused', [entry('paused', 'stage', {yields:5})]);
  run.clock.next();
  const pausedTimer = run.clock.pendingId();
  run.api.pause(true);
  const pausedCount = steps(run).length;
  run.clock.fireCancelled(pausedTimer);
  assert.equal(steps(run).length, pausedCount, '暂停前已取消的迟到回调仍不能推进生成器');
  assert.equal(run.clock.queue.size, 0);
  run.api.pause(false);
  run.clock.drain();
  assert.equal(run.updates.at(-1).generation, 'paused');
});
