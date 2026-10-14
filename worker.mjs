import { createPlanner, createContinuationSearch, planDate, verifyPlanWitness } from './engine.mjs?v=a4420782c4d5e641';
import { catalog, rules, graph } from './data/catalog.mjs?v=a4420782c4d5e641';
import { createCandidateScheduler } from './candidate-validation.mjs?v=a4420782c4d5e641';

const knowledge = { ...catalog, rules, graph };
const planner = createPlanner(knowledge);
function verifyAction(job, options) {
  const settings = {...job.search, ...options, fixedPrefix:job.prefix, exploration:job.exploration};
  if (job.knownPlan?.length) {
    const verified = verifyPlanWitness(job.context, knowledge, {...settings, knownPlan:job.knownPlan});
    if (verified.ok) return verified;
  }
  return null;
}
function* validateAction(job, options) {
  return yield* createContinuationSearch(job.context, knowledge, {...job.search,...options,fixedPrefix:job.prefix,exploration:job.exploration});
}
const validation = createCandidateScheduler({
  verifyCandidate: verifyAction,
  createSearch: validateAction,
  onResult: update => self.postMessage({type:'candidate', ...update}),
});
// 请求序号由界面校验，过期结果不会覆盖用户较新的选择。
self.onmessage = ({ data }) => {
  if (data.type === 'validate') {validation.reset(data.generation, data.jobs);return;}
  if (data.type === 'prioritize') {validation.prioritize(data.key);return;}
  if (data.type === 'cancelValidation') {validation.dispose();return;}
  if (data.type === 'pauseValidation') {validation.pause(data.paused);return;}
  try {
    const started = performance.now();
    const result = data.search || data.knownPlan || data.selectionMode ? planDate(data.state.context, knowledge, {...data.search, selectionMode:data.selectionMode??data.search?.selectionMode, knownPlan:data.knownPlan??undefined, exploration:data.state.exploration, fixedPrefix:data.state.prefix}) : planner.plan(data.state.context, data.state.exploration, data.state.prefix);
    self.postMessage({ id: data.id, result, elapsed: performance.now() - started });
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message || String(error) });
  }
};
