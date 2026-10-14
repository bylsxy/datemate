#!/usr/bin/env node
// 保存知识库时同步资源修订标记，手动发布后能读取新数据；不执行任何 Git 操作。
import {readFile,writeFile,rename,realpath,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,dirname,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const hash=text=>createHash('sha256').update(text).digest('hex');
const imports=/^(\s*(?:import\s+[^;]+?\s+from|export\s+\{[^}]+\}\s+from)\s*)(['"])(\.{1,2}\/[^'"\r\n]+)\2/gm;
const workerURL=/(new\s+URL\(\s*)(['"])(\.\/worker\.mjs(?:\?[^'"]*)?)\2/g;
const entryURL=/((?:src|href)=)(['"])(\.\/(?:app\.mjs|styles\.css)(?:\?[^'"]*)?)\2/g;
function versioned(specifier,revision){
  const [path,query='']=specifier.split('?'),params=new URLSearchParams(query);
  params.delete('v');if(revision)params.set('v',revision);
  const tail=params.toString();return path+(tail?'?'+tail:'');
}
function rewriteModule(text,revision,isApp=false){
  const result=text.replace(imports,(match,prefix,quote,spec)=>/\.(?:mjs|js)(?:\?|$)/.test(spec)?`${prefix}${quote}${versioned(spec,revision)}${quote}`:match);
  return isApp?result.replace(workerURL,(_,prefix,quote,spec)=>`${prefix}${quote}${versioned(spec,revision)}${quote}`):result;
}
function rewriteEntry(text,revision){return text.replace(entryURL,(_,prefix,quote,spec)=>`${prefix}${quote}${versioned(spec,revision)}${quote}`);}

async function snapshotAssets(projectRoot){
  const root=await realpath(resolve(projectRoot)),sources=new Map();
  async function read(path){
    const actual=await realpath(path),part=relative(root,actual);
    if(part.startsWith('..')||part=== '')throw Error('资源路径超出项目目录。');
    if(!sources.has(actual))sources.set(actual,await readFile(actual,'utf8'));
    return sources.get(actual);
  }
  async function visit(path){
    const actual=await realpath(path);if(sources.has(actual))return;
    const text=await read(actual);
    for(const match of text.matchAll(new RegExp(imports.source,imports.flags))){
      const spec=match[3].split('?')[0];
      if(/\.(?:mjs|js)$/.test(spec))await visit(resolve(dirname(actual),spec));
    }
  }
  await visit(resolve(root,'app.mjs'));await visit(resolve(root,'worker.mjs'));
  for(const name of ['index.html','styles.css','favicon.svg'])await read(resolve(root,name));
  return {root,sources};
}

export async function collectRuntimeAssets(projectRoot){
  const {root,sources}=await snapshotAssets(projectRoot);
  return [...sources.keys()].map(path=>relative(root,path).split(sep).join('/')).sort();
}

export async function refreshAssetVersions(projectRoot){
  const {root,sources}=await snapshotAssets(projectRoot);
  const ordered=[...sources].sort(([a],[b])=>a.localeCompare(b));
  const normalized=ordered.map(([path,text])=>{
    const name=relative(root,path).split(sep).join('/');
    return name+'\n'+(name==='index.html'?rewriteEntry(text,null):/\.(?:mjs|js)$/.test(path)?rewriteModule(text,null,name==='app.mjs'):text);
  }).join('\n\0\n');
  const revision=hash(normalized).slice(0,16),changed=[];
  // 其他任务编辑了业务源码时停止，不覆盖它们刚写入的内容。
  for(const [path,text]of sources)if(await readFile(path,'utf8')!==text)throw Error('构建期间源码变化，请重新保存。');
  for(const [path,text]of ordered){
    const next=path===resolve(root,'index.html')?rewriteEntry(text,revision):/\.(?:mjs|js)$/.test(path)?rewriteModule(text,revision,path===resolve(root,'app.mjs')):text;
    if(next===text)continue;
    if(await readFile(path,'utf8')!==text)throw Error('构建期间源码变化，请重新保存。');
    const temp=path+'.asset-'+randomUUID()+'.tmp';
    try{await writeFile(temp,next,'utf8');await rename(temp,path);}finally{await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    changed.push(relative(root,path).split(sep).join('/'));
  }
  return {revision,changed};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  refreshAssetVersions(root).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
