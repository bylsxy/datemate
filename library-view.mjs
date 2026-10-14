/** 全量资料阅读视图：按公开可读字段渲染，不依赖当前规划范围。 */
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const array = value => Array.isArray(value) ? value : [];
const keys = value => Array.isArray(value) ? value : Object.keys(value || {});
const unique = values => [...new Set(values)];
const translatedTitles = new Map([
  ['Phubbing in romantic relationships and retaliation： A daily diary study','亲密关系中的低头冷落与报复：日记研究（译名）'],
  ['“Leveling up” in Love： processual social exchange trajectories in digital dating among Chinese university students','恋爱中的升级：中国大学生数字约会的社会交换历程（译名）'],
  ['Couples vacations and romantic passion and intimacy','情侣度假与浪漫激情、亲密程度（译名）'],
  ['Carpe Diem','及时行乐（译名）'],
  ['WithoutRomance','没有浪漫（译名）'],
  ['Planning date nights that promote closeness： The roles of relationship goals and self-expansion','促进亲密的约会之夜：关系目标与自我拓展的作用（译名）'],
]);
const labels = {
  nature:'自然观察',culture:'文化体验',food:'餐饮',play:'游戏互动',creative:'创作手作',romantic:'浪漫氛围',quiet:'安静',indoor:'室内',exercise:'轻运动',learning:'共同学习',daily:'日常生活',photo:'拍照',music:'音乐',dream:'梦想清单',travel:'旅行',celebration:'庆祝',confession:'告白',shared_hobby:'共同爱好',private:'私密氛围',night:'夜间体验',japanese:'日式体验',chinese:'中式体验',outdoor:'户外',birthday:'生日',anniversary:'纪念日',exam:'考试季',
  caffeine:'含咖啡因饮品',cold:'冷饮冷食',dairy:'乳制品',gluten:'含麸质食物',meat:'肉类',raw:'生食',spicy:'辣味',heaty:'易上火食物',
  rest:'休息',meal:'正餐',explore:'探索',campus:'校内',near:'附近',current:'当前位置',off:'校外',dorm:'宿舍附近',rain:'雨天',clear:'晴天',cloudy:'多云',high:'较高',unknown:'待确认',longterm:'长期关系',weekday:'周中',weekend:'周末',fresh:'新鲜体验',planning_default:'规划默认时段','user-provided':'用户提供',tier1:'一线城市',tier2:'二线城市',tier3:'三线及其他城市',
};
const factLabels = {
  'context.fatigueA':'我方疲惫程度','context.fatigueB':'对方疲惫程度','context.mealNeed':'用餐需求','context.duration':'可用时长（分钟）','context.budget':'预算（元）','context.weather':'天气','context.quietRequired':'安静要求','context.crowdAvoidance':'避开人流需求','context.dietaryRestrictions':'饮食限制','context.preparedIds':'已准备事项','context.season':'时期','context.relationship':'关系阶段','context.reunion':'久别重逢','context.weekPart':'周内时段','context.preferences':'共同规划偏好','context.preferencesA':'我方兴趣','context.preferencesB':'对方兴趣','context.theme':'主题','context.robust':'稳妥模式',
  'scene.kind':'场景类型','scene.load':'场景负担','scene.indoor':'室内场景','scene.sheltered':'遮蔽条件','scene.quiet':'安静条件','scene.crowdRisk':'人流风险','scene.id':'场景','scene.area':'地点范围','scene.minutes':'场景时长（分钟）','scene.novelty':'场景新鲜度','scene.tags':'场景特点','scene.uncrowded':'人少条件','scene.queueMinutes':'预计排队时间（分钟）','scene.preparationIds':'场景准备事项','scene.cost.1':'场景费用上界（元）',
  'activity.load':'活动负担','activity.dietaryTags':'活动食材特点','activity.id':'活动','activity.tags':'活动特点','activity.requiresExplicitConsent':'活动需明确同意','graph.matchedPreferenceTags':'匹配的兴趣',
  'derived.needsRecovery':'恢复需求','derived.needsMeal':'用餐目标','derived.shortVisit':'短距离会面目标','derived.saveBudget':'节约目标','derived.examShortMeeting':'考试季短会目标','derived.seekFreshTogether':'更新共同体验目标','derived.reunionSharedExperience':'重逢共享体验目标','derived.weekdayUncrowded':'周中错峰会面目标','derived.weekendQueueAware':'周末留意排队目标',
};
const sourceKinds = {secondary:'二手整理资料',first_person_report:'个人经历报告',fiction:'文学剧情',game:'游戏剧情',research:'学术研究',user_design:'用户提供的原创设计'};
const assertionKinds = {inferred:'归纳推导',observed:'材料中的观察记录',designed:'原创设计'};

function translatedTitle(title) {
  const exact = translatedTitles.get(title);
  if (exact) return exact;
  for (const [original, translated] of translatedTitles) {
    if (title?.startsWith(`${original}（`)) return translated + title.slice(original.length);
  }
  return title || '未注明标题';
}
function safeUrl(value) {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return ['http:','https:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}
function sourceLinks(source) {
  const urls = unique([...array(source?.declaredUrls),source?.url,source?.sourceUrl].map(safeUrl).filter(Boolean));
  return urls.length ? `<p class="library-meta">登记链接（未核验）：${urls.map((url,i) => `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">来源链接 ${i+1}</a>`).join('、')}</p>` : '';
}
const paragraph = (text, className = 'library-description') => text ? `<p class="${className}">${escapeHTML(text)}</p>` : '';
const list = items => items.length ? `<ul class="library-list">${items.map(item=>`<li>${escapeHTML(item)}</li>`).join('')}</ul>` : '';
const entry = (number,title,body) => `<article class="library-entry"><h4>${number}. ${escapeHTML(title)}</h4>${body}</article>`;
const section = (key,title,count,body) => `<section id="library-${key}" class="library-section"><h3>${escapeHTML(title)}（${count} 项）</h3>${body}</section>`;

export function renderLibraryHTML({catalog = {},sources = [],evidence = [],rules = catalog.rules || []} = {}) {
  const scenes = array(catalog.scenes), activities = array(catalog.activities);
  sources = array(sources); evidence = array(evidence); rules = array(rules);
  const resources = array(catalog.graph?.nodes).filter(node=>node.type==='resource');
  const departures = array(catalog.departures);
  const sourceById = new Map(sources.map(source=>[source.id,source]));
  const evidenceById = new Map(evidence.map(item=>[item.id,item]));
  const names = new Map(Object.entries(labels));
  for (const item of [...scenes,...activities,...departures]) names.set(item.id,item.title || item.place?.name || '未注明名称');
  for (const resource of resources) names.set(resource.id.replace(/^resource:/,''),resource.label || '未注明准备事项');
  // 机器词只在已知字典边界内替换，原始外文引用标题保留供追溯。
  const replacements = [...names].filter(([key])=>typeof key==='string' && key).sort((a,b)=>b[0].length-a[0].length);
  const readable = text => String(text ?? '').replace(/[A-Za-z][A-Za-z0-9_.:-]*/g,token => names.get(token) || factLabels[token] || token);
  const name = id => names.get(id) || '未注明关联事项';
  const references = ids => unique(array(ids)).map(id=>evidenceById.get(id)?.summary).filter(Boolean).map(readable);
  const requirements = item => unique(['preparationIds','requires','preconditions','consumes'].flatMap(field=>keys(item[field]))).map(name);
  const predecessors = item => array(item.predecessorIds).map(name);
  const related = item => list([
    ...requirements(item).map(text=>`准备或前置事项：${text}`),
    ...predecessors(item).map(text=>`先完成：${text}`),
  ]);
  const attachedIds = scene => array(scene.activities ?? scene.activityIds).map(item=>typeof item==='string'?item:item.id);
  const sceneActivities = scene => array(scene.activities ?? scene.activityIds).map(item=>typeof item==='string'?name(item):(item.title || name(item.id)));
  const groups = new Map();
  for (const source of sources) {
    const category = source.category==='5旮旯专辑'?'恋爱游戏资料':source.category==='6组员提供'?'小组整理资料':String(source.category || '其他资料').replace(/^\d+/, '');
    if (!groups.has(category)) groups.set(category,[]);
    groups.get(category).push(source);
  }
  const adopted = source => evidence.filter(item=>item.sourceDocumentId===source.id);
  const adoptedSources = sources.filter(source=>adopted(source).length).length;
  const sourcedEvidence = evidence.filter(item=>sourceById.has(item.sourceDocumentId)).length;
  const exclusionCounts = new Map();
  for (const source of sources) {
    if (source.exclusionReason) exclusionCounts.set(source.exclusionReason,(exclusionCounts.get(source.exclusionReason) || 0)+1);
  }
  const costText = cost => Array.isArray(cost) && cost.length===2 ? `${cost[0]}–${cost[1]} 元` : '';
  function designCost(item) {
    const weekday = costText(item.costByWeekPart?.weekday), weekend = costText(item.costByWeekPart?.weekend);
    if (weekday && weekend && weekday!==weekend) return paragraph(`两人设计费用：周中 ${weekday}；周末 ${weekend}。`,'library-meta');
    const cost = costText(item.cost) || weekday || weekend;
    return cost ? paragraph(`两人设计费用：${cost}。`,'library-meta') : '';
  }
  function sceneDetails(scene) {
    const duration = Array.isArray(scene.durationRange) ? `${scene.durationRange.join('–')} 分钟` : scene.minutes!==undefined ? `${scene.minutes} 分钟` : '';
    const environment = [typeof scene.indoor==='boolean'?(scene.indoor?'室内':'户外'):'',scene.sheltered?'有遮蔽':'',scene.quiet?'安静':'',scene.seated?'可坐下休息':''].filter(Boolean);
    const weather = array(scene.weather).map(value=>value==='unknown'?'天气待确认':labels[value]).filter(Boolean);
    return paragraph(duration?`设计停留范围：${duration}。`:'','library-meta')+designCost(scene)+
      paragraph([environment.length?`环境：${environment.join('、')}`:'',weather.length?`适用天气：${weather.join('、')}`:''].filter(Boolean).join('；'),'library-meta');
  }
  let sourceNumber = 0;
  const sourcesHTML = [...groups].map(([category,items])=>`<div class="library-group"><h4>${escapeHTML(category)}（${items.length} 项）</h4>${items.map(source=>{
    const count = adopted(source).length, title = translatedTitle(source.title);
    return entry(++sourceNumber,title,
      (title!==source.title?paragraph(`原题：${source.title}`,'library-meta'):'')+
      paragraph(count?`已登记参考材料 · 已采用：形成 ${count} 条证据摘要。`:'已登记参考材料 · 尚未形成采用证据。','library-meta')+
      paragraph(source.declaredRights && source.declaredRights!=='未见文件声明'?readable(source.declaredRights):'','library-note')+
      (!count && exclusionCounts.get(source.exclusionReason)===1 && /[\u3400-\u9fff]/u.test(source.exclusionReason || '') && !/候选抽取|人工核对的采用项/.test(source.exclusionReason)?paragraph(readable(source.exclusionReason),'library-note'):'')+sourceLinks(source));
  }).join('')}</div>`).join('');
  const scenesHTML = scenes.map((scene,i)=>entry(i+1,scene.title || scene.place?.name,
    paragraph(readable(scene.description))+sceneDetails(scene)+
    paragraph(`可选活动：${sceneActivities(scene).join('、') || '未登记附加活动'}`,'library-meta')+
    related(scene)+paragraph(readable(scene.availabilityNote),'library-note'))).join('');
  const activitiesHTML = activities.map((activity,i)=>{
    const locations = scenes.filter(scene=>attachedIds(scene).includes(activity.id) || array(activity.allowedSceneIds).includes(scene.id) || array(activity.allowedSceneTypes).includes(scene.typeId)).map(scene=>scene.title || scene.place?.name);
    return entry(i+1,activity.title,paragraph(readable(activity.description))+designCost(activity)+paragraph(`可安排地点：${unique(locations).join('、') || '未登记挂载地点'}`,'library-meta')+related(activity));
  }).join('');
  const evidenceHTML = evidence.map((item,i)=>{
    const source = sourceById.get(item.sourceDocumentId);
    return entry(i+1,`证据摘要 ${i+1}`,paragraph(readable(item.summary))+
      paragraph(`出处：${source?translatedTitle(source.title):item.sourceKind==='user_design'?'用户提供的原创设计':'未登记来源'}；${sourceKinds[item.sourceKind] || '参考材料'}；${assertionKinds[item.assertionKind] || '资料摘要'}。`,'library-meta')+
      paragraph(readable(item.verificationBoundary),'library-note')+sourceLinks(source));
  }).join('');
  function conditionValue(value) {
    if (Array.isArray(value)) {
      const values = value.map(conditionValue);
      return values.includes(null)?null:values.join('、');
    }
    if (typeof value==='boolean') return value?'是':'否';
    if (typeof value==='number' && Number.isFinite(value)) return String(value);
    if (typeof value==='string') return names.get(value) || (/^[^A-Za-z]*[\u3400-\u9fff][^A-Za-z]*$/u.test(value)?value:null);
    return null;
  }
  function conditionText(condition) {
    const fact = factLabels[condition.fact];
    if (!fact) return null;
    const ops = {gte:'不少于',lte:'不多于',gt:'大于',lt:'小于',eq:'为',neq:'不为',contains:'包含',not_contains:'不包含',in:'属于',intersects:'与以下项目有交集：'};
    if (condition.op==='exists') return `${fact}${condition.value===false?'未提供':'已提供'}`;
    const value = conditionValue(condition.value);
    return ops[condition.op] && value!==null?`${fact}${ops[condition.op]}${value}`:null;
  }
  function actionText(action) {
    if (action.action==='set_fact') return `建立${factLabels[action.fact] || '相应规划目标'}。`;
    if (action.action==='prefer_scene' || action.action==='prefer_activity') return `${Number(action.amount)<0?'降低':'提高'}${action.action==='prefer_scene'?'场景':'活动'}的排序优先程度。`;
    if (action.action==='require_preparation') return `需确认准备事项：${name(action.preparationId || action.id)}。`;
    return readable(action.message || action.reason || '按规则处理相应候选。');
  }
  const rulesHTML = rules.map((rule,i)=>{
    // 标题含拼接的机器标识符，按最长名称替换避免子串遮盖。
    let title = String(rule.title || '未注明规则');
    for (const [id,label] of replacements) title = title.split(id).join(label);
    const all = array(rule.when?.all).map(conditionText), any = array(rule.when?.any).map(conditionText);
    // 任一条件无法可靠翻译时省略整组适用说明，避免把部分条件误当完整触发条件。
    const conditions = [...all,...any].includes(null)?'':[all.length?`同时满足：${all.join('；')}。`:'',any.length?`满足其中一项：${any.join('；')}。`:''].join('');
    return entry(i+1,title,paragraph(conditions)+
      paragraph(array(rule.then).map(actionText).join(''))+list(references(rule.evidenceIds ?? rule.evidence)));
  }).join('');
  const resourcesHTML = resources.map((resource,i)=>{
    const id = resource.id.replace(/^resource:/,''), users = [...scenes,...activities].filter(item=>['preparationIds','requires','preconditions','consumes','provides'].some(field=>keys(item[field]).includes(id))).map(item=>item.title);
    return entry(i+1,resource.label,paragraph(`关联场景或活动：${unique(users).join('、') || '已登记的可用准备事项或行程成果'}`,'library-meta'));
  }).join('');
  const money = cost => Array.isArray(cost)?`${escapeHTML(cost[0])}–${escapeHTML(cost[1])} 元`:'';
  const departuresHTML = departures.map((departure,i)=>entry(i+1,departure.title,
    paragraph(readable(departure.description))+paragraph(`预留时间：${departure.minutes ?? '未注明'} 分钟${departure.onlyOvernight?'；适用于过夜安排':''}${departure.requiresExplicitChoice?'；需要明确选择':''}。`,'library-meta')+
    (departure.cost?`<p class="library-meta">设计费用：${money(departure.cost)}${departure.onlyOvernight?'（两人一晚）':'（两人）'}。</p>`:'')+
    list(Object.entries(departure.costByCityTier || {}).map(([tier,cost])=>`${name(tier)}：${cost.join('–')} 元（两人一间客房一晚）`)))).join('');
  const sourceNote = paragraph('参考材料按登记类别完整列出，已采用材料另标证据数量。作者和许可信息按原材料声明展示；未展示声明的材料尚无相关记录，登记链接尚未核验。','library-note');
  const chapters = [['sources','参考来源',sources.length,sourceNote+sourcesHTML],['scenes','场景',scenes.length,scenesHTML],['activities','活动',activities.length,activitiesHTML],['evidence','证据摘要',evidence.length,evidenceHTML],['rules','规划规则',rules.length,rulesHTML],['resources','准备事项与行程成果',resources.length,resourcesHTML],['departures','分别方式',departures.length,departuresHTML]];
  return `<div class="library-document"><h2>资料库</h2>${paragraph(`登记参考材料 ${sources.length} 份，其中 ${adoptedSources} 份形成 ${sourcedEvidence} 条采用证据；另有 ${evidence.length-sourcedEvidence} 条原创设计摘要。`,'library-counts')}${paragraph(catalog.rights,'library-note')}${paragraph(readable(catalog.disclaimer),'library-note')}<nav class="library-toc" aria-label="资料库章节目录">${chapters.map(([key,title,count])=>`<a href="#library-${key}">${escapeHTML(title)}（${count}）</a>`).join('')}</nav>${chapters.map(([key,title,count,body])=>section(key,title,count,body)).join('')}</div>`;
}

/** 首次展开生成全部章节；再次展开复用已有文档 DOM。 */
export function createLibraryView({container,...data}) {
  if (!container || typeof container!=='object') throw new TypeError('资料库需要有效的容器。');
  let rendered = false;
  return { render() {
    if (!rendered) { container.innerHTML = renderLibraryHTML(data); rendered = true; }
    return container;
  }};
}
