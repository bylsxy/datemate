import test from 'node:test';
import assert from 'node:assert/strict';
import {explainStage,explainDecision,formatFact} from '../explanations.mjs';
import {planDate} from '../engine.mjs';
test('首页理由只解释真正勾选的共同兴趣，不推断未填兴趣',()=>{
  const p={kind:'ordinary',tags:['indoor'],indoor:true,activities:[{id:'game',title:'双人游戏',tags:['play'],requires:[]}]};
  const a=explainStage({index:0,activityIds:['game']},p,{preferencesA:['play'],preferencesB:['play'],weather:'rain'});
  assert.ok(a.some(x=>x.includes('游戏')));assert.ok(a.some(x=>x.includes('下雨')));
  const b=explainStage({index:0,activityIds:[]},p,{});assert.ok(!b.some(x=>x.includes('共同喜欢')));
  assert.ok(!a.join('').match(/模型|效用|图谱|负担|预算|价格|¥/));
});

const place={id:'chosen',kind:'ordinary',tags:[],activities:[]};
test('原始轨迹完整保留顺序、重复规则、嵌套事实与全部证据且不修改源数据',()=>{
  const trace=[
    {ruleId:'same',round:1,message:'第一次',inputFacts:[{id:'x',value:false},{id:'missing',value:undefined}],outputFacts:[{id:'y',value:0}],evidence:['e1','e1'],evidenceIds:['e1'],path:['a','b'],extra:{nested:[null,{v:3}]}},
    {ruleId:'same',round:2,title:'原始标题',message:'第二次',inputFacts:{a:[1,2]},outputFacts:[],evidence:{source:'原文'}},
  ];
  const stage={activityIds:[],trace};
  const snapshot=structuredClone(stage);
  const result=explainDecision(stage,place);
  assert.deepEqual(result.trace.map(t=>t.raw),trace);
  for(let i=0;i<trace.length;i++)for(const key of Object.keys(trace[i]))assert.deepEqual(result.trace[i][key],trace[i][key]);
  assert.deepEqual(result.trace.map(t=>t.round),[1,2]);
  assert.equal(result.trace[1].title,'原始标题');
  result.trace[0].raw.extra.nested[1].v=99;
  result.trace[1].inputFacts.a.push(3);
  assert.deepEqual(stage,snapshot);
});

test('决策解释保留参考尺和特征原值，仅在返回的已评分候选中比较',()=>{
  const stage={sceneId:'chosen',activityIds:[],fitScore:60,rawUtility:30,
    scoreReference:{prefixUtility:10,referenceUtility:80,formula:'50 + 50 * (q - prefixUtility) / (abs(q - prefixUtility) + referenceUtility)',scope:'previous_stages_and_anchors',searchStatus:'bounded_not_proved_optimal'},
    featureContributions:{preferenceA:18,resourcePenalty:-2,customFeature:0},
    candidates:[{sceneId:'better',fitScore:70,rawUtility:50,continuationFound:true},{sceneId:'chosen',fitScore:60,continuationFound:true},{sceneId:'tie',fitScore:60},{sceneId:'pending',fitScore:null,scoreStatus:'pending'},{sceneId:'no-future',fitScore:99,continuationFound:false}]};
  const result=explainDecision(stage,place);
  assert.equal(result.selection.rank,2);
  assert.equal(result.comparison.evaluatedCount,3);
  assert.equal(result.comparison.pendingCount,2);
  assert.equal(result.comparison.tiedCount,2);
  assert.equal(result.comparison.bestScore,70);
  assert.equal(result.comparison.basis,'initial_planning_snapshot');
  assert.match(result.selection.message,/本次初始搜索/);
  assert.match(result.comparison.message,/初始搜索快照/);
  assert.match(result.comparison.message,/后台验证结果独立显示，可能找到更优候选/);
  assert.doesNotMatch(result.selection.message,/始终最高|全局最优/);
  assert.match(result.selection.message,/60/);
  assert.match(result.comparison.message,/不代表全局最优/);
  assert.equal(result.metrics.remainingUtility,20);
  assert.deepEqual(result.metrics.scoreReference,stage.scoreReference);
  assert.deepEqual(result.metrics.featureContributions,stage.featureContributions);
  assert.equal(result.metrics.features[2].label,'customFeature');
  assert.match(result.metrics.calculation,/q=30.*prefixUtility=10.*referenceUtility=80/);
  assert.deepEqual(result.comparison.candidates,stage.candidates);
});

test('手动低分与多个必去、排除约束如实解释，不伪造规则过程',()=>{
  const context={bans:['a','b'],anchors:[{id:'first',choice:{sceneId:'other'}},{id:'second',choice:{sceneId:'chosen'},startMinute:1200}]};
  const stage={sceneId:'chosen',activityIds:[],manual:true,anchorId:'second',mealRole:'dinner',fitScore:0,rawUtility:0,candidates:[{sceneId:'other',fitScore:80}],trace:[]};
  const result=explainDecision(stage,place,context);
  assert.match(result.selection.message,/手动锁定/);
  assert.match(result.selection.message,/second/);
  assert.match(result.selection.message,/晚餐/);
  assert.match(result.selection.message,/2 项预约/);
  assert.match(result.selection.message,/2 项排除/);
  assert.equal(result.selection.score,0);
  assert.equal(result.selection.rank,2);
  assert.deepEqual(result.selection.anchor,context.anchors[1]);
  assert.deepEqual(result.selection.constraints,{...context,requiredSceneIds:[]});
  assert.deepEqual(result.trace,[]);
  result.selection.constraints.bans.push('new');
  assert.deepEqual(context.bans,['a','b']);
});

test('无序多必去地点单独解释，不当作手动锁定或预约锚点',()=>{
  const context={requiredSceneIds:['other','chosen']};
  const decision=explainDecision({sceneId:'chosen',activityIds:[],manual:false},place,context);
  assert.equal(decision.selection.requiredScene,true);
  assert.equal(decision.selection.manual,false);
  assert.equal(decision.selection.anchorId,null);
  assert.match(decision.selection.message,/满足必去地点要求/);
  assert.match(decision.selection.message,/访问次序由引擎安排/);
  assert.doesNotMatch(decision.selection.message,/手动锁定|预约锚点/);
  assert.deepEqual(decision.selection.constraints.requiredSceneIds,['other','chosen']);
  assert.equal(explainDecision({sceneId:'optional',activityIds:[]},place,context).selection.requiredScene,false);
  assert.deepEqual(context.requiredSceneIds,['other','chosen']);
});

test('缺失与待评估分数保持未知，不被当作0分或可行候选',()=>{
  for(const stage of [{activityIds:[]},{activityIds:[],scoreStatus:'pending',fitScore:90,rawUtility:null}]){
    const result=explainDecision(stage,place);
    assert.equal(result.selection.score,null);
    assert.equal(result.selection.rank,null);
    assert.equal(result.comparison.bestScore,null);
    assert.equal(result.metrics.remainingUtility,null);
    assert.match(result.selection.message,/尚无可用/);
    assert.match(result.metrics.calculation,/未完整提供/);
  }
  assert.equal(formatFact(undefined),'未提供');
  assert.equal(formatFact(null),'null（空值）');
  assert.equal(formatFact(false),'false（否）');
  assert.equal(formatFact(0),'0');
  const value={values:[0,false,null,'原始证据'],nested:{n:1.23456789}};
  assert.deepEqual(JSON.parse(formatFact(value)),value);
});

test('短摘要不把数组或计数字典中的内部成果、物品混作出发前准备',()=>{
  for(const requires of [['unknown-kit','meal_completed'],{unknown_kit:1,meal_completed:1}]){
    const p={...place,activities:[{id:'play',title:'玩法',requires}]};
    for(const preparedIds of [[],['unknown-kit']]){
      const result=explainStage({activityIds:['play'],preparationIds:['reservation','meal_completed']},p,{preparedIds});
      assert.match(result.join(''),/玩法/);
      assert.doesNotMatch(result.join(''),/准备|meal_completed|unknown.kit|reservation|\[object Object\]/);
      assert.ok(result.length<=6);
    }
  }
});

test('真实引擎输出的分数计算与规则轨迹直接用于解释',()=>{
  const scenes=['a','b'].map((id,i)=>({id,minutes:30,cost:[0,0],load:0,area:'campus',kind:'ordinary',indoor:true,quiet:true,fit:60+i*20,activities:[]}));
  const result=planDate({duration:60,windows:[{id:'pm',startMinute:840,endMinute:900}],reserve:0,robust:false}, {version:'explanation-test',scenes,transfers:{campus:{campus:0}}},{maxStages:1});
  assert.equal(result.ok,true,result.errors?.join(';'));
  const stage=result.stages[0];
  const decision=explainDecision(stage,scenes.find(s=>s.id===stage.sceneId),result.context);
  assert.deepEqual(decision.trace.map(t=>t.raw),stage.trace);
  assert.ok(decision.trace.length>0);
  const gain=decision.metrics.remainingUtility;
  const expected=+(50+50*gain/(Math.abs(gain)+stage.scoreReference.referenceUtility)).toFixed(2);
  assert.equal(decision.selection.score,expected);
  assert.deepEqual(decision.comparison.candidates,stage.candidates);
});
test('饭点与实际疲惫推理用因果过程解释，保留用户可读的判断步骤',()=>{
  const meal={kind:'meal',tags:['food'],activities:[{id:'eat',title:'简餐',tags:['food'],requires:[],provides:['meal_completed']}]};
  const reason=explainStage({index:3,mealRole:'dinner',activityIds:['eat']},meal,{periodIds:['afternoon','evening']}).join('');
  assert.match(reason,/下午和晚上/);assert.match(reason,/晚饭时间/);assert.match(reason,/两边的活动接起来/);assert.match(reason,/简餐/);
  const rest={kind:'rest',tags:[],activities:[]};
  const recovery=explainStage({index:2,activityIds:[],trace:[{ruleId:'R-fatigue-derive'}]},rest,{}).join('');
  assert.match(recovery,/疲惫状态/);assert.match(recovery,/所以先休息再继续/);assert.ok(!recovery.includes('R-fatigue'));
});
