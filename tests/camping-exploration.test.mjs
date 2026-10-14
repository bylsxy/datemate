import test from 'node:test';
import assert from 'node:assert/strict';
import {planDate, verifyPlanWitness, createContinuationSearch} from '../engine.mjs';
import {CAMPING_EXPLORATION_MIN, EXPLORATION_VERSION, isDepartureAllowedAtExploration, isSceneAllowedAtExploration} from '../exploration.mjs';
import {catalog} from '../data/catalog.mjs';

const scene = (id, extra = {}) => ({id, kind:'ordinary', area:'campus', minutes:60,
  durationRange:[30,180], cost:[0,0], load:0, fit:70, activities:[], ...extra});
const source = {
  version:'camping-boundary', scenes:[scene('walk')],
  transfers:{campus:{campus:0}},
  departures:[
    {id:'separate', minutes:15, cost:[0,0]},
    {id:'camping', minutes:30, cost:[10,20], requiresExplicitChoice:true, onlyOvernight:true},
  ],
};
const context = {periodIds:['night'], reserve:0, robust:false, fatigueA:0, fatigueB:0, explorationSeed:'camping-test'};
const options = {maxStages:1, selectionMode:'utility_best'};
function finish(iterator) {
  let step;
  do { step = iterator.next(); } while (!step.done);
  return step.value;
}

test('露营共享门槛为80，普通分别方式不受门槛影响', () => {
  assert.equal(CAMPING_EXPLORATION_MIN,80);
  assert.equal(EXPLORATION_VERSION,'seeded-exploration-1.4');
  assert.equal(isDepartureAllowedAtExploration({id:'camping'},79),false);
  assert.equal(isDepartureAllowedAtExploration({id:'camping'},80),true);
  for (const id of ['separate','walk_together','hotel']) assert.equal(isDepartureAllowedAtExploration({id},0),true);
});

test('79过滤露营候选且不预留露营时间，80恢复候选和预留', () => {
  for (const exploration of [0,79,80,100]) {
    const result=planDate({...context,exploration},source,options);
    assert.equal(result.ok,true,result.errors.join(';'));
    assert.equal(result.departure.id,'separate','探索不能自动替用户选择露营');
    assert.equal(result.departure.candidates.some(d=>d.id==='camping'),exploration>=80);
    assert.equal(result.context.departures.some(d=>d.id==='camping'),exploration>=80);
    assert.equal(result.stages[0].end,exploration>=80?1530:1545);
  }
});

test('80可以明确露营，但预算和跨午夜条件仍生效', () => {
  const result=planDate({...context,exploration:80,departureChoice:'camping'},source,options);
  assert.equal(result.ok,true,result.errors.join(';'));
  assert.equal(result.departure.id,'camping');
  assert.deepEqual(result.totalCostCents,[1000,2000]);
  assert.equal(planDate({...context,exploration:80,departureChoice:'camping',budget:19},source,options).ok,false);
  const daytime=planDate({...context,periodIds:['evening'],exploration:80,departureChoice:'camping'},source,options);
  assert.equal(daytime.ok,false);
  assert.match(daytime.errors.join(';'),/H_DEPARTURE_OVERNIGHT/);
});

test('低探索度不能通过prefix、knownPlan、同步或分片续算选择露营', () => {
  const selected={...context,departureChoice:'camping',exploration:80};
  const permitted=planDate(selected,source,options);
  assert.equal(permitted.ok,true,permitted.errors.join(';'));
  const prefix=permitted.continuationWitness;
  const low={...selected,exploration:79};
  const attempts=[
    planDate(low,source,options),
    planDate({...low,fixedPrefix:prefix},source,options),
    planDate(low,source,{...options,knownPlan:prefix,continuationOnly:true}),
    verifyPlanWitness(low,source,{...options,fixedPrefix:prefix,knownPlan:prefix}),
    finish(createContinuationSearch(low,source,{...options,fixedPrefix:prefix,knownPlan:prefix})),
  ];
  for (const result of attempts) {
    assert.equal(result.status,'invalid_input');
    assert.match(result.errors.join(';'),/H_DEPARTURE_EXPLORATION/);
    assert.equal(result.departure,undefined);
  }
});

test('门槛使用有效探索度，options优先于input及嵌套context', () => {
  const selected={...context,departureChoice:'camping'};
  assert.equal(planDate({context:{...selected,exploration:80}},source,{...options,exploration:79}).ok,false);
  assert.equal(planDate({context:{...selected,exploration:79}},source,{...options,exploration:80}).ok,true);
  assert.equal(planDate({...selected,exploration:79},source,options).ok,false);
  assert.equal(planDate(selected,source,options).ok,false);
});

test('精确营地ID和metadata门槛不会误伤campus，dreamOnly仍仅允许100', () => {
  for (const id of ['camp_day_setup','camp_evening']) {
    assert.ok(catalog.scenes.some(s=>s.id===id),'核查真实营地场景标识');
    assert.equal(isSceneAllowedAtExploration({id},79),false);
    assert.equal(isSceneAllowedAtExploration({id},80),true);
    assert.equal(isSceneAllowedAtExploration({id,minimumExploration:0},79),false);
  }
  assert.equal(isSceneAllowedAtExploration({id:'campus'},0),true);
  assert.equal(isSceneAllowedAtExploration({id:'campus_canteen'},0),true);
  assert.equal(isSceneAllowedAtExploration({id:'custom',minimumExploration:80},79),false);
  assert.equal(isSceneAllowedAtExploration({id:'custom',minimumExploration:80},80),true);
  assert.equal(isSceneAllowedAtExploration({id:'camp_evening',minimumExploration:90},80),false);
  assert.equal(isSceneAllowedAtExploration({id:'camp_evening',minimumExploration:90},90),true);
  assert.equal(isSceneAllowedAtExploration({id:'dream',dreamOnly:true,minimumExploration:80},99),false);
  assert.equal(isSceneAllowedAtExploration({id:'dream',dreamOnly:true,minimumExploration:80},100),true);
  const dream={version:'dream',scenes:[scene('dream',{dreamOnly:true})]};
  const fixedPrefix=[{sceneId:'dream',activityIds:[]}];
  const low=planDate({duration:120,reserve:0,robust:false,exploration:99,fixedPrefix},dream,{maxStages:1});
  assert.equal(low.ok,false);
  assert.match(low.errors.join(';'),/H_DREAM_ONLY/);
  assert.equal(planDate({duration:120,reserve:0,robust:false,exploration:100,fixedPrefix},dream,{maxStages:1}).ok,true);
});

const sceneContext={duration:120,reserve:0,robust:false,explorationSeed:'camp-scene'};
const sceneSource={version:'camp-scenes',scenes:[scene('camp_day_setup'),scene('camp_evening'),scene('campus')]};
const sceneOptions={maxStages:1,selectionMode:'utility_best'};

test('79从普通候选彻底移除两类营地，80恢复且其他条件仍可拒绝', () => {
  for (const exploration of [0,79,80,100]) {
    const result=planDate({...sceneContext,exploration},sceneSource,sceneOptions);
    assert.equal(result.ok,true,result.errors.join(';'));
    const ids=new Set(result.stages.flatMap(s=>s.candidates.map(c=>c.sceneId)));
    for (const id of ['camp_day_setup','camp_evening']) assert.equal(ids.has(id),exploration>=80);
    assert.equal(ids.has('campus'),true);
  }
  const required={...sceneSource,scenes:[scene('camp_evening',{requires:['tent']})]};
  const fixedPrefix=[{sceneId:'camp_evening',activityIds:[]}];
  const rejected=planDate({...sceneContext,exploration:80,fixedPrefix},required,sceneOptions);
  assert.equal(rejected.ok,false);
  assert.match(rejected.errors.join(';'),/H_PREPARATION/);
  assert.equal(planDate({...sceneContext,exploration:80,fixedPrefix,preparedIds:['tent']},required,sceneOptions).ok,true);
});

test('两类营地的prefix、required、anchor及knownPlan均不能绕过79门槛', () => {
  for (const sceneId of ['camp_day_setup','camp_evening']) {
    const choice={sceneId,activityIds:[]};
    const high={...sceneContext,exploration:80};
    const permitted=planDate({...high,fixedPrefix:[choice]},sceneSource,sceneOptions);
    assert.equal(permitted.ok,true,permitted.errors.join(';'));
    const witness=permitted.continuationWitness;
    const low={...sceneContext,exploration:79};
    for (const constraint of [
      {fixedPrefix:[choice]}, {prefix:[choice]}, {requiredSceneIds:[sceneId]},
      {anchors:[{choice,index:0}]}, {anchorSceneId:sceneId},
    ]) {
      const rejected=planDate({...low,...constraint},sceneSource,sceneOptions);
      assert.equal(rejected.status,'invalid_input');
      assert.match(rejected.errors.join(';'),/H_SCENE_EXPLORATION/);
      assert.equal(planDate({...high,...constraint},sceneSource,sceneOptions).ok,true);
    }
    const verified=verifyPlanWitness(low,sceneSource,{...sceneOptions,knownPlan:witness});
    assert.equal(verified.ok,false);
    assert.match(verified.errors.join(';'),/H_SCENE_EXPLORATION/);
    const continued=finish(createContinuationSearch(low,sceneSource,{...sceneOptions,fixedPrefix:[choice],knownPlan:witness}));
    assert.equal(continued.ok,false);
    assert.match(continued.errors.join(';'),/H_SCENE_EXPLORATION/);
    const recovered=planDate(low,sceneSource,{...sceneOptions,knownPlan:witness});
    assert.equal(recovered.ok,true);
    assert.ok(recovered.stages.every(s=>s.sceneId==='campus'));
  }
});

test('metadata门槛执行相同硬校验，无效metadata明确拒绝目录', () => {
  const fixedPrefix=[{sceneId:'custom',activityIds:[]}];
  const metadata={version:'metadata',scenes:[scene('custom',{minimumExploration:80})]};
  assert.equal(planDate({...sceneContext,exploration:79,fixedPrefix},metadata,sceneOptions).ok,false);
  assert.equal(planDate({...sceneContext,exploration:80,fixedPrefix},metadata,sceneOptions).ok,true);
  for (const minimumExploration of [-1,101,1.5,'80',null]) {
    const invalid=planDate(sceneContext,{version:'invalid',scenes:[scene('custom',{minimumExploration})]},sceneOptions);
    assert.equal(invalid.status,'invalid_data');
    assert.match(invalid.errors.join(';'),/H_DATA/);
  }
});
