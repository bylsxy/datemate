import {isSceneInSchoolScope,normalizeSchoolScope} from './school-scope.mjs?v=3b6419e840a1e140';
import {isSceneAvailableInContext} from './scene-time.mjs?v=3b6419e840a1e140';

/** 隐藏的父级必须同步清空后代，导入和表单读取共用同一规则。 */
export function normalizeUIScope(context = {}) {
  const area = context.area === 'nearby' ? 'near' : ['near', 'campus'].includes(context.area) ? context.area : 'all';
  return {...context, area, ...normalizeSchoolScope({...context, area})};
}

export function createSchoolScopeControls(root) {
  const school = root.querySelector('#school-scau'), dorm = root.querySelector('#campus-area-taishan');
  let wasSelected = false;
  const remember = () => {wasSelected = dorm.checked;};
  root.addEventListener('pointerdown', event => {if (event.target === dorm || event.target.closest('label')?.contains(dorm)) remember();});
  dorm.addEventListener('keydown', event => {if (event.key === ' ') remember();});
  // 单个 radio 允许再次激活后恢复未选，鼠标与空格键采用相同语义。
  dorm.addEventListener('click', event => {
    if (wasSelected) {
      event.preventDefault();
      queueMicrotask(() => {dorm.checked = false; dorm.dispatchEvent(new Event('change', {bubbles: true}));});
    }
    wasSelected = false;
  });
  function set(context) {
    const scope = normalizeUIScope(context);
    for (const input of root.querySelectorAll('input[name="area"]')) input.checked = input.value === scope.area;
    school.checked = scope.school === 'scau'; dorm.checked = scope.campusArea === 'taishan';
    root.querySelector('#school-scope').hidden = scope.area === 'all';
    root.querySelector('#school-scope-hint').hidden = !school.checked;
    root.querySelector('#campus-area-scope').hidden = !school.checked;
    root.querySelector('#campus-area-scope-hint').hidden = !dorm.checked;
    return scope;
  }
  function read() {
    return set({area: root.querySelector('input[name="area"]:checked')?.value || 'all', school: school.checked ? 'scau' : '', campusArea: dorm.checked ? 'taishan' : ''});
  }
  return {set, read};
}

export function isSceneInUIScope(scene, context) {
  if (!scene) return false;
  const scope = normalizeUIScope(context);
  return isSceneInSchoolScope(scene, scope) && isSceneAvailableInContext(scene, scope);
}

/** 切换学校时解除已不适用的固定餐馆，让新范围可以重新推荐用餐。 */
export function filterScopedMealChoices(choices, scenes, context) {
  const byId = new Map(scenes.map(scene => [scene.id, scene]));
  return Object.fromEntries(Object.entries(choices || {}).filter(([, choice]) => !choice?.sceneId || isSceneInUIScope(byId.get(choice.sceneId), context)).map(([role, choice]) => [role, structuredClone(choice)]));
}

export function filterUIResult(result, scenes, context) {
  const allowed = new Set(scenes.filter(scene => isSceneInUIScope(scene, context)).map(scene => scene.id));
  const candidates = list => (list || []).filter(item => allowed.has(item.sceneId || item.id));
  const stage = item => ({...item, candidates: candidates(item.candidates)});
  return {...result, stages: (result.stages || []).map(stage),
    meals: result.meals?.map(item => ({...item, candidates: candidates(item.candidates)})),
    mealRequirements: result.mealRequirements?.map(item => ({...item, candidates: candidates(item.candidates)})),
    paretoPlans: result.paretoPlans?.filter(plan => plan.stages.every(item => !item.sceneId || allowed.has(item.sceneId))).map(plan => ({...plan, stages: plan.stages.map(stage)}))};
}

export function filterUIGraph(graph, scenes, context) {
  const denied = new Set(), allActivities = new Set(), allowedActivities = new Set();
  for (const scene of scenes) {
    const allowed = isSceneInUIScope(scene, context);
    if (!allowed) denied.add(scene.id);
    for (const activity of scene.activities || []) {
      allActivities.add(activity.id);
      if (allowed) allowedActivities.add(activity.id);
    }
  }
  for (const id of allActivities) if (!allowedActivities.has(id)) denied.add(id);
  const nodes = graph.nodes.filter(node => !denied.has(node.id)), ids = new Set(nodes.map(node => node.id));
  return {...graph, nodes, edges: graph.edges.filter(edge => ids.has(edge.subject) && ids.has(edge.object))};
}
