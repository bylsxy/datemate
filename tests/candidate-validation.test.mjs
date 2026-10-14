import test from 'node:test';
import assert from 'node:assert/strict';
import {planDate, createContinuationSearch} from '../engine.mjs';
import {buildCandidateJobs, validatedCandidate, createCandidateScheduler} from '../candidate-validation.mjs';

const scene = (id, extra = {}) => ({id, minutes:30, cost:[0,0], load:0, kind:id, area:'campus', indoor:true, quiet:true, fit:70, activities:[], ...extra});
const eat = role => ({id:`eat-${role}`, cost:[0,0], load:0, group:'meal', mode:'single', exclusiveKey:'main_meal', provides:['meal_completed'], mealRoles:[role]});
const meal = id => scene(id, {kind:'meal', mealRoles:['breakfast','lunch','dinner','supper'], activities:['breakfast','lunch','dinner','supper'].map(eat)});
const fixture = scenes => ({version:'candidate-validation-test', scenes, transfers:{campus:{campus:0}}, departures:[{id:'separate', minutes:15, cost:[0,0]}]});
const context = {duration:150, reserve:0, robust:false, fatigueA:0, fatigueB:0};
const options = {maxStages:3, beamWidth:24, maxExpandedNodes:3000, maxCandidateExpandedNodes:0};
function finish(iterator) {
  const progress = [];
  for (let i=0; i<10000; i++) {
    const step = iterator.next();
    if (step.done) return {result:step.value, progress};
    progress.push(step.value);
  }
  assert.fail('搜索未在有界次数内完成');
}
function runJob(job, data) {
  return finish(createContinuationSearch(job.context, data, {...job.search, fixedPrefix:job.prefix, exploration:job.exploration})).result;
}
function freeze(value) {
  if (value && typeof value==='object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

// 可控计时器只推进一个回调，避免零延迟可见任务把整轮测试一次跑完。
class FakeTimer {
  time=0; serial=0; queue=new Map(); cancelled=[];
  schedule=(callback, delay) => {
    const id=++this.serial;
    this.queue.set(id, {callback, at:this.time+delay});
    return id;
  };
  cancel=id => {this.cancelled.push(id); this.queue.delete(id);};
  now=() => this.time;
  next() {
    const entry=[...this.queue].sort((a,b)=>a[1].at-b[1].at || a[0]-b[0])[0];
    assert.ok(entry, '应有待执行片段');
    const [id, job]=entry;
    this.queue.delete(id); this.time=job.at; job.callback();
  }
  drain() {
    for (let i=0; this.queue.size && i<100; i++) this.next();
    assert.equal(this.queue.size,0,'调度器应停止安排计时器');
  }
  due() {return Math.min(...[...this.queue.values()].map(t=>t.at));}
}
const entry = key => ({key, stageIndex:0, sceneId:key, candidate:{sceneId:key, activityIds:[], fitScore:null}, reference:{prefixUtility:0, referenceUtility:80}});
const success = q => ({ok:true, status:'feasible', q, prefixUtility:0, referenceUtility:80, scoreVersion:'test', search:{expandedNodes:5}});
function scheduler(createSearch) {
  const timer=new FakeTimer(), results=[];
  const api=createCandidateScheduler({createSearch, onResult:r=>results.push(r), schedule:timer.schedule, cancel:timer.cancel, now:timer.now});
  return {timer, results, api};
}

test('同步规划和分片完整搜索使用相同q、实际组合及约束，参考尺取候选前状态', () => {
  const data=fixture([scene('prepare',{provides:['kit']}), scene('play',{requires:['kit'], activities:[{id:'actual', cost:[2,3], load:1, tags:['play']}]}), scene('booking',{requires:['kit']})]);
  const input={...context, budget:5, preferencesA:['play'], preferencesB:['play'], anchors:[{id:'reserved', index:2, startMinute:100, choice:{sceneId:'booking',activityIds:[]}}]};
  const prefix=[{sceneId:'prepare',activityIds:[]},{sceneId:'play',activityIds:['actual']}];
  const opts={...options, fixedPrefix:prefix, exploration:37};
  const sync=planDate(input,data,opts);
  const asyncResult=finish(createContinuationSearch(input,data,opts)).result;
  assert.equal(sync.ok,true,sync.errors?.join(';'));
  assert.equal(asyncResult.ok,true);
  assert.deepEqual(asyncResult.stages.map(s=>[s.sceneId,s.activityIds,s.start,s.end]),sync.stages.map(s=>[s.sceneId,s.activityIds,s.start,s.end]));
  assert.equal(asyncResult.q,sync.stages[1].rawUtility);
  assert.equal(asyncResult.prefixUtility,sync.stages[1].scoreReference.prefixUtility);
  assert.equal(asyncResult.referenceUtility,sync.stages[1].scoreReference.referenceUtility);
  assert.notEqual(asyncResult.prefixUtility,asyncResult.q);
  assert.equal(asyncResult.stages[2].anchorId,'reserved');
  assert.equal(asyncResult.stages[2].start,100);
  assert.deepEqual(asyncResult.stages[1].activityIds,['actual']);
  assert.ok(sync.totalCostCents[1]<=500);
  assert.ok(asyncResult.stages.every(s=>s.after.fatigue.every(f=>f<=sync.context.maxLoad)));
  const withoutKit=finish(createContinuationSearch(input,data,{...opts,fixedPrefix:[{sceneId:'booking',activityIds:[]},{sceneId:'play',activityIds:['actual']}]})).result;
  assert.equal(withoutKit.ok,false);
  assert.match(withoutKit.errors.join(';'),/H_PREPARATION/);
});

test('前缀局部可行但无法完成未来锚点或正餐目标时不能产出完整q', () => {
  const data=fixture([scene('local',{minutes:50}),scene('booking',{minutes:30})]);
  const fixedPrefix=[{sceneId:'local',activityIds:[]}];
  for (const extra of [{mealNeed:true},{anchors:[{index:1,startMinute:20,choice:{sceneId:'booking',activityIds:[]}}]}]) {
    const r=finish(createContinuationSearch({...context,...extra},data,{...options,fixedPrefix})).result;
    assert.equal(r.ok,false);
    assert.equal(r.q,undefined);
  }
});

test('实际经过多次yield后同步与分片搜索的约束、累计指标和参考尺一致', () => {
  const data=fixture([
    scene('seed',{minutes:20,provides:['kit']}),
    scene('play',{minutes:20,cost:[0.1,0.2],load:0.2,requires:['kit'],fit:95}),
    scene('booking',{minutes:20,requires:['kit']}),
    ...Array.from({length:140},(_,i)=>scene(`rejected-${i}`,{requires:['missing']})),
  ]);
  const input={...context,budget:1,anchors:[{id:'future',index:2,startMinute:100,choice:{sceneId:'booking',activityIds:[]}}]};
  const opts={...options,fixedPrefix:[{sceneId:'seed',activityIds:[]}],exploration:23};
  const before=JSON.stringify({input,opts,data});
  const sync=planDate(input,data,opts);
  const {result,progress}=finish(createContinuationSearch(input,data,opts));
  assert.equal(sync.ok,true,sync.errors?.join(';'));
  assert.equal(result.ok,true);
  assert.ok(progress.length>=2,'必须实际跨多个片段，避免同步完成造成假覆盖');
  assert.deepEqual(result.stages.map(s=>({sceneId:s.sceneId,activityIds:s.activityIds,start:s.start,end:s.end,transfer:s.transfer,wait:s.wait,reserve:s.reserve,costCents:s.costCents,before:s.before,after:s.after})),sync.stages.map(s=>({sceneId:s.sceneId,activityIds:s.activityIds,start:s.start,end:s.end,transfer:s.transfer,wait:s.wait,reserve:s.reserve,costCents:s.costCents,before:s.before,after:s.after})));
  assert.equal(result.q,sync.stages[0].rawUtility);
  assert.equal(+result.q.toFixed(3),sync.metrics.objective);
  assert.equal(result.prefixUtility,sync.stages[0].scoreReference.prefixUtility);
  assert.equal(result.referenceUtility,sync.stages[0].scoreReference.referenceUtility);
  assert.deepEqual([0,1].map(i=>result.stages.reduce((sum,s)=>sum+s.costCents[i],0)),sync.metrics.totalCostCents);
  assert.equal(result.stages.reduce((sum,s)=>sum+s.minutes,0),sync.metrics.activeMinutes);
  assert.equal(result.stages.reduce((sum,s)=>sum+s.wait,0),sync.metrics.waitingMinutes);
  assert.deepEqual(result.stages.at(-1).after.predictedLoadByPerson,sync.metrics.predictedLoadByPerson);
  for(const key of ['expandedNodes','generatedNodes','feasibleNodes','terminalPlans','beamPruned','nodeBudgetReached','constraintRejections']) assert.deepEqual(result.search[key],sync.search[key],key);
  assert.equal(JSON.stringify({input,opts,data}),before);
});

test('任务只保留显式fixedStartMinute，自动start不会转成硬预约', () => {
  const state={context:{...context},exploration:0,prefix:[]};
  for(const fixedStartMinute of [null,40]) {
    const result={ok:true,stages:[
      {sceneId:'before',activityIds:['kept'],start:40,startMinute:40,fixedStartMinute,candidates:[]},
      {sceneId:'selected',activityIds:[],start:90,scoreReference:{prefixUtility:12,referenceUtility:70.4},candidates:[
        {sceneId:'automatic',activityIds:[],start:90,startMinute:90,fixedStartMinute:null,fitScore:null},
        {sceneId:'reserved',activityIds:[],start:105,fixedStartMinute:105,fitScore:null},
      ]},
    ],mealRequirements:[],replay:{search:{...options}}};
    const jobs=buildCandidateJobs(result,state);
    assert.equal(jobs.length,2);
    for(const job of jobs) {
      assert.equal(Object.hasOwn(job.prefix[0],'startMinute'),fixedStartMinute!==null);
      if(fixedStartMinute!==null)assert.equal(job.prefix[0].startMinute,40);
      assert.deepEqual(job.prefix[0].activityIds,['kept']);
    }
    assert.equal(Object.hasOwn(jobs.find(j=>j.sceneId==='automatic').prefix[1],'startMinute'),false);
    assert.equal(jobs.find(j=>j.sceneId==='reserved').prefix[1].startMinute,105);
  }
});

test('失败密集的搜索也在至多64节点让出，并最终报告有界未找到', () => {
  const scenes=Array.from({length:192},(_,i)=>scene(`blocked-${i}`));
  const input={...context,bans:scenes.map(s=>s.id)};
  const iterator=createContinuationSearch(input,fixture(scenes),{...options,maxExpandedNodes:200});
  const first=iterator.next();
  assert.equal(first.done,false);
  assert.ok(first.value.expandedNodes>0 && first.value.expandedNodes<=64);
  const {result,progress}=finish(iterator);
  assert.equal(result.ok,false);
  assert.equal(result.status,'no_plan_found');
  assert.equal(result.search.expandedNodes,192);
  assert.equal(result.search.constraintRejections.H_EXCLUDED,192);
  assert.ok(progress.length>0);
});

test('实际固定餐馆换馆任务释放目标餐次，保留其他固定餐次及前序组合', () => {
  const data=fixture([meal('a-food'),meal('b-food'),scene('walk')]);
  const state={context:{...context,periodIds:['morning','afternoon'],mealChoices:{breakfast:{sceneId:'a-food',activityIds:['eat-breakfast']},lunch:{sceneId:'a-food',activityIds:['eat-lunch']}}},exploration:0,prefix:[]};
  const result=planDate(state.context,data,{maxExpandedNodes:18000});
  assert.equal(result.ok,true,result.errors?.join(';'));
  const job=buildCandidateJobs(result,state).find(j=>j.mealRole==='breakfast' && j.sceneId==='b-food');
  assert.ok(job,'应提供换早餐餐馆的待验证任务');
  assert.deepEqual(job.context.mealChoices.breakfast,{sceneId:'b-food',activityIds:['eat-breakfast']});
  assert.deepEqual(job.context.mealChoices.lunch,state.context.mealChoices.lunch);
  assert.equal(job.prefix.at(-1).mealRole,'breakfast');
  const checked=runJob(job,data);
  assert.equal(checked.ok,true,checked.errors?.join(';'));
  assert.equal(checked.stages.find(s=>s.mealRole==='breakfast').sceneId,'b-food');
  assert.equal(checked.stages.find(s=>s.mealRole==='lunch').sceneId,'a-food');
  assert.deepEqual(checked.stages.slice(0,job.stageIndex).map(s=>[s.sceneId,s.activityIds]),result.stages.slice(0,job.stageIndex).map(s=>[s.sceneId,s.activityIds]));
});

test('虚拟早餐和跳过宵夜按insertIndex生成真实餐卡任务，参考尺覆盖候选本身', () => {
  const data=fixture([meal('food'),scene('walk')]);
  for (const [role,periodIds,mode] of [['breakfast',['morning'],'before_meeting'],['supper',['evening','night'],'skip']]) {
    const state={context:{...context,periodIds,mealChoices:{[role]:{mode}}},exploration:0,prefix:[]};
    const result=planDate(state.context,data,{maxExpandedNodes:18000});
    assert.equal(result.ok,true,result.errors?.join(';'));
    const slot=result.mealRequirements.find(m=>m.mealRole===role);
    assert.equal(slot.stageIndex,null);
    const job=buildCandidateJobs(result,state).find(j=>j.mealRole===role);
    assert.ok(job,`${role}应有真实用餐任务`);
    assert.equal(job.stageIndex,slot.insertIndex);
    assert.equal(job.prefix.length,slot.insertIndex+1);
    assert.equal(job.prefix.at(-1).mealRole,role);
    assert.ok(job.prefix.at(-1).activityIds.includes(`eat-${role}`));
    const checked=runJob(job,data);
    assert.equal(checked.ok,true,checked.errors?.join(';'));
    assert.equal(checked.stages[job.stageIndex].mealRole,role);
    assert.equal(checked.referenceUtility,80 * 0.96 ** slot.insertIndex);
    const sync=planDate(job.context,data,{...job.search,fixedPrefix:job.prefix,exploration:job.exploration});
    assert.equal(checked.prefixUtility,sync.stages[job.stageIndex].scoreReference.prefixUtility);
    const scored=validatedCandidate(job,checked);
    assert.equal(scored.fitScore,sync.stages[job.stageIndex].fitScore);
    assert.equal(scored.continuationFound,true);
  }
});

test('任务构建、搜索和评分不会修改冻结输入、选中组合或复盘fingerprint', () => {
  const data=fixture([meal('food'),scene('walk')]);
  const state=freeze({context:{...context,periodIds:['morning'],mealChoices:{breakfast:{mode:'before_meeting'}}},exploration:0,prefix:[]});
  const result=freeze(planDate(state.context,data));
  assert.equal(result.ok,true);
  const stateBefore=JSON.stringify(state), resultBefore=JSON.stringify(result);
  const jobs=buildCandidateJobs(result,state);
  assert.ok(jobs.length>0);
  const job=jobs.find(j=>j.mealRole==='breakfast');
  const checked=runJob(job,data);
  validatedCandidate(job,checked);
  assert.equal(JSON.stringify(state),stateBefore);
  assert.equal(JSON.stringify(result),resultBefore);
  assert.equal(result.fingerprint,JSON.parse(resultBefore).fingerprint);
  assert.equal(result.outputFingerprint,JSON.parse(resultBefore).outputFingerprint);
});

test('评分只使用完整q与同阶段参考尺，未找到时清除数值并结束pending', () => {
  const job={...entry('card'),reference:{prefixUtility:25,referenceUtility:76.8},candidate:{sceneId:'card',activityIds:['actual'],localUtility:999,fitScore:null}};
  const scored=validatedCandidate(job,{...success(101.8),prefixUtility:999,referenceUtility:1});
  assert.equal(scored.fitScore,75);
  assert.deepEqual(scored.activityIds,['actual']);
  const unresolved=validatedCandidate(job,{ok:false,status:'no_plan_found'});
  assert.equal(unresolved.fitScore,null);
  assert.equal(unresolved.q,null);
  assert.equal(unresolved.continuationFound,false);
  assert.equal(unresolved.scoreStatus,'unresolved');
});

test('可见卡取消80ms等待，在低优先迭代器片间抢占而不重复创建搜索', () => {
  const steps=[], created=[];
  const {api,timer,results}=scheduler(job=>{
    created.push(job.key);
    return (function*(){steps.push(`${job.key}:first`);yield {};steps.push(`${job.key}:last`);return success(80);})();
  });
  api.reset('g1',[entry('low'),entry('visible')]);
  timer.next();
  assert.deepEqual(steps,['low:first']);
  assert.equal(timer.due(),160);
  api.prioritize('visible');
  assert.equal(timer.due(),80,'可见任务应取消尚余80ms的空闲等待');
  assert.equal(timer.cancelled.length,1);
  timer.next();
  assert.deepEqual(steps,['low:first','visible:first']);
  timer.next();
  assert.deepEqual(steps,['low:first','visible:first','visible:last']);
  assert.equal(results[0].key,'visible');
  timer.drain();
  assert.deepEqual(created,['low','visible']);
  assert.equal(results[1].key,'low');
});

test('reset关闭旧迭代器并隔离旧结果，dispose清理新轮所有等待', () => {
  const closed=[], steps=[];
  const {api,timer,results}=scheduler(job=>(function*(){
    try {steps.push(job.key);yield {};return success(job.key==='old'?10:90);}
    finally {closed.push(job.key);}
  })());
  api.reset('old-generation',[entry('old')]);timer.next();
  api.reset('new-generation',[entry('new')]);
  assert.deepEqual(closed,['old']);
  timer.drain();
  assert.deepEqual(steps,['old','new']);
  assert.equal(results.length,1);
  assert.equal(results[0].generation,'new-generation');
  assert.equal(results[0].key,'new');
  assert.equal(results[0].candidate.q,90);
  api.reset('third',[entry('never')]);api.dispose();
  assert.equal(timer.queue.size,0);
  assert.equal(results.length,1);
});

test('39个任务与连续可见提优最多保留两个活动搜索树', () => {
  let live=0, peak=0;
  const created=[], steps=[];
  const {api,timer,results}=scheduler(job=>{
    live++;peak=Math.max(peak,live);created.push(job.key);
    return (function*(){
      try {
        for(let i=0;i<3;i++){steps.push(job.key);yield {};}
        return success(80);
      } finally {live--;}
    })();
  });
  const entries=Array.from({length:39},(_,i)=>entry(`card-${i}`));
  api.reset('g',entries);timer.next();
  assert.equal(live,1);
  api.prioritize('card-20');timer.next();
  assert.equal(live,2);
  for(const key of ['card-21','card-22','card-23'])api.prioritize(key);
  timer.next();
  assert.deepEqual(created,['card-0','card-20'],'应继续已开始的可见搜索');
  assert.deepEqual(steps.slice(0,3),['card-0','card-20','card-20']);
  for(let i=0;timer.queue.size && i<300;i++)timer.next();
  assert.equal(timer.queue.size,0);
  assert.equal(results.length,39);
  assert.equal(new Set(created).size,39);
  assert.equal(created.length,39,'成功任务不应重复创建搜索');
  assert.equal(peak,2);
  assert.equal(live,0);
});

test('暂停期间零调度零回包，恢复继续同一迭代器，暂停中reset释放旧任务', () => {
  let created=0, closed=0, nextCalls=0;
  const {api,timer,results}=scheduler(()=>(function*(){
    created++;
    try {nextCalls++;yield {};nextCalls++;return success(80);} finally {closed++;}
  })());
  api.reset('g',[entry('card')]);timer.next();
  api.pause(true);
  assert.equal(timer.queue.size,0);
  assert.equal(closed,0,'暂停应保留搜索进度');
  const callsBefore=nextCalls;
  timer.time+=1000;timer.drain();
  assert.equal(nextCalls,callsBefore,'暂停期间不能推进迭代器');
  assert.equal(results.length,0);
  api.pause(false);timer.drain();
  assert.equal(created,1,'恢复应继续同一迭代器');
  assert.equal(nextCalls,2,'已完成片段不能重新计算');
  assert.equal(closed,1);
  assert.equal(results.length,1);
  assert.equal(results[0].generation,'g');

  api.reset('old-paused',[entry('old')]);timer.next();api.pause(true);
  assert.equal(created,2);
  assert.equal(closed,1);
  const pausedCalls=nextCalls;
  api.reset('new-paused',[entry('new')]);
  assert.equal(closed,2,'暂停期间reset应调用旧迭代器return');
  assert.equal(timer.queue.size,0,'reset应保留暂停状态');
  timer.time+=1000;timer.drain();
  assert.equal(nextCalls,pausedCalls);
  assert.equal(results.length,1);
  api.pause(false);timer.drain();
  assert.equal(created,3);
  assert.equal(closed,3);
  assert.equal(results.length,2);
  assert.equal(results[1].generation,'new-paused');
  assert.equal(results[1].key,'new');
  assert.ok(results.every(r=>r.generation!=='old-paused'));
});

test('最终无方案重试三轮后停圈，累计节点预算记录完整且不声称无解', () => {
  const profiles=[];
  const {api,timer,results}=scheduler((job,profile)=>{
    profiles.push(profile);
    return (function*(){yield {};return {ok:false,status:'no_plan_found',search:{expandedNodes:profile.maxExpandedNodes},errors:['SEARCH_NO_PLAN:有界未找到']};})();
  });
  api.reset('g',[entry('card')]);timer.drain();
  assert.equal(profiles.length,3);
  assert.ok(profiles.every((p,i)=>i===0 || p.beamWidth>profiles[i-1].beamWidth && p.maxExpandedNodes>profiles[i-1].maxExpandedNodes));
  assert.equal(results.length,1);
  const candidate=results[0].candidate;
  assert.equal(candidate.scoreStatus,'unresolved');
  assert.equal(candidate.fitScore,null);
  assert.equal(candidate.continuationFound,false);
  assert.equal(candidate.validation.expandedNodes,profiles.reduce((sum,p)=>sum+p.maxExpandedNodes,0));
  assert.equal(candidate.validation.expandedNodes,25600,'三轮单卡累计预算应为25600节点');
  assert.equal(candidate.validation.attempts,3);
  assert.equal(candidate.validation.searchStatus,'no_plan_found');
});

test('单卡创建搜索或迭代错误隔离，其他卡继续完成且错误卡不重试', () => {
  const attempts=new Map();
  const {api,timer,results}=scheduler(job=>{
    attempts.set(job.key,(attempts.get(job.key)||0)+1);
    if(job.key==='create-error')throw Error('create failed');
    return (function*(){yield {};if(job.key==='next-error')throw Error('next failed');return success(90);})();
  });
  api.reset('g',[entry('create-error'),entry('next-error'),entry('healthy')]);timer.drain();
  assert.equal(results.length,3);
  for(const key of ['create-error','next-error']) {
    const r=results.find(r=>r.key===key);
    assert.equal(r.candidate.scoreStatus,'error');
    assert.equal(r.candidate.fitScore,null);
    assert.equal(attempts.get(key),1);
    assert.match(r.error,/failed/);
  }
  assert.equal(results.find(r=>r.key==='healthy').candidate.scoreStatus,'evaluated');
  assert.ok(results.every(r=>r.generation==='g'));
});
