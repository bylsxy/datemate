#!/usr/bin/env node
/** 用 Node 内置模块构建离线演示；每个 ES 模块保留独立 IIFE 作用域。 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Script, createContext } from 'node:vm';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(project, 'dist/DateMate_offline.html');
const delivery = resolve(project, '../课程交付材料/离线演示.html');
const snapshots = new Map();
const sha = value => createHash('sha256').update(value).digest('hex');
const idFor = path => relative(project, path).split(sep).join('/');

async function source(path) {
  if (!snapshots.has(path)) snapshots.set(path, await readFile(path, 'utf8'));
  return snapshots.get(path);
}

function resolveModule(importer, specifier) {
  if (!specifier.startsWith('.')) throw Error(`离线打包仅支持项目内静态依赖：${specifier}`);
  const path = resolve(dirname(importer), specifier);
  const rel = relative(project, path);
  if (rel.startsWith('..') || path === project || !path.endsWith('.mjs')) throw Error(`模块越界或格式不支持：${specifier}`);
  return path;
}

const importPattern = /^import\s+([^;]+?)\s+from\s+(['"])([^'"]+)\2\s*;[ \t]*$/gm;
const reexportPattern = /^export\s+\{([^}]+)\}\s+from\s+(['"])([^'"]+)\2\s*;[ \t]*$/gm;

function importBinding(clause, namespace) {
  const trimmed = clause.trim();
  if (/^\*\s+as\s+\w+$/.test(trimmed)) return `const ${trimmed.replace(/^\*\s+as\s+/, '')} = ${namespace};`;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const members = trimmed.slice(1, -1).split(',').map(x => x.trim()).filter(Boolean).map(x => {
      if (!/^[\w$]+(?:\s+as\s+[\w$]+)?$/.test(x)) throw Error(`不支持的导入成员：${x}`);
      return x.replace(/\s+as\s+/, ': ');
    });
    return `const { ${members.join(', ')} } = ${namespace};`;
  }
  if (/^[\w$]+$/.test(trimmed)) return `const ${trimmed} = ${namespace}.default;`;
  throw Error(`不支持的导入语法：${clause}`);
}

async function bundle(entry, workerUrl = false) {
  const ordered = [], visited = new Set(), visiting = new Set();
  async function visit(path) {
    if (visited.has(path)) return;
    if (visiting.has(path)) throw Error(`当前免依赖打包器不支持循环导入：${idFor(path)}`);
    visiting.add(path);
    const text = await source(path);
    for (const pattern of [importPattern, reexportPattern]) {
      for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) await visit(resolveModule(path, match[3]));
    }
    visiting.delete(path); visited.add(path); ordered.push(path);
  }
  await visit(entry);
  const chunks = ['const __modules = Object.create(null);'];
  for (const path of ordered) {
    const exported = new Map();
    let code = await source(path);
    code = code.replace(importPattern, (_, clause, quote, specifier) => importBinding(clause, `__modules[${JSON.stringify(idFor(resolveModule(path, specifier)))}]`));
    code = code.replace(reexportPattern, (_, list, quote, specifier) => {
      const namespace = `__modules[${JSON.stringify(idFor(resolveModule(path, specifier)))}]`;
      for (const member of list.split(',').map(x => x.trim()).filter(Boolean)) {
        const parts = member.split(/\s+as\s+/); exported.set(parts[1] || parts[0], `${namespace}[${JSON.stringify(parts[0])}]`);
      }
      return '';
    });
    code = code.replace(/^export\s+(async\s+)?(const|let|var|function|class)\s+([\w$]+)/gm, (_, asyncToken = '', declaration, name) => {
      exported.set(name, name); return `${asyncToken}${declaration} ${name}`;
    });
    code = code.replace(/^export\s+default\s+([\w$]+)\s*;?[ \t]*$/gm, (_, name) => { exported.set('default', name); return ''; });
    code = code.replace(/^export\s+\{([^}]+)\}\s*;?[ \t]*$/gm, (_, list) => {
      for (const member of list.split(',').map(x => x.trim()).filter(Boolean)) { const parts = member.split(/\s+as\s+/); exported.set(parts[1] || parts[0], parts[0]); }
      return '';
    });
    if (workerUrl && path === entry) {
      const workerReference = /new\s+URL\(\s*(['"])\.\/worker\.mjs\1\s*,\s*import\.meta\.url\s*\)/g;
      let replacements = 0;
      code = code.replace(workerReference, () => { replacements++; return '__offlineWorkerUrl'; });
      if (replacements !== 1) throw Error(`app Worker入口匹配数量为${replacements}，请核对源码后更新打包规则。`);
    }
    if (/^\s*(?:import|export)\s/m.test(code) || /\bimport\s*\(|\bimport\.meta\b/.test(code)) throw Error(`尚有未处理的模块语法：${idFor(path)}`);
    const properties = [...exported].map(([name, expression]) => `${JSON.stringify(name)}: ${expression}`).join(', ');
    chunks.push(`// 模块：${idFor(path)}\n__modules[${JSON.stringify(idFor(path))}] = (() => {\n${code}\nreturn Object.freeze({ ${properties} });\n})();`);
  }
  return { code: chunks.join('\n'), modules: ordered.map(idFor) };
}

async function main() {
  const worker = await bundle(resolve(project, 'worker.mjs'));
  const app = await bundle(resolve(project, 'app.mjs'), true);
  const workerCode = `(() => { "use strict";\n${worker.code}\n})();`;
  new Script(workerCode, { filename: 'DateMate_offline.worker.js' });
  const appCode = `(() => { "use strict";\nconst __offlineWorkerSource = ${JSON.stringify(workerCode)};\nconst __offlineWorkerUrl = URL.createObjectURL(new Blob([__offlineWorkerSource], { type: 'text/javascript' }));\nwindow.addEventListener('pagehide', () => URL.revokeObjectURL(__offlineWorkerUrl), { once: true });\n${app.code}\n})();`;
  new Script(appCode, { filename: 'DateMate_offline.app.js' });

  // 在独立 VM 中真正执行打包后的 Worker，验证规划、图谱和规则导入一致。
  const replies = [];
  const sandbox = { structuredClone, performance, console, self: { postMessage: value => replies.push(value) } };
  createContext(sandbox); new Script(workerCode).runInContext(sandbox, { timeout: 10000 });
  sandbox.self.onmessage({ data: { id: 1, state: { context: { duration: 180, budget: null, weather: 'rain', area: 'near', fatigueA: 6, fatigueB: 2, preparedIds: [], dietaryRestrictions: ['raw', 'spicy'], windows: [{ id: 'afternoon', startMinute: 840, endMinute: 1020 }], endAfterStage: 0, searchConfig: { maxStages: 1, beamWidth: 4, maxExpandedNodes: 500 } }, exploration: 0, prefix: [] } } });
  if (replies.length !== 1 || !replies[0].result?.ok) throw Error(`离线 Worker 实际规划失败：${JSON.stringify(replies[0])}`);
  const workerResult = replies[0].result;
  if (!workerResult.stages.length || workerResult.stages.some(s => s.tags.includes('outdoor'))) throw Error('离线 Worker 雨天候选检查失败。');
  if (!workerResult.trace.some(t => t.ruleId === 'R-fatigue-derive') || !workerResult.trace.some(t => t.ruleId === 'R-fatigue-rest')) throw Error('离线 Worker 未执行真实数据的疲惫规则链。');

  const htmlPath = resolve(project, 'index.html'), cssPath = resolve(project, 'styles.css');
  const htmlSource = await source(htmlPath), css = await source(cssPath);
  if (/@import|url\(/i.test(css)) throw Error('样式仍含外部依赖，需先提供内嵌资源。');
  const stylePattern = /<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']\.\/styles\.css(?:\?[^"']*)?["'][^>]*>/i;
  const scriptPattern = /<script\b[^>]*type=["']module["'][^>]*src=["']\.\/app\.mjs["'][^>]*>\s*<\/script>/i;
  if (!stylePattern.test(htmlSource) || !scriptPattern.test(htmlSource)) throw Error('入口HTML与打包契约不一致。');
  let html = htmlSource.replace(stylePattern, `<style>\n${css}\n</style>`).replace(scriptPattern, '').replace(/href=["']\.\/["'](?=\s+aria-label=["']DateMate 首页)/, 'href="#main-content"');
  if (html.includes('./favicon.svg')) {
    const icon = await source(resolve(project, 'favicon.svg'));
    html = html.replace('./favicon.svg', `data:image/svg+xml,${encodeURIComponent(icon)}`);
  }
  const escapedCode = appCode.replace(/<\/script/gi, '<\\/script');
  // 回调保留脚本中的$$与$&原文，避免replace的替换字符串语义改写标识符。
  html = html.replace(/<\/body>/i, () => `<script>\n${escapedCode}\n</script>\n</body>`);
  const embeddedScript = html.match(/<script>\n([\s\S]*)\n<\/script>/i)?.[1];
  if (!embeddedScript) throw Error('离线HTML缺少内嵌脚本。');
  new Script(embeddedScript, { filename: 'DateMate_offline.embedded.js' });
  if (/<script\b[^>]*\bsrc=|<link\b[^>]*\brel=["']stylesheet/i.test(html)) throw Error('打包结果仍依赖外部代码或样式。');
  // 写入之前确认整份构建快照未被其他分支并发修改。
  for (const [path, text] of snapshots) if (sha(await readFile(path, 'utf8')) !== sha(text)) throw Error(`构建期间源码变化，请重新运行：${idFor(path)}`);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(dirname(delivery), { recursive: true });
  await writeFile(output, html, 'utf8'); await writeFile(delivery, html, 'utf8');
  const report = { status: 'passed', output, delivery, bytes: Buffer.byteLength(html), sha256: sha(html), duplicateCopyIdentical: sha(await readFile(output)) === sha(await readFile(delivery)), appModules: app.modules, workerModules: worker.modules, sourceSha256: Object.fromEntries([...snapshots].map(([path, text]) => [idFor(path), sha(text)])), validation: { appSyntax: 'passed', workerSyntax: 'passed', bundledWorkerPlan: 'passed', bundledFatigueChain: 'passed', workerStages: workerResult.stages.map(s => s.sceneId), browserFileProtocol: 'not_tested' } };
  await writeFile(resolve(project, 'dist/offline-build-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
