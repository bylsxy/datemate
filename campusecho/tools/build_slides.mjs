import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// 幻灯片仅消费冻结研究产物。--final 必须存在经核对的 slide-data.json。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'artifacts/slides');
const SKILL = 'D:/DotConfig/.codex/plugins/cache/openai-primary-runtime/presentations/26.1026.10807/skills/presentations';
const RUNTIME = 'C:/Users/徐阳/.cache/codex-runtimes/codex-primary-runtime/dependencies';
const NODE_MODULES = path.join(RUNTIME, 'node/node_modules');
const PYTHON = path.join(RUNTIME, 'python/python.exe');
process.env.RUNTIME_NODE_MODULES = NODE_MODULES;
process.env.PYTHONUTF8 = '1';
process.env.PYTHONIOENCODING = 'utf-8';
const req = createRequire(path.join(NODE_MODULES, '__campusecho__.cjs'));
const { Presentation, PresentationFile, FileBlob } = await import(pathToFileURL(req.resolve('@oai/artifact-tool')).href);
const { finalizePresentation, applyPresentationChartFont } = await import(pathToFileURL(path.join(SKILL, 'container_tools/artifact_tool_utils.mjs')).href);
const FINAL = process.argv.includes('--final');
const VALIDATE = process.argv.includes('--validate-draft');
const REUSE = process.argv.includes('--render-only');
const STAMP = new Date().toISOString().replace(/[-:.TZ]/g, '');
const BUILD = path.join(DIR, 'build', STAMP);
const FONT = 'Microsoft YaHei';
const C = { ink:'#173044', muted:'#60717D', teal:'#007F86', rose:'#CB6279', light:'#FAFAF6', grid:'#DEE5E7', pale:'#F6EEEC', white:'#FFFFFF' };
const S = { width:1280, height:720 };
const outName = 'CampusEcho_课堂报告二';
const delivery = path.resolve(ROOT, '../课程交付材料');
const hash = x => createHash('sha256').update(x).digest('hex');
const load = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const loadDeck = async filename => {
  const proto=await load(filename);
  // JSON无法原样携带Uint8Array，回读时恢复图像二进制，防止渲染成占位图。
  for(const image of proto.images||[]) if(image.data && !ArrayBuffer.isView(image.data)) image.data=Uint8Array.from(Object.values(image.data));
  return Presentation.load(proto);
};
const writeBlob = async (p,b) => fs.writeFile(p, new Uint8Array(await b.arrayBuffer()));
// 本机 Skia 在成功渲染后仍以127退出。隔离原生渲染器，主进程逐文件验收后继续。
if (process.argv.includes('--render-worker')) {
  const arg = key => process.argv[process.argv.indexOf(key)+1];
  const input=arg('--source'), output=arg('--output');
  const deck=process.argv.includes('--pptx-source')
    ? await PresentationFile.importPptx(await FileBlob.load(input))
    : await loadDeck(input);
  await fs.mkdir(output,{recursive:true});
  const rendered=[];
  for(const [i,slide] of deck.slides.items.entries()) {
    const stem=`slide-${String(i+1).padStart(2,'0')}`;
    await writeBlob(path.join(output,stem+'.png'),await deck.export({slide,format:'png',scale:1.5}));
    await fs.writeFile(path.join(output,stem+'.layout.json'),await (await slide.export({format:'layout'})).text());
    rendered.push(stem+'.png');
  }
  await fs.writeFile(path.join(output,'render-complete.json'),JSON.stringify({input,rendered,width:1920,height:1080},null,2));
  console.log(`Completed ${rendered.length} artifact-tool renders`);
  process.exit(0);
}
const sharp=req('sharp');
async function renderDeck(input, output, pptx=false) {
  const r=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--render-worker','--source',input,'--output',output,...(pptx?['--pptx-source']:[])],{encoding:'utf8',windowsHide:true,timeout:120000,env:process.env});
  await fs.mkdir(output,{recursive:true});
  await fs.writeFile(path.join(output,'worker-log.txt'),`${r.stdout||''}\n${r.stderr||''}`);
  const knownWindowsTeardown=process.platform==='win32' && [127,0xC0000409].includes(r.status);
  if(r.error || (r.status!==0 && !knownWindowsTeardown)) throw new Error(`Render worker failed: ${r.error||r.stderr||r.status}`);
  const receipt=await load(path.join(output,'render-complete.json'));
  if(receipt.input!==input || receipt.rendered.length!==7) throw new Error('渲染完成凭据与输入不符');
  for(const filename of receipt.rendered) {
    const png=path.join(output,filename), metadata=await sharp(png).metadata();
    if(metadata.width!==1920 || metadata.height!==1080) throw new Error(`渲染尺寸错误：${filename}`);
    await sharp(png).raw().toBuffer();
  }
  await fs.writeFile(path.join(output,'render-validation.json'),JSON.stringify({status:'passed',slides:7,worker_exit:r.status,native_teardown_after_complete:knownWindowsTeardown,png_decode_verified:true,width:1920,height:1080},null,2));
  console.log(`Validated 7 rendered PNGs, worker exit ${r.status}`);
}
await fs.mkdir(BUILD, {recursive:true});
await fs.mkdir(path.join(DIR,'final'), {recursive:true});
await fs.mkdir(delivery, {recursive:true});

const CONTRACT = {
  schema_version:1,
  instructions:'所有数字由正式 summary.json / frozen_protocol.json / 原始CSV核对。禁止填写 smoke 数据。source_sha256 锁定研究结果。finalize前不满足契约则报错。',
  source_sha256:'summary.json 的 SHA256',
  experiment:{label:'受控仿真', sample_label:'实际轨迹和快照数量', split_label:'实际训练/验证/测试划分'},
  rules:{title:'实测规则结论',subtitle:'实际规模、重复次数与统计口径',categories:['实测类别'],series:[{name:'方法',values:[]}],unit:'实际单位',takeaway:'有证据的结论',source:'原始CSV及计算说明'},
  noise:{title:'实测概率结论',subtitle:'实际样本量和噪声条件',categories:['实测条件'],series:[{name:'方法',values:[]}],unit:'accuracy',takeaway:'有证据的收益或局限',source:'原始CSV及计算说明'},
  dynamic:{title:'实测行动结论',subtitle:'实际任务样本量和任务完成定义',columns:['策略','完成率','代价'],rows:[],takeaway:'有证据的结论',source:'原始CSV及计算说明'},
  conclusion:{benefit:'已测收益',limit:'实测适用边界',next:'报告三承接'},
};
await fs.writeFile(path.join(DIR,'slide-data.contract.json'), JSON.stringify(CONTRACT,null,2));
if(process.argv.includes('--prepare-data')) {
  const bytes=await fs.readFile(path.join(ROOT,'artifacts/research/summary.json'));
  const s=JSON.parse(bytes.toString('utf8'));
  if(s.status!=='complete_formal_controlled_simulation') throw new Error('研究汇总尚未完成正式受控仿真。');
  const median=values=>{const a=[...values].sort((a,b)=>a-b);return a[Math.floor(a.length/2)];};
  const pct=x=>(x*100).toFixed(1)+'%';
  const sizes=['100','1000','10000'];
  const rr=s.rules.rows.filter(x=>x.experiment==='synthetic_facts');
  if(!s.rules.closure_equal_all) throw new Error('规则闭包核对未通过。');
  const elapsed=m=>sizes.map(size=>median(rr.filter(x=>x.method===m&&x.size===size).map(x=>x.elapsed_seconds))*1000);
  const noise=s.results.filter(x=>x.experiment==='noise');
  const conditions=[...new Set(noise.map(x=>x.condition))].sort((a,b)=>Number(a)-Number(b));
  const methodNames={bayes:'基础 Bayes',strong_bayes:'学习 Bayes',discount_ds:'折扣 D-S'};
  const nr=(m,c)=>noise.find(x=>x.method===m&&x.condition===c);
  const tail=conditions.at(-1);
  const prepared={
    schema_version:1,source_sha256:hash(bytes),
    experiment:{label:'受控仿真',sample_label:`${s.config.test_episodes}条测试轨迹，每轨迹${s.config.snapshots}快照`,split_label:`训练/验证/测试：${s.config.train_episodes}/${s.config.val_episodes}/${s.config.test_episodes}条轨迹`},
    rules:{
      title:'候选匹配减少，当前计时未获得加速',
      subtitle:`受控仿真，100/1,000/10,000条合成事实，各重复${s.rules.repeats}次，耗时中位数（ms）`,
      categories:['100 条事实','1,000 条事实','10,000 条事实'],
      series:[{name:'朴素求值',values:elapsed('naive')},{name:'索引与半朴素求值',values:elapsed('semi_naive')}],unit:'ms',
      takeaway:'万级事实：候选检查由 60,072 次降至 24 次，闭包一致',
      narration:`规则实验先核对事实闭包。万级事实下，候选检查由六万多次降到二十四次，但耗时中位数从${elapsed('naive')[2].toFixed(1)}毫秒增加到${elapsed('semi_naive')[2].toFixed(1)}毫秒。因此当前实现减少了匹配工作，索引维护等开销仍需要优化。`,
      source:`受控规则压力集，非校园实际规则规模。来源：artifacts/research/summary.json rules.rows、rule_metrics.csv、rule_raw.jsonl。图中取synthetic_facts，事实规模100/1000/10000，2条规则，各方法各重复3次，中位数elapsed_seconds乘1000转为ms。完整原始记录：${JSON.stringify(rr)}\n规则正确性：closure_equal_all=${s.rules.closure_equal_all}。少量计时不能给出稳定加速保证；万级优化版有一次约396.8ms离群值，图示中位数。理论：UC Berkeley CS294-260 Datalog, Semi-naive Evaluation, 2024-02-05: https://inst.eecs.berkeley.edu/~cs294-260/sp24/2024-02-05-datalog`,
    },
    noise:{
      title:'噪声增加时，位置识别仍然退化',
      subtitle:`受控仿真，每档${s.config.robustness_episodes}条轨迹/${s.config.robustness_episodes*s.config.snapshots}快照，全样本准确率`,
      categories:conditions.map(x=>`额外扰动 ${Math.round(Number(x)*100)}%`),
      series:Object.entries(methodNames).map(([m,name])=>({name,values:conditions.map(c=>nr(m,c).accuracy)})),
      unit:'accuracy',chart_type:'line',
      takeaway:`额外扰动 ${Math.round(Number(tail)*100)}%：学习 Bayes ${pct(nr('strong_bayes',tail).accuracy)}，基础 Bayes ${pct(nr('bayes',tail).accuracy)}`,
      narration:`概率方法接收同样的测试线索。每档使用一百五十条轨迹，随着额外噪声增加，各方法的准确率继续下降。扰动四成时，学习贝叶斯为${pct(nr('strong_bayes',tail).accuracy)}，基础贝叶斯为${pct(nr('bayes',tail).accuracy)}。训练学习没有消除噪声和分布变化的影响。`,
      source:`来源：artifacts/research/summary.json results，筛选experiment=noise；metrics.csv；predictions.jsonl。每条件${s.config.robustness_episodes}独立轨迹、${s.config.robustness_episodes*s.config.snapshots}快照，同轨迹成对扰动。训练/验证/测试轨迹为${s.config.train_episodes}/${s.config.val_episodes}/${s.config.test_episodes}，阈值在测试前冻结。额外扰动率表示对已有带噪线索进一步置换支持，0%仍含模拟器固有噪声。图示点估计，95%CI以episode为重采样单位，${s.config.bootstrap}次bootstrap。完整点值及CI：${JSON.stringify(noise.filter(x=>Object.keys(methodNames).includes(x.method)).map(x=>({method:x.method,condition:x.condition,accuracy:x.accuracy,ci95:x.accuracy_ci95,episodes:x.episodes,snapshots:x.snapshots})))}。方法准确率差异不据单个点值宣称统计显著。学习Bayes对应strong_bayes，使用来源、时间、上下文等共享元数据。`,
    },
    conclusion:{benefit:'角色可见线索、证明与来源记录贯通到行动校验',limit:'受控仿真中，规则计时未加速，位置判断仍受噪声影响',next:'报告三接入人物记忆、事件回调与剧情反馈',narration:'本期交付可运行的推理、来源记录与动作接口。实验也保留了规则计时和概率抗噪方面的局限。这些结论来自受控仿真。报告三将在现有接口上加入人物记忆与剧情反馈。谢谢大家。',source:'docs/theory_outline.md 的第279至285行创新、不足与报告三接口。实测结论来源为summary.json的rules与noise结果。'},
  };
  if(process.argv.includes('--include-dynamic')) {
    const q=s.dynamic;
    if(q.scenario!=='challenge' || /superseded/i.test(JSON.stringify(q.status||''))) throw new Error('动态任务结果未取得有效challenge版本。');
    const labels={rule:'规则行动',bayes:'基础 Bayes',strong_bayes:'学习 Bayes',hybrid:'阈值混合',active:'主动求证'};
    const chosen=q.summary.filter(x=>['rule','bayes','strong_bayes','hybrid','active'].includes(x.strategy));
    const diff=q.paired_success_differences.find(x=>x.strategy==='hybrid'&&x.reference==='active');
    const active=chosen.find(x=>x.strategy==='active'), hybrid=chosen.find(x=>x.strategy==='hybrid');
    prepared.dynamic={title:'主动求证减少无谓询问',subtitle:`受控仿真，challenge，每策略${s.config.dynamic_episodes}个成对初始世界`,columns:['策略','完成率','平均询问'],rows:chosen.map(x=>[labels[x.strategy],pct(x.success),x.queries.toFixed(2)+' 次']),takeaway:`相对阈值混合：完成率 +${Math.round(diff.success_difference*100)} 个百分点，95% CI [${Math.round(diff.success_difference_ci95[0]*100)}, ${Math.round(diff.success_difference_ci95[1]*100)}]`,limit:'与三种简单方法的差异区间均跨 0，未证普遍优于简单方法',narration:`动态任务让人物继续移动，每次询问消耗两分钟。主动求证把平均询问从${hybrid.queries.toFixed(2)}次降到${active.queries.toFixed(2)}次，完成率相对阈值混合提高三十五个百分点，配对区间为二十六到四十六。但它和三种简单方法的差异区间均跨零，尚未证实普遍优势。`,source:`正式动态场景challenge，${s.config.dynamic_episodes}个成对初始世界。来源：summary.json dynamic.summary、dynamic_metrics.csv、dynamic_raw.jsonl、dynamic_actions.jsonl。完成定义为任务status=success，改期单列。平均询问计所有episode，每次询问消耗2模拟分钟。表格为均值。混合策略指hybrid阈值询问，混合与求证指active价值求证。配对差为active减对照，episode bootstrap ${s.config.bootstrap}次。完整数值及95%CI：${JSON.stringify(q)}。mission截图只作机制教学展示。`};
  }
  await fs.writeFile(path.join(DIR,'slide-data.json'),JSON.stringify(prepared,null,2));
}
let d = null;
try { d = await load(path.join(DIR,'slide-data.json')); } catch(e) { if(FINAL) throw new Error('正式定稿缺少 artifacts/slides/slide-data.json，等待真实研究结果。',{cause:e}); }
if(FINAL) {
  const summaryBytes = await fs.readFile(path.join(ROOT,'artifacts/research/summary.json'));
  if(d.source_sha256 !== hash(summaryBytes)) throw new Error('slide-data.json 与当前 summary.json 哈希不符。');
  for(const key of ['experiment','rules','noise','dynamic','conclusion']) if(!d[key]) throw new Error(`缺少正式数据段 ${key}`);
  for(const key of ['rules','noise']) {
    if(!d[key].series?.length || !d[key].categories?.length) throw new Error(`${key} 图表数据为空`);
    for(const s of d[key].series) if(s.values.length!==d[key].categories.length || s.values.some(x=>!Number.isFinite(x))) throw new Error(`${key} 图表值非法`);
  }
  if(!d.dynamic.rows?.length) throw new Error('dynamic 表格为空');
}

const p = REUSE ? await loadDeck(path.join(DIR,'presentation.source.json')) : Presentation.create({slideSize:S});
const manifest=REUSE ? (await load(path.join(DIR,'narrative.json'))).slides : [];
function txt(slide, name, text, x,y,w,h, size=30, color=C.ink, bold=false, align='left') {
  const sh=slide.shapes.add({geometry:'textbox',name,position:{left:x,top:y,width:w,height:h},fill:'none',line:{fill:'none',width:0}});
  sh.text=text;
  sh.text.style={typeface:FONT,fontSize:size,color,bold,alignment:align,verticalAlignment:'top',autoFit:'none',wrap:'square',insets:0};
  return sh;
}
function page(title,n, opts={}) {
  const s=p.slides.add(); s.background.fill=opts.fill||C.light;
  txt(s,'slide-title',title,64,48,1152,110,44,C.ink,true);
  txt(s,'page-number',String(n).padStart(2,'0'),1160,657,58,28,19,C.muted,false,'right');
  return s;
}
function notes(s, narration, sources, seconds) {
  s.speakerNotes.text=`【讲述 ${seconds} 秒】\n${narration}\n\n【来源与口径】\n${sources}`;
  manifest.push({slide:manifest.length+1,seconds,narration,sources});
}
function table(s, name, values, x,y,w,h, widths, size=26) {
  const t=s.tables.add({rows:values.length,columns:values[0].length,left:x,top:y,width:w,height:h,columnWidths:widths,values});
  t.styleOptions={headerRow:false,bandedRows:false};
  t.borders.assign({fill:C.grid,width:0.8,style:'solid'});
  for(let r=0;r<values.length;r++) for(let c=0;c<values[0].length;c++) {
    const cell=t.getCell(r,c); cell.fill=r===0?C.ink:C.white;
    cell.text.style={typeface:FONT,fontSize:r===0?size-1:size,color:r===0?C.white:C.ink,bold:r===0,autoFit:'none',insets:{left:16,right:12,top:14,bottom:10}};
  }
  return t;
}
function chart(s, spec, x,y,w,h, kind='bar') {
  const isRate=spec.unit==='accuracy' || spec.unit==='rate';
  const ch=s.charts.add(kind,{
    position:{left:x,top:y,width:w,height:h},
    categories:spec.categories,
    // Excel工作簿以有限十进制保留图表精度，完整原始精度仍存于slide-data与备注。
    series:spec.series.map((a,i)=>({name:a.name,values:a.values.map(v=>Number(v.toFixed(isRate?6:3))),fill:[C.teal,C.rose,C.ink,'#9DB3B9'][i%4],line:{fill:[C.teal,C.rose,C.ink,'#9DB3B9'][i%4],width:3,style:'solid'},...(kind==='line'?{marker:{symbol:'circle',size:7}}:{})})),
    barOptions:{direction:'column',grouping:'clustered',gapWidth:110},
    hasLegend:spec.series.length>1,
    legend:{position:'bottom',overlay:false,textStyle:{fontSize:21,fill:C.ink}},
    xAxis:{textStyle:{fontSize:21,fill:C.ink},line:{fill:C.grid,width:1},majorGridlines:null},
    yAxis:{min:0,...(isRate?{max:1,majorUnit:0.2}:{}),numberFormatCode:isRate?'0%':'0',textStyle:{fontSize:20,fill:C.muted},majorGridlines:{fill:C.grid,width:1,style:'solid'},line:{fill:'none',width:0}},
    dataLabels:{showValue:kind!=='line',position:'outEnd',numberFormatCode:isRate?'0.0%':'0.0',textStyle:{fontSize:20,fill:C.ink}},
    chartFill:'none',chartLine:{fill:'none',width:0},plotAreaFill:'none',plotAreaLine:{fill:'none',width:0},
  });
  applyPresentationChartFont(ch,{fontFamily:FONT});
  return ch;
}
if(!REUSE) {
  // 1. 简短场景开场，题目与组别完整保留。
  {
    const s=p.slides.add();s.background.fill=C.pale;
    txt(s,'project-name','CampusEcho',64,51,1120,65,34,C.teal,true);
    txt(s,'formal-title','面向校园恋爱互动的\n可解释混合推理引擎设计与实现',64,152,1160,174,53,C.ink,true);
    txt(s,'scenario','约好的同学迟到了。\n一条消息说在图书馆，另一条说在社团室。',66,390,1120,112,32,C.ink);
    txt(s,'group','第91组    课堂报告二',66,604,920,42,25,C.muted);
    notes(s,'大家好，我们是第91组。假设约好的同学迟到了，旧照片说她在图书馆，同学却说她刚去社团室。我们希望角色能解释自己凭什么判断，也能在拿不准时先求证。这个问题就是 CampusEcho 报告二的起点。','虚构校园场景。正式题目与第91组由任务要求确定。机制线索来源：src/campusecho/world.py 的 mission / conflict 夹具。',21);
  }
  // 2. 人物信息隔离与角色实际收到的线索。
  {
    const s=page('人物信息隔离',2);
    txt(s,'role-boundary','角色依据自己收到的线索作判断',65,164,1150,54,34,C.teal,true);
    txt(s,'world-label','世界状态',65,272,290,42,28,C.muted,true);
    txt(s,'world-body','保存真实位置与日程\n评测时核对行动结果',65,329,530,97,32,C.ink);
    txt(s,'view-label','角色视图 AgentView',65,472,540,42,28,C.teal,true);
    txt(s,'view-body','已接收记录与当前同地观察\n每条线索保留来源和时间',65,526,545,100,30,C.ink);
    const src=path.join(ROOT,'artifacts/qa/mission-desktop.png');
    const crop=path.join(BUILD,'role-visible-clues.png');
    await sharp(src).extract({left:144,top:1028,width:760,height:301}).png().toFile(crop);
    const buf=await fs.readFile(crop);
    s.images.add({blob:buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength),contentType:'image/png',alt:'玩家实际收到的两条位置线索',fit:'contain',position:{left:640,top:284,width:576,height:278}});
    txt(s,'view-caption','玩家界面中的两条矛盾线索',640,573,576,36,23,C.muted);
    notes(s,'我们先隔离人物知道的信息。世界保存真实位置和日程，角色视图只提供已收到的消息与同地观察。右侧是实际玩家界面的两条线索，来源和时间不同。推理策略都读取这份视图，评测才读取真值。','代码：src/campusecho/world.py AgentView、observe；policy.py各策略只接收AgentView。截图：artifacts/qa/mission-desktop.png，裁取角色可见线索区域，保留原始内容。实际浏览器玩家模式初始任务。',20);
  }
  // 3. 三类推理的职责用可编辑原生表格呈现。
  {
    const s=page('三种推理的职责',3);
    txt(s,'same-input','三种方法接收相同的角色视图',65,169,1150,57,34,C.teal,true);
    table(s,'methods',[
      ['方法','回答的问题','可解释输出'],
      ['有限正 Horn','现在能证明什么？','事实与规则证明链'],
      ['贝叶斯推断','各地点有多大可能？','位置后验与似然贡献'],
      ['D-S 证据融合','线索有多少支持与冲突？','质量、冲突和 BetP'],
    ],64,258,1152,286,[300,450,402],28);
    txt(s,'action-boundary','合法动作执行器负责移动、询问与物品交付',65,584,1095,47,28,C.muted);
    notes(s,'三种推理分别回答不同问题。有限正 Horn 给出可证明的事实和规则链，贝叶斯更新各地点的概率，D-S 表达证据支持、未知和冲突。它们的输出继续交给动作执行器，检查移动、询问和交付是否合法。','代码：world.py 的 observe / AgentView，engine.py 的 analyze 与 campus_rules，logic.py，bayes.py，evidence.py。理论参考：docs/theory_outline.md 文献1、3、4、7、9。有限正Horn的可靠和完备边界限定为有限、无函数、正事实规则子集。BetP为行动比较概率，不能直接等同于贝叶斯后验。\nAbiteboul, Hull, Vianu (1995), Foundations of Databases, Ch.12: https://webdam.di.ens.fr/Alice/pdfs/Chapter-12.pdf\nPoole & Mackworth (2023), Artificial Intelligence 3e, §9.3/9.5: https://artint.info/3e/html/ArtInt3e.Ch9.S3.html ; https://artint.info/3e/html/ArtInt3e.Ch9.S5.html\nDenœux (2017), Introduction to belief functions: https://www.hds.utc.fr/~tdenoeux/dokuwiki/_media/en/lecture1.pdf\nSmets (2004), The Application of the Matrix Calculus to Belief Functions, §4: https://iridia.ulb.ac.be/~psmets/MatrixRepresentation.pdf',23);
  }
  // 4. 冲突处理与来源去重，机制夹具不作为研究样本。
  {
    const s=page('证据冲突与同源转述',4);
    txt(s,'duplicate-count','12 条消息，2 个起源',65,171,1150,67,42,C.teal,true);
    table(s,'duplicate-records',[
      ['可见记录','内容指向','共同起源'],
      ['1 条旧照片','图书馆','photo-1'],
      ['10 条转发','图书馆','photo-1'],
      ['1 条新报告','社团室','report-1'],
    ],64,260,1152,246,[400,350,402],28);
    txt(s,'duplicate-takeaway','同源记录先分组，再做概率更新与证据融合',65,544,1115,48,30,C.ink,true);
    txt(s,'conflict-boundary','D-S 冲突 K 接近 1 时，触发保留未知或继续求证',65,605,1115,43,26,C.muted);
    notes(s,'以同源转述夹具为例，旧照片和十条转发来自同一个起源，另有一条独立报告。十二条消息只对应两个起源，先分组再融合。对于不同来源的冲突，D-S 保留冲突和未知；标准合成在完全冲突时无定义，需要保留未知或求证。','机制演示，非正式实验统计。来源：src/campusecho/world.py scenario("duplicate")，旧照片1条、转发10条、独立报告1条。evidence.py / learned.py 按 origin_id 选取可用记录。消息计数12=1+10+1，独立起源为photo-1与report-1，共2个。完全冲突标准Dempster无定义，Yager将冲突分配给全集，混合策略可进一步求证。Denœux (2017), Introduction to belief functions: https://www.hds.utc.fr/~tdenoeux/dokuwiki/_media/en/lecture1.pdf',23);
  }
  // 5. 两幅原生可编辑科研图，分别保留规则与概率实验口径。
  {
    const r=d?.rules, n=d?.noise;
    const s=page('规则效率与概率抗噪的实测边界',5);
    txt(s,'rules-label','规则求值耗时（ms）',65,166,550,43,29,C.teal,true);
    txt(s,'noise-label','位置识别准确率',668,166,550,43,29,C.teal,true);
    txt(s,'rules-sample','合成事实，每档重复 3 次，取中位数',65,214,550,40,22,C.muted);
    txt(s,'noise-sample','每档 150 轨迹 / 450 快照，受控仿真',668,214,550,40,22,C.muted);
    if(r) chart(s,{...r,categories:['100 条','1,000 条','10,000 条'],series:r.series.map((x,i)=>({...x,name:i?'索引半朴素':'朴素'}))},55,266,562,276);
    if(n) chart(s,{...n,categories:['0%','10%','20%','30%','40%'],series:n.series.map((x,i)=>({...x,name:['Bayes','学习 Bayes','折扣 D-S'][i]}))},658,266,562,276,'line');
    txt(s,'rules-result','候选检查 60,072 次降至 24 次\n耗时 34.5 ms 增至 57.7 ms',65,563,555,81,26,C.ink,true);
    txt(s,'noise-result','40% 额外扰动：学习 Bayes 34.2%\n基础 Bayes 31.6%，仍明显退化',668,563,550,81,26,C.ink,true);
    notes(s,'规则实验中，两种求值的闭包一致。万级事实的候选检查从六万多次降到二十四次，但耗时从三十四点五增加到五十七点七毫秒，当前实现没有加速。右侧每档有一百五十条轨迹，额外噪声四成时，学习贝叶斯准确率只有百分之三十四点二，仍然明显退化。',`${r?.source||'规则正式数据缺席'}\n\n${n?.source||'噪声正式数据缺席'}\n图示为点估计，方法差异不据单个点值宣称统计显著。横轴为额外扰动率，0%仍含模拟器固有噪声。`,31);
  }
  // 6. 动态任务结果与正式UI截图。截图不替代可编辑数据。
  {
    const q=d?.dynamic;
    const s=page(q?.title||'动态任务：判断需要转化为合法行动',6);
    txt(s,'dynamic-subtitle',q?.subtitle||'受控仿真，任务完成率与行动代价等待正式结果',65,160,1150,56,26,C.muted);
    const screenshot=path.join(ROOT,'artifacts/qa/mission-success.png');
    let hasImage=false;
    try {
      const crop=path.join(BUILD,'mission-success-task.png');
      await sharp(screenshot).extract({left:925,top:600,width:460,height:410}).png().toFile(crop);
      const buf=await fs.readFile(crop);
      s.images.add({blob:buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength),contentType:'image/png',alt:'真实浏览器教学回放已完成任务，T+43',fit:'contain',position:{left:777,top:244,width:439,height:304}});
      txt(s,'screenshot-disclosure','教学回放成功，T+43，机制演示',760,217,456,28,21,C.muted);
      hasImage=true;
    } catch {}
    if(q) table(s,'dynamic-results',[q.columns,...q.rows],64,244,hasImage?650:1152,304,hasImage?[284,180,186]:[430,350,372],hasImage?25:28);
    else txt(s,'pending-dynamic-data','等待正式任务评测',65,315,hasImage?550:1140,100,38,C.teal,true);
    txt(s,'dynamic-takeaway',q?.takeaway||'询问消耗时间，人物会移动，交付需要实际会合',65,578,1150,43,28,C.ink,true);
    txt(s,'dynamic-limit',q?.limit||'正式动态结果待核对',65,629,1120,39,24,C.muted);
    notes(s,q?.narration||'动态任务中，人物继续按日程移动。求证会消耗时间，角色需要实际会合才能交付物品。我们据正式评测比较策略的完成率和行动代价。',`${q?.source||'正式数据入口：artifacts/research/summary.json 及动态任务原始CSV。当前草稿没有实验数值。'}\n截图：artifacts/qa/mission-success.png，由主会话真实浏览器六动作操作得到，T20至T43。裁取已完成任务区域，截图为机制展示，表格为正式challenge评测。`,29);
  }
  // 7. 结论用事实边界承接报告三。
  {
    const q=d?.conclusion;
    const s=page('报告二的边界与报告三的接口',7);
    txt(s,'benefit-label','本期验证',65,174,260,43,25,C.teal,true);
    txt(s,'benefit',q?.benefit||'角色知识隔离、证明轨迹与证据来源可追溯',65,230,1138,90,36,C.ink,true);
    txt(s,'limit-label','适用边界',65,359,260,42,25,C.rose,true);
    txt(s,'limit',q?.limit||'受控校园仿真，真实行为与消息分布仍需外部验证',65,412,1138,84,31,C.ink);
    txt(s,'next',q?.next||'报告三接入人物记忆、事件回调与剧情反馈',65,577,1138,60,32,C.teal,true);
    notes(s,q?.narration||'报告二交付可运行、可解释的推理与动作接口。结论适用于当前受控仿真，真实场景仍需要验证。报告三将在这些接口上加入人物记忆与剧情事件。谢谢大家。',q?.source||'来源：冻结后的正式实验结果，以及 docs/theory_outline.md 的创新、不足、报告三接口部分。受控仿真不代表真实校园效果。',15);
  }
  await fs.writeFile(path.join(DIR,'presentation.source.json'),JSON.stringify(p.toProto(),(_key,value)=>ArrayBuffer.isView(value)?Array.from(value):value));
  await fs.writeFile(path.join(DIR,'narrative.json'),JSON.stringify({title:'面向校园恋爱互动的可解释混合推理引擎设计与实现',group:'第91组',draft:!FINAL,total_seconds:manifest.reduce((a,b)=>a+b.seconds,0),slides:manifest},null,2));
  await fs.writeFile(path.join(DIR,'narration.txt'),manifest.map(x=>`[第${x.slide}页，${x.seconds}秒]\n${x.narration}`).join('\n\n'));
}

const mode=FINAL?'final':'draft';
const preview=path.join(BUILD,'png'); await fs.mkdir(preview,{recursive:true});
await renderDeck(path.join(DIR,'presentation.source.json'),preview);
const candidate=path.join(BUILD,`${outName}.${mode}.pptx`);
await (await PresentationFile.exportPptx(p)).save(candidate);
let pdfMode='artifact-tool-native';
try {
  await writeBlob(path.join(BUILD,`${outName}.pdf`),await p.export({format:'pdf'}));
} catch(error) {
  // 当前Windows bundle缺少PDF标准字体别名。用已检查的原始PNG合成等比例PDF。
  // 这里只封装现有页面，不使用Python绘制任何视觉元素。
  await fs.writeFile(path.join(BUILD,'native-pdf-error.txt'),error.stack||String(error));
  const code='import sys\nfrom pathlib import Path\nfrom reportlab.pdfgen import canvas\nfrom reportlab.lib.utils import ImageReader\nfrom pypdf import PdfReader\nroot=Path(sys.argv[1])\nout=Path(sys.argv[2])\nc=canvas.Canvas(str(out),pagesize=(960,540),pageCompression=1)\nc.setTitle("CampusEcho 课堂报告二")\nfor f in sorted(root.glob("slide-*.png")):\n c.drawImage(ImageReader(str(f)),0,0,width=960,height=540)\n c.showPage()\nc.save()\nassert len(PdfReader(out).pages)==7\nprint("PDF assembled from 7 rendered slide PNGs")\n';
  const run=spawnSync(PYTHON,['-c',code,preview,path.join(BUILD,`${outName}.pdf`)],{encoding:'utf8',windowsHide:true,timeout:60000,env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'}});
  if(run.status!==0) throw new Error(`PNG-PDF fallback failed: ${run.stderr||run.error}`);
  console.log(run.stdout.trim()); pdfMode='raster-derivative-1920x1080';
}
await fs.writeFile(path.join(DIR,'latest-build.json'),JSON.stringify({mode,build_dir:BUILD,png_dir:preview,candidate,pdf:path.join(BUILD,`${outName}.pdf`),pdf_mode:pdfMode,slides:p.slides.items.length},null,2));
if(FINAL || VALIDATE) {
  const finalPath=path.join(DIR,'final',`${outName}.${STAMP}.pptx`);
  const result=await finalizePresentation({
    workspaceDir:ROOT,candidatePath:candidate,finalPath,
    explicitTotalSlideCount:7,
    requiredNativeTableOwnerSlides:d?.dynamic?[3,4,6]:[3,4],requiredNativeChartOwnerSlides:d?.rules?[5]:[],
    materializeLiteralChartWorkbooks:true,
    pythonExecutable:PYTHON,
    integrityValidatorPath:path.join(SKILL,'container_tools/inspect_presentation_package_integrity.py'),
    layoutValidatorPath:path.join(SKILL,'container_tools/inspect_presentation_layout_geometry.py'),
    layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-bullet-geometry','--validate-heading-fit',...(d?.dynamic?[3,4,6]:[3,4]).flatMap(n=>['--require-native-table-slide',String(n)])],
    fontPolicy:{basis:'design',families:[FONT]},verifyArtifactToolImport:true,
    receiptPath:path.join(BUILD,'validation.json'),
  });
  if(!FINAL) {console.log(`Validated draft: ${finalPath}`);process.exitCode=0;}
  else {
  // 对定稿PPTX回读后渲染，供逐页QA直接检查交付文件。
  const roundtrip=path.join(BUILD,'final-import-png');await fs.mkdir(roundtrip,{recursive:true});
  await renderDeck(finalPath,roundtrip,true);
  await fs.copyFile(finalPath,path.join(delivery,`${outName}.pptx`));
  await fs.copyFile(path.join(BUILD,`${outName}.pdf`),path.join(delivery,`${outName}.pdf`));
  const finalPng=path.join(DIR,'png');await fs.mkdir(finalPng,{recursive:true});
  for(let i=1;i<=7;i++) await fs.copyFile(path.join(roundtrip,`slide-${String(i).padStart(2,'0')}.png`),path.join(finalPng,`slide-${String(i).padStart(2,'0')}.png`));
  await fs.writeFile(path.join(DIR,'video-scenes.json'),JSON.stringify({width:1920,height:1080,total_seconds:manifest.reduce((a,b)=>a+b.seconds,0),scenes:manifest.map(x=>({slide:x.slide,file:path.join(finalPng,`slide-${String(x.slide).padStart(2,'0')}.png`),duration_seconds:x.seconds,narration:x.narration}))},null,2));
  await fs.writeFile(path.join(DIR,'delivery.json'),JSON.stringify({pptx:path.join(delivery,`${outName}.pptx`),pdf:path.join(delivery,`${outName}.pdf`),pdf_mode:pdfMode,png_dir:finalPng,final_import_png_dir:roundtrip,finalized:finalPath,build_dir:BUILD,source_sha256:d.source_sha256,validation:result},null,2));
  console.log(`Delivered ${path.join(delivery,`${outName}.pptx`)}`);
  }
} else console.log(`Draft only: ${candidate}`);
// 原生渲染在独立worker完成，主进程只在逐页解码和全部交付完成后成功结束。
process.exit(0);
