import test from 'node:test';
import assert from 'node:assert/strict';
import {catalog,rules,graph} from '../data/catalog.mjs';
import {defaultContext,toggleActivity} from '../planner.mjs';
import {defaultPreparationResources} from '../preparation.mjs';
import {planDate,verifyPlanWitness} from '../engine.mjs';
import {buildActionJobs} from '../candidate-validation.mjs';

const knowledge={...catalog,rules,graph};
const contexts=[
  {periodIds:['afternoon'],budget:null},
  {periodIds:['afternoon'],budget:50,requiredSceneIds:['mall']},
  {periodIds:['morning'],budget:50,mealChoices:{breakfast:{mode:'before_meeting'}}},
];

test('真实知识库中已验证的场景与活动，点击后在最小搜索预算下仍有完整路径',()=>{
  let checked=0,activityChecks=0,rejected=0;
  for(const overrides of contexts){
    const context={...defaultContext(),...defaultPreparationResources(catalog),...overrides,explorationSeed:123};
    const state={context,exploration:97,prefix:[]};
    const result=planDate(context,knowledge,{exploration:state.exploration});
    assert.equal(result.ok,true,result.errors?.join(';'));
    const actions=[];
    result.stages.forEach((stage,stageIndex)=>{
      for(const candidate of stage.candidates||[])if(candidate.continuationWitness)actions.push({actionKey:`scene-${stageIndex}-${candidate.sceneId}`,actionType:'scene',stageIndex,sceneId:candidate.sceneId,mealRole:stage.mealRole,activityIds:candidate.activityIds,candidate});
      const scene=catalog.scenes.find(s=>s.id===stage.sceneId);
      for(const activity of scene?.activities||[])actions.push({actionKey:`activity-${stageIndex}-${activity.id}`,actionType:'activity',stageIndex,sceneId:stage.sceneId,mealRole:stage.mealRole,activityId:activity.id,activityIds:toggleActivity(scene,stage.activityIds,activity.id)});
    });
    for(const job of buildActionJobs(result,state,catalog,actions)){
      const options={...job.search,fixedPrefix:job.prefix,exploration:job.exploration,knownPlan:job.knownPlan};
      const verified=verifyPlanWitness(job.context,knowledge,options);
      if(!verified.ok){rejected++;continue;}
      checked++;if(job.actionType==='activity')activityChecks++;
      const clicked=planDate(job.context,knowledge,{...options,maxExpandedNodes:1,maxCandidateExpandedNodes:0});
      assert.equal(clicked.ok,true,`${job.key}: ${clicked.errors?.join(';')}`);
      assert.ok(clicked.continuationWitness?.length);
      assert.deepEqual(clicked.stages.slice(0,job.prefix.length).map(s=>[s.sceneId,[...s.activityIds].sort(),s.mealRole]),job.prefix.map(s=>[s.sceneId,[...s.activityIds].sort(),s.mealRole]));
      const replay=planDate(clicked.replay.context,knowledge,{...clicked.replay.search,exploration:clicked.replay.exploration,fixedPrefix:clicked.replay.prefix,knownPlan:clicked.replay.knownPlan});
      assert.equal(replay.outputFingerprint,clicked.outputFingerprint);
    }
  }
  assert.ok(checked>10,`仅验证 ${checked} 个动作`);
  assert.ok(activityChecks>0);
  assert.ok(rejected>0,'应覆盖不能直接沿用旧完整路径的动作');
});
