import { createPlanner } from './engine.mjs';
import { catalog, rules, graph } from './data/catalog.mjs';

const planner = createPlanner({ ...catalog, rules, graph });
// 请求序号由界面校验，过期结果不会覆盖用户较新的选择。
self.onmessage = ({ data }) => {
  try {
    const started = performance.now();
    const result = planner.plan(data.state.context, data.state.exploration, data.state.prefix);
    self.postMessage({ id: data.id, result, elapsed: performance.now() - started });
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message || String(error) });
  }
};
