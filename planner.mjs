// 界面展示使用统一单位；算法与硬约束由 engine.mjs 负责。
export const formatTime = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
export const costLabel = cost => { const [a=0,b=a] = Array.isArray(cost) ? cost : [cost?.min ?? 0,cost?.max ?? 0]; return a === b ? `¥${a}` : `¥${a}–${b}`; };
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const interestLabels = {nature:'自然',culture:'文化',food:'美食',play:'游戏',creative:'手作',romantic:'氛围',quiet:'安静',indoor:'室内',exercise:'运动',learning:'学习',daily:'日常',photo:'拍照',music:'音乐'};
export function defaultContext() { return {duration:180,budget:null,weather:'unknown',area:'near',fatigueA:2,fatigueB:2,preferences:[],quietRequired:false,theme:'any',bans:[],preferencesA:[],preferencesB:[],preparedIds:[],dietaryRestrictions:[],robust:true,mealNeed:false,crowdAvoidance:false,windows:[{id:'default',startMinute:840,endMinute:1020}],anchors:[]}; }
export function toggleActivity(scene, selected, id) {
  const activity = scene.activities.find(a=>a.id===id);
  if (!activity) throw new Error('这个场景不支持所选活动。');
  if (selected.includes(id)) return selected.filter(x=>x!==id);
  let ids = [...selected];
  if (activity.mode === 'single' || activity.compositionMode === 'exclusive') ids=ids.filter(x=>scene.activities.find(a=>a.id===x)?.group!==activity.group);
  if (activity.exclusiveKey) ids=ids.filter(x=>scene.activities.find(a=>a.id===x)?.exclusiveKey!==activity.exclusiveKey);
  return [...ids,id];
}
export function validateReplay(value) {
  if (!value || typeof value !== 'object' || value.format !== 'datemate-ui-replay-3.0') throw new Error('这不是本版本的 DateMate 复盘文件。');
  if (!value.state || !value.state.context || typeof value.state.context !== 'object' || Array.isArray(value.state.context) || !Number.isInteger(value.state.exploration) || value.state.exploration<0 || value.state.exploration>100 || !Array.isArray(value.state.prefix) || !/^[a-f0-9]{8}$/.test(value.outputFingerprint || '')) throw new Error('复盘状态格式不正确。');
  return value;
}
