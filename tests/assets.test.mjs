import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {collectRuntimeAssets,refreshAssetVersions} from '../tools/refresh_assets.mjs';

test('保存知识后资源版本改变，重复构建保持幂等且保留其它查询参数',async()=>{
  const root=await mkdtemp(join(tmpdir(),'datemate-assets-'));
  try{
    await mkdir(join(root,'data'));
    await writeFile(join(root,'app.mjs'),"import {data} from './data/catalog.mjs?v=old&mode=local';\nnew Worker(new URL('./worker.mjs?v=old',import.meta.url));\n");
    await writeFile(join(root,'worker.mjs'),"import {data} from './data/catalog.mjs?v=old';\n");
    await writeFile(join(root,'data/catalog.mjs'),'export const data={title:"原地点"};\n');
    await writeFile(join(root,'index.html'),'<link href="./styles.css?v=old"><script src="./app.mjs?v=old"></script>');
    await writeFile(join(root,'styles.css'),'body{color:red}');await writeFile(join(root,'favicon.svg'),'<svg/>');
    const first=await refreshAssetVersions(root),again=await refreshAssetVersions(root);
    assert.equal(first.revision,again.revision);assert.deepEqual(again.changed,[]);
    assert.match(await readFile(join(root,'app.mjs'),'utf8'),/mode=local/);
    assert.equal(await readFile(join(root,'data/catalog.mjs'),'utf8'),'export const data={title:"原地点"};\n');
    await writeFile(join(root,'data/catalog.mjs'),'export const data={title:"新地点"};\n');
    const updated=await refreshAssetVersions(root);assert.notEqual(updated.revision,first.revision);
    assert.ok((await collectRuntimeAssets(root)).includes('data/catalog.mjs'));
    assert.match(await readFile(join(root,'index.html'),'utf8'),new RegExp(updated.revision));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('资源收集拒绝跟随项目外模块，不改变实际文件',async()=>{
  const root=await mkdtemp(join(tmpdir(),'datemate-assets-boundary-'));
  try{
    await mkdir(join(root,'project'));
    await writeFile(join(root,'outside.mjs'),'export const secret=1;');
    await writeFile(join(root,'project/app.mjs'),"import {secret} from '../outside.mjs';\n");
    await assert.rejects(collectRuntimeAssets(join(root,'project')),/超出/);
    assert.equal(await readFile(join(root,'outside.mjs'),'utf8'),'export const secret=1;');
  }finally{await rm(root,{recursive:true,force:true});}
});
