import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlan } from '../planner.mjs';
import { activities } from '../data/activities.mjs';

// 自定义库让各边界有确定的可行解，不依赖排序实现。
function activity(id, overrides = {}) {
  return {
    id, name: id, place: '校内测试地点', area: 'campus',
    category: id, duration: 30, cost: [0, 0], indoor: true,
    quiet: true, uncrowded: true, energy: 'low', culture: 'light',
    interaction: 'low', themes: [], foodTags: [], reliable: true,
    flexible: true, ...overrides,
  };
}

const timeWindows = {
  morning: [540, 720], afternoon: [840, 1080], evening: [1080, 1260],
};

function assertPlan(plan, library, slots = ['afternoon']) {
  assert.ok(plan.steps.length <= 3);
  assert.equal(new Set(plan.steps.map(s => s.activity.category)).size, plan.steps.length);
  let minimum = 0;
  let maximum = 0;
  for (const [index, step] of plan.steps.entries()) {
    assert.ok(library.includes(step.activity), '输出活动必须来自提供的库');
    assert.equal(step.end - step.start, step.activity.duration);
    assert.ok(slots.some(slot => {
      const [start, end] = timeWindows[slot];
      return step.start >= start && step.end <= end;
    }), '整个活动必须落在一个选中时段内');
    if (index) {
      const previous = plan.steps[index - 1];
      const requiredBuffer = previous.activity.area === step.activity.area ? 10 : 20;
      assert.ok(step.start - previous.end >= requiredBuffer, '转场时间必须足够');
    }
    minimum += step.activity.cost[0];
    maximum += step.activity.cost[1];
  }
  assert.deepEqual(plan.cost, { min: minimum, max: maximum });
  assert.ok(maximum <= plan.facts.limit, '总费用区间上限不得超过预算');
}

test('未设置预算允许付费活动；limited 模式缺失预算必须报错', () => {
  const library = [activity('paid', { cost: [100, 200] })];
  const plan = createPlan({}, library);
  assert.equal(plan.steps.length, 1);
  assertPlan(plan, library);
  assert.throws(() => createPlan({ budgetMode: 'limited' }, library), /预算/);
});

for (const [label, budget] of [
  ['空字符串', ''], ['空白', '  '], ['非数字', 'abc'], ['负数', -1],
  ['NaN', NaN], ['Infinity', Infinity], ['undefined', undefined],
  ['null', null], ['布尔 true', true], ['布尔 false', false],
  ['数组 [0]', [0]],
]) {
  test(`非法或缺失预算：${label} 必须拒绝`, () => {
    assert.throws(() => createPlan({ budgetMode: 'limited', budget }), /预算/);
  });
}

test('预算 0 和字符串 0 只允许免费活动', () => {
  const library = [activity('free'), activity('paid', { cost: [0, 0.01] })];
  for (const budget of [0, '0']) {
    const plan = createPlan({ budgetMode: 'limited', budget }, library);
    assert.deepEqual(plan.steps.map(s => s.activity.id), ['free']);
    assertPlan(plan, library);
  }
});

test('单项费用按区间上限判断：恰好预算可选，超过一分不可选', () => {
  const exact = activity('exact', { cost: [0, 50] });
  const over = activity('over', { cost: [0, 50.01] });
  for (const budgetMode of ['limited', 'saving']) {
    const input = { budgetMode, budget: 50 };
    assert.equal(createPlan(input, [exact]).steps.length, 1);
    assert.equal(createPlan(input, [over]).steps.length, 0);
  }
});

test('总预算恰好上限可行，超上限时不得同时选择所有活动', () => {
  const library = [activity('a', { cost: [10, 20] }), activity('b', { cost: [10, 30] })];
  const exact = createPlan({ budgetMode: 'limited', budget: 50 }, library);
  assert.equal(exact.steps.length, 2);
  assertPlan(exact, library);
  const below = createPlan({ budgetMode: 'limited', budget: 49.99 }, library);
  assert.equal(below.steps.length, 1);
  assertPlan(below, library);
});

test('campus 范围排除周边，即使周边主题更匹配', () => {
  const library = [activity('campus'), activity('nearby', { area: 'nearby', themes: ['浪漫'] })];
  const plan = createPlan({ scope: 'campus', themes: ['浪漫'] }, library);
  assert.deepEqual(plan.steps.map(s => s.activity.id), ['campus']);
});

test('雨天只选室内；单独选择室内也施加相同约束', () => {
  const library = [activity('inside'), activity('outside', { indoor: false, themes: ['新鲜'] })];
  for (const input of [{ weather: 'rain' }, { environment: ['室内'] }]) {
    const plan = createPlan({ themes: ['新鲜'], ...input }, library);
    assert.deepEqual(plan.steps.map(s => s.activity.id), ['inside']);
  }
});

test('疲惫只选 lowEnergy，主题匹配不能覆盖体力约束', () => {
  const library = [activity('low'), activity('medium', { energy: 'medium', themes: ['新鲜'] })];
  const plan = createPlan({ energy: ['疲惫'], themes: ['新鲜'] }, library);
  assert.deepEqual(plan.steps.map(s => s.activity.id), ['low']);
});

test('忌口排除任意匹配餐饮标签，保留无冲突活动', () => {
  const library = [activity('safe'), activity('spicy', { foodTags: ['熟食', '辣'] }), activity('raw', { foodTags: ['生食'] })];
  const plan = createPlan({ diet: ['辣', '生食'] }, library);
  assert.deepEqual(plan.steps.map(s => s.activity.id), ['safe']);
});

test('排除关键词匹配名称或地点，支持大小写、空白和多种分隔符', () => {
  const library = [activity('safe'), activity('cafe', { name: 'CAFE' }), activity('place', { place: '禁止地点' }), activity('third', { name: '第三项' })];
  for (const separator of [',', '，', '、', ';', '；', '\n']) {
    const plan = createPlan({ excluded: ` cafe ${separator}禁止${separator}第三` }, library);
    assert.deepEqual(plan.steps.map(s => s.activity.id), ['safe']);
  }
});

test('HTML 注入字符串作为普通关键词及忌口数据不会执行或导致异常', () => {
  const payload = '<img src=x onerror="throw new Error(1)">';
  const library = [activity('safe'), activity('name', { name: payload }), activity('tag', { foodTags: [payload] })];
  const plan = createPlan({ excluded: payload, diet: [payload] }, library);
  assert.deepEqual(plan.steps.map(s => s.activity.id), ['safe']);
  assert.equal(plan.facts.excluded, payload);
});

test('非连续多选时段可跨到晚上，不能进入未选中的下午', () => {
  const library = [activity('a', { duration: 180 }), activity('b', { duration: 170 })];
  for (const slots of [['morning', 'evening'], ['evening', 'morning']]) {
    const plan = createPlan({ slots }, library);
    assert.equal(plan.steps.length, 2);
    assertPlan(plan, library, slots);
    assert.ok(plan.steps[1].start >= 1080);
  }
});

test('单活动时长恰好时段边界可行，多一分钟不可行', () => {
  for (const [slot, [start, end]] of Object.entries(timeWindows)) {
    const exact = [activity('exact', { duration: end - start })];
    const plan = createPlan({ slots: [slot] }, exact);
    assert.equal(plan.steps.length, 1);
    assertPlan(plan, exact, [slot]);
    assert.equal(createPlan({ slots: [slot] }, [activity('over', { duration: end - start + 1 })]).steps.length, 0);
  }
});

test('非连续时段不可拼接成一个超长活动', () => {
  const plan = createPlan({ slots: ['morning', 'evening'] }, [activity('long', { duration: 181 })]);
  assert.equal(plan.steps.length, 0);
});

test('多个活动需计入同范围与跨范围转场：足够或差一分钟', () => {
  for (const [area, buffer] of [['campus', 10], ['nearby', 20]]) {
    const exactLibrary = [activity('a', { duration: 100 }), activity('b', { area, duration: 240 - 100 - buffer })];
    const exact = createPlan({}, exactLibrary);
    assert.equal(exact.steps.length, 2);
    assertPlan(exact, exactLibrary);
    const shortLibrary = [exactLibrary[0], { ...exactLibrary[1], duration: exactLibrary[1].duration + 1 }];
    const short = createPlan({}, shortLibrary);
    assert.equal(short.steps.length, 1);
    assertPlan(short, shortLibrary);
  }
});

test('空库或全部被硬约束排除时返回空计划和零费用', () => {
  for (const library of [[], [activity('outside', { indoor: false })]]) {
    const plan = createPlan({ weather: 'rain' }, library);
    assert.deepEqual(plan.steps, []);
    assert.deepEqual(plan.cost, { min: 0, max: 0 });
    assert.equal(plan.duration, 0);
    assert.equal(plan.candidates, 0);
  }
});

test('随机排序不能越过预算、范围、天气、体力、忌口、关键词或时段约束', () => {
  const library = [
    activity('a-safe', { cost: [0, 10], duration: 90 }),
    activity('b-safe', { cost: [0, 10], duration: 80 }),
    activity('over', { cost: [0, 21] }),
    activity('nearby', { area: 'nearby' }),
    activity('outside', { indoor: false }),
    activity('tiring', { energy: 'medium' }),
    activity('food', { foodTags: ['辣'] }),
    activity('blocked', { place: '禁止地点' }),
    activity('long', { duration: 181 }),
  ];
  for (const randomness of [0, 1, 50, 100, 200]) {
    for (let seed = 1; seed <= 30; seed++) {
      let state = seed;
      const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
      const plan = createPlan({ budgetMode: 'limited', budget: 20, scope: 'campus', weather: 'rain', energy: ['疲惫'], diet: ['辣'], excluded: '禁止', slots: ['morning', 'evening'], randomness }, library, random);
      assert.equal(plan.steps.length, 2, `可行活动应被安排：randomness=${randomness}, seed=${seed}`);
      assert.ok(plan.steps.every(s => ['a-safe', 'b-safe'].includes(s.activity.id)));
      assertPlan(plan, library, ['morning', 'evening']);
    }
  }
});

test('内置活动库在组合硬约束下有可行结果且满足所有限制', () => {
  const plan = createPlan({ budgetMode: 'limited', budget: 0, scope: 'campus', weather: 'rain', energy: ['疲惫'], diet: ['辣', '生食'], excluded: '阅读', slots: ['evening'], randomness: 100 }, activities, () => 0.5);
  assert.ok(plan.steps.length > 0);
  for (const { activity: a } of plan.steps) {
    assert.equal(a.area, 'campus');
    assert.equal(a.indoor, true);
    assert.equal(a.energy, 'low');
    assert.ok(!a.foodTags.some(tag => ['辣', '生食'].includes(tag)));
    assert.ok(!`${a.name} ${a.place}`.includes('阅读'));
  }
  assertPlan(plan, activities, ['evening']);
});
