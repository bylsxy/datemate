import {escapeHTML as esc} from './planner.mjs?v=2a1461a1394feb8d';
import {isSceneInUIScope,normalizeUIScope} from './scope-ui.mjs?v=2a1461a1394feb8d';

const searchable = scene => [scene.title, scene.id, ...(Array.isArray(scene.aliases) ? scene.aliases : []), ...(Array.isArray(scene.keywords) ? scene.keywords : [])].filter(Boolean).join(' ').toLocaleLowerCase();
export function searchPlaces(scenes, query = '', context = {}) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return scenes.filter(s => s.kind !== 'rest' && isSceneInUIScope(s, context) && terms.every(term => searchable(s).includes(term)));
}
export function addPlace(choices, kind, sceneId, scenes, context = {}) {
  if (!['bans','requiredSceneIds'].includes(kind)) throw Error('请选择不去或必去。');
  const scene = scenes.find(s => s.id === sceneId && s.kind !== 'rest' && isSceneInUIScope(s, context));
  if (!scene) throw Error('请先从下拉列表选择一个地点。');
  const other = kind === 'bans' ? 'requiredSceneIds' : 'bans';
  if ((choices[other] || []).includes(sceneId)) throw Error(`${scene.title}已在${other === 'bans' ? '不去' : '必去'}中，请先移除再添加。`);
  return {bans:[...(choices.bans || [])], requiredSceneIds:[...(choices.requiredSceneIds || [])], [kind]:[...new Set([...(choices[kind] || []), sceneId])]};
}

/** 搜索与浏览不触发规划，只有实际添加或移除地点才提交新的条件。 */
export function createPlacePicker({root, scenes, onChange}) {
  const search = root.querySelector('#place-search'), select = root.querySelector('#place-select');
  const message = root.querySelector('#place-choice-error');
  const buttons = {bans:root.querySelector('#add-exclude'), requiredSceneIds:root.querySelector('#add-anchor')};
  const lists = {bans:root.querySelector('#excluded-places'), requiredSceneIds:root.querySelector('#anchored-places')};
  let choices = {bans:[], requiredSceneIds:[]};
  let scope = normalizeUIScope();
  function prune() {
    for (const kind of Object.keys(choices)) choices[kind] = choices[kind].filter(id => scenes.some(scene => scene.id === id && scene.kind !== 'rest' && isSceneInUIScope(scene, scope)));
  }
  function options() {
    const previous = select.value, matches = searchPlaces(scenes, search.value, scope);
    select.innerHTML = `<option value="">${matches.length ? '请选择地点' : '未找到匹配地点'}</option>` + matches.map(s => `<option value="${esc(s.id)}">${esc(s.title)}</option>`).join('');
    select.value = matches.some(s => s.id === previous) ? previous : matches.length === 1 ? matches[0].id : '';
    select.disabled = !matches.length;
    for (const button of Object.values(buttons)) button.disabled = !select.value;
  }
  function render() {
    for (const [kind, list] of Object.entries(lists)) {
      list.innerHTML = choices[kind].length ? choices[kind].map(id => {
        const title = scenes.find(s => s.id === id)?.title || id;
        return `<span class="place-chip"><span>${esc(title)}</span><button type="button" data-remove-place="${esc(id)}" data-kind="${kind}" aria-label="从${kind === 'bans' ? '不去' : '必去'}移除${esc(title)}">×</button></span>`;
      }).join('') : '<span class="place-empty">未添加</span>';
    }
  }
  search.addEventListener('input', () => {message.textContent = ''; options();});
  search.addEventListener('keydown', event => {if (event.key === 'Enter') {event.preventDefault(); select.focus();}});
  select.addEventListener('change', () => {for (const button of Object.values(buttons)) button.disabled = !select.value;});
  for (const [kind, button] of Object.entries(buttons)) button.addEventListener('click', () => {
    try {
      const next = addPlace(choices, kind, select.value, scenes, scope);
      if (JSON.stringify(next) === JSON.stringify(choices)) {message.textContent = '这个地点已经添加。'; return;}
      choices = next; message.textContent = ''; render(); onChange();
    } catch (error) {message.textContent = error.message;}
  });
  root.addEventListener('click', event => {
    const button = event.target.closest('button[data-remove-place]');
    if (!button) return;
    choices[button.dataset.kind] = choices[button.dataset.kind].filter(id => id !== button.dataset.removePlace);
    message.textContent = ''; render(); onChange();
  });
  options(); render();
  return {
    getChoices: () => structuredClone(choices),
    setScope(context) {
      scope = normalizeUIScope(context); prune(); options(); render();
    },
    setChoices(context) {
      scope = normalizeUIScope(context);
      choices = {bans:[...(context.bans || [])], requiredSceneIds:[...(context.requiredSceneIds || context.anchors?.filter(a => a.sceneOnly).map(a => a.choice.sceneId) || [])]};
      prune(); options(); render();
    },
  };
}
