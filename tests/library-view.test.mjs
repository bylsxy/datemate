import test from 'node:test';
import assert from 'node:assert/strict';
import {catalog,sources,evidence,rules} from '../data/catalog.mjs';
import {createLibraryView,renderLibraryHTML} from '../library-view.mjs';

const data = {catalog,sources,evidence,rules};
const esc = value => String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const chapter = (html,key) => html.split(`<section id="library-${key}"`)[1]?.split('</section>')[0] || '';
const countEntries = html => (html.match(/class="library-entry"/g) || []).length;

test('七个章节完整覆盖公开数据，采用来源与登记材料准确区分',()=>{
  const html = renderLibraryHTML(data);
  for (const [key,count] of [['sources',151],['scenes',86],['activities',150],['evidence',63],['rules',59],['resources',22],['departures',4]]) {
    assert.equal(countEntries(chapter(html,key)),count,key);
    assert.ok(html.includes(`href="#library-${key}"`),key);
    assert.ok(chapter(html,key).includes(`${count}. `),`${key} 连续序号`);
  }
  assert.ok(html.includes('登记参考材料 151 份，其中 26 份形成 51 条采用证据；另有 12 条原创设计摘要。'));
  assert.equal((chapter(html,'sources').match(/· 已采用：/g)||[]).length,26);
  assert.ok(!html.includes('原材料未记录作者或许可声明'));
  assert.ok(!html.includes('仅完成候选抽取，未形成经人工核对的采用项'));
  assert.equal((html.match(/未展示声明的材料尚无相关记录/g)||[]).length,1);
  assert.ok(!html.includes('</a> · <a'));
  for (const source of sources) {
    assert.ok(chapter(html,'sources').includes(esc(source.title)),source.title);
    assert.ok(!html.includes(esc(source.path)),source.path);
    assert.ok(!html.includes(source.sha256),source.sha256);
  }
  for (const item of catalog.scenes) {
    assert.ok(chapter(html,'scenes').includes(esc(item.title)),item.title);
    assert.ok(chapter(html,'scenes').includes(esc(item.description)),item.title);
  }
  for (const item of catalog.activities) {
    assert.ok(chapter(html,'activities').includes(esc(item.title)),item.title);
    assert.ok(chapter(html,'activities').includes(esc(item.description)),item.title);
  }
  for (const item of evidence) {
    const summary = item.summary.replace(/\btier1\b/g,'一线城市').replace(/\btier2\b/g,'二线城市').replace(/\btier3\b/g,'三线及其他城市');
    assert.ok(chapter(html,'evidence').includes(esc(summary)),item.id);
  }
});

test('资源、地点、活动及规则关联用中文名称，机器字段不泄漏',()=>{
  const html = renderLibraryHTML(data);
  const text = html.replace(/<[^>]*>/g,' ').replace(/https?:\/\/[^\s；（）]+/g,'');
  for (const item of [...sources,...evidence,...rules,...catalog.scenes,...catalog.activities,...catalog.departures]) {
    const token = item.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    assert.ok(!new RegExp(`(?<![A-Za-z0-9_])${token}(?![A-Za-z0-9_])`).test(text),item.id);
  }
  for (const token of ['opening_checked','caffeine','planning_default','user-provided','context.','derived.','verified_in_local_source','designed_not_measured']) assert.ok(!html.includes(token),token);
  assert.ok(chapter(html,'scenes').includes('已核对开放与预约'));
  assert.ok(chapter(html,'activities').includes('农业博物馆'));
  assert.ok(chapter(html,'rules').includes('明确含咖啡因饮品饮食限制过滤冲突活动'));
  for (const resource of catalog.graph.nodes.filter(n=>n.type==='resource')) assert.ok(chapter(html,'resources').includes(esc(resource.label)));
  for (const departure of catalog.departures) assert.ok(chapter(html,'departures').includes(esc(departure.description)));
  assert.ok(chapter(html,'departures').includes('一线城市：200–400 元'));
  assert.ok(chapter(html,'sources').includes('恋爱游戏资料'));
  assert.ok(chapter(html,'sources').includes('小组整理资料'));
  assert.ok(html.includes('亲密关系中的低头冷落与报复：日记研究（译名）'));
  assert.ok(chapter(html,'scenes').includes('设计停留范围：30–180 分钟'));
  assert.ok(chapter(html,'scenes').includes('两人设计费用：0–30 元'));
  assert.ok(chapter(html,'scenes').includes('环境：室内、有遮蔽'));
  assert.ok(chapter(html,'scenes').includes('适用天气：晴天、雨天、天气待确认'));
  assert.ok(chapter(html,'activities').includes('两人设计费用：0–0 元'));
  assert.ok(chapter(html,'rules').includes('时期为考试季'));
});

test('独立阅读页保留未在当前范围及未允许公开规划的条目',()=>{
  const html = renderLibraryHTML({catalog:{scenes:[{id:'off_site',title:'范围外场景',description:'完整说明',publicAllowed:false,scauOnly:true,activities:[{id:'off_activity',title:'范围外活动'}]}],activities:[{id:'off_activity',title:'范围外活动',description:'活动说明',publicAllowed:false}]},sources:[],rules:[],evidence:[]});
  assert.ok(html.includes('范围外场景')); assert.ok(html.includes('活动说明'));
  assert.ok(!html.includes('off_site')); assert.ok(!html.includes('off_activity'));
});

test('所有用户文本转义，链接只允许已有 http/https，原文与机器字段不渲染',()=>{
  const dangerous = '<img src=x onerror="alert(1)">&\'"';
  const html = renderLibraryHTML({
    catalog:{rights:dangerous,disclaimer:dangerous,scenes:[{id:'private-id',title:dangerous,description:dangerous,place:{name:dangerous},activities:[],preparationIds:['secret']}],activities:[{id:'private-act',title:dangerous,description:dangerous}],departures:[{title:dangerous,description:dangerous,minutes:dangerous,cost:[dangerous,dangerous]}],graph:{nodes:[{id:'resource:secret',type:'resource',label:dangerous}]}},
    sources:[{id:'private-src',title:dangerous,category:dangerous,declaredRights:dangerous,path:'D:/secret/private.txt',sha256:'private-hash',originalExcerpt:'禁止输出原文',rawText:'禁止输出整篇',declaredUrls:['javascript:alert(1)','file:///D:/secret','data:text/html,x','/relative','https://example.org/?x="&y=1','http://example.com/']}],
    evidence:[{id:'private-evidence',sourceDocumentId:'private-src',summary:dangerous,verificationBoundary:dangerous}],
    rules:[{id:'private-rule',title:dangerous,then:[{action:'add_warning',message:dangerous}]}],
  });
  assert.ok(html.includes(esc(dangerous)));
  assert.ok(!html.includes('<img')); assert.ok(!html.includes('javascript:')); assert.ok(!html.includes('file:')); assert.ok(!html.includes('data:text'));
  assert.ok(html.includes('href="https://example.org/?x=%22&amp;y=1"'));
  assert.ok(html.includes('href="http://example.com/"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  for (const secret of ['private-id','private-act','private-src','private-evidence','private-rule','D:/secret','private-hash','禁止输出原文','禁止输出整篇']) assert.ok(!html.includes(secret),secret);
});

test('首次 render 懒生成，后续调用复用 DOM，纯函数不修改输入',()=>{
  let writes = 0, html = '';
  const container = {set innerHTML(value) { writes++; html=value; },get innerHTML() {return html;}};
  const before = JSON.stringify(data);
  const view = createLibraryView({container,...data});
  assert.equal(writes,0); assert.equal(view.render(),container); assert.equal(writes,1);
  assert.equal(view.render(),container); assert.equal(writes,1);
  assert.equal(JSON.stringify(data),before);
  assert.ok(html.includes('资料库'));
  assert.throws(()=>createLibraryView({}),TypeError);
  assert.equal(countEntries(renderLibraryHTML()),0);
});

test('区分周中周末费用，未知规则条件省略以避免伪解释',()=>{
  const html = renderLibraryHTML({catalog:{scenes:[{title:'场景',durationRange:[15,45],cost:[0,20],costByWeekPart:{weekday:[0,20],weekend:[5,30]},weather:['cloudy'],indoor:false}]},rules:[{title:'中文规则标题',when:{all:[{fact:'context.weather',op:'eq',value:'untranslated_weather'},{fact:'context.season',op:'eq',value:'exam'}]},then:[]}]});
  assert.ok(html.includes('两人设计费用：周中 0–20 元；周末 5–30 元'));
  assert.ok(html.includes('中文规则标题'));
  assert.ok(!html.includes('untranslated_weather'));
  assert.ok(!html.includes('未注明关联事项'));
  assert.ok(!chapter(html,'rules').includes('同时满足'));
  assert.ok(!chapter(html,'rules').includes('时期为考试季'));
});
