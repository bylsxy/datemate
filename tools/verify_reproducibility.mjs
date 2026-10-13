import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const python = process.env.DATEMATE_PYTHON || 'python';
const files = ['catalog.json','catalog.mjs','activities.mjs','rules.json','graph.json','source-registry.json','evidence.json','conditions.json','extraction-report.json'];
const hashes = () => Object.fromEntries(files.map(name => [name, createHash('sha256').update(readFileSync(new URL(`../data/${name}`, import.meta.url))).digest('hex')]));
function rebuild() {
  const r = spawnSync(python, ['tools/build_knowledge.py'], {cwd:project, encoding:'utf8', timeout:60000, env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'}});
  if (r.status !== 0) throw Error(r.stderr || r.error?.message || '知识构建失败');
}
// 统一LF使Windows生成字节与GitHub发布字节一致，再比较两次完整构建。
rebuild(); const first=hashes(); rebuild(); const second=hashes();
if (JSON.stringify(first)!==JSON.stringify(second)) throw Error('两次知识构建的字节不一致');
writeFileSync(new URL('../data/reproducibility-report.json',import.meta.url),JSON.stringify({status:'passed',encoding:'UTF-8',lineEndings:'LF',filesChecked:files.length,byteIdentical:true,first,second},null,2)+'\n');
console.log('9个生成文件连续两次构建字节一致，UTF-8/LF。');
