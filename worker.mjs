import { createPlanner, createContinuationSearch, planDate } from './engine.mjs?v=babb8dc4a6cd6ec1';
import { catalog, rules, graph } from './data/catalog.mjs?v=babb8dc4a6cd6ec1';
import { createCandidateScheduler } from './candidate-validation.mjs?v=babb8dc4a6cd6ec1';

const knowledge = { ...catalog, rules, graph };
const planner = createPlanner(knowledge);
const validation = createCandidateScheduler({
  createSearch: (job, options) => createContinuationSearch(job.context, knowledge, {...job.search, ...options, fixedPrefix:job.prefix, exploration:job.exploration}),
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
    const result = data.search ? planDate(data.state.context, knowledge, {...data.search, exploration:data.state.exploration, fixedPrefix:data.state.prefix}) : planner.plan(data.state.context, data.state.exploration, data.state.prefix);
    self.postMessage({ id: data.id, result, elapsed: performance.now() - started });
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message || String(error) });
  }
};
