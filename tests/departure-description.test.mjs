import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// 最小 DOM 只承接渲染；卡片内容仍由实际 timeline 代码生成。
class Element {
  constructor(doc){this.ownerDocument=doc;this.children=[];this.dataset={};this.className='';this.attributes={};this.scrollLeft=0;}
  get classList(){return {contains:name=>this.className.split(' ').includes(name),add:(...names)=>names.forEach(name=>this.classList.toggle(name,true)),remove:(...names)=>names.forEach(name=>this.classList.toggle(name,false)),toggle:(name,on)=>{const names=new Set(this.className.split(' ').filter(Boolean));on??=!names.has(name);if(on)names.add(name);else names.delete(name);this.className=[...names].join(' ');return on;}};}
  set innerHTML(html){this._html=html;this.children=[];for(const cls of html.includes('class="transfer-bar"')?['transfer-bar','stage-heading','scene-strip','stage-activities','stage-meta']:html.includes('class="scene-score"')?['scene-score','scene-title','scene-desc']:[]){const el=new Element(this.ownerDocument);el.className=cls;this.append(el);}}
  get innerHTML(){return this._html||'';}
  append(el){this.insertBefore(el,null);}
  insertBefore(el,before){if(el===before)return;el.remove();this.children.splice(before?this.children.indexOf(before):this.children.length,0,el);el.parentElement=this;}
  remove(){if(this.parentElement){const siblings=this.parentElement.children;siblings.splice(siblings.indexOf(this),1);this.parentElement=null;}}
  contains(el){return el===this||this.children.some(child=>child.contains(el));}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(child.classList.contains(selector.slice(1))?[child]:[]),...child.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  setAttribute(name,value){this.attributes[name]=String(value);}
  removeAttribute(name){delete this.attributes[name];}
  addEventListener(){}
  removeEventListener(){}
  getBoundingClientRect(){return {left:0,right:500,top:0,bottom:100,width:500,height:100};}
}

test('四种别离卡使用目录全文，酒店提醒和露营文案不截断，更新时不回退到硬编码',async()=>{
  const catalog=JSON.parse(await readFile(new URL('../data/catalog.json',import.meta.url),'utf8'));
  const knowledge=JSON.parse(await readFile(new URL('../knowledge/departures.json',import.meta.url),'utf8'));
  const descriptions=departures=>Object.fromEntries(departures.map(({id,description})=>[id,description]));
  assert.deepEqual(descriptions(catalog.departures),descriptions(knowledge.departures));
  assert.deepEqual(catalog.departures.map(({id})=>id),['camping','hotel','separate','walk_together']);
  const oldDocument=globalThis.document,dependencyKey=Symbol.for('datemate.departure.description.test');
  const win={requestAnimationFrame:()=>1,cancelAnimationFrame(){},setTimeout:()=>1,clearTimeout(){},addEventListener(){},removeEventListener(){},innerWidth:500,innerHeight:500};
  const doc={defaultView:win,documentElement:{clientWidth:500,clientHeight:500},createElement:()=>new Element(doc),activeElement:null};
  const root=new Element(doc);doc.querySelector=()=>root;
  globalThis.document=doc;
  globalThis[dependencyKey]={attachCarousel:()=>({update(){},destroy(){}}),centerCard(){},syncCarousel(){},esc:value=>value,formatTime:String,toggleActivity(){},isSceneInSchoolScope:()=>true};
  let timeline;
  try{
    const source=(await readFile(new URL('../timeline.mjs',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
    const {createTimeline}=await import(`data:text/javascript;base64,${Buffer.from(`const {attachCarousel,centerCard,syncCarousel,esc,formatTime,toggleActivity,isSceneInSchoolScope}=globalThis[Symbol.for('datemate.departure.description.test')];\n${source}`).toString('base64')}`);
    timeline=createTimeline({catalog,getIntent:()=>({prefix:[],context:{}}),onDeparture(){}});
    const render=()=>timeline.render({ok:true,stages:[],departure:{id:'hotel',startMinute:1200,endMinute:1215,candidates:catalog.departures.map(({id})=>({id}))}});
    const check=()=>{
      const cards=root.querySelector('.scene-strip').children;
      assert.equal(cards.length,catalog.departures.length);
      for(const departure of catalog.departures){
        const card=cards.find(card=>card.dataset.departure===departure.id);
        assert.equal(card.querySelector('.scene-title').textContent,departure.title);
        assert.equal(card.querySelector('.scene-desc').textContent,departure.description);
        if(departure.description)assert.equal(card.title.split('\n')[0],departure.description);
      }
    };
    render();check();
    assert.match(root.querySelector('.scene-strip').children.find(card=>card.dataset.departure==='hotel').querySelector('.scene-desc').textContent,/忌电竞酒店$/);
    assert.equal(root.querySelector('.scene-strip').children.find(card=>card.dataset.departure==='camping').querySelector('.scene-desc').textContent,knowledge.departures.find(({id})=>id==='camping').description);
    // 注入新目录文案和摘要字段，证明更新始终使用 description 唯一内容源。
    for(const departure of catalog.departures){departure.description=`更新：${departure.description}。补充提醒`;departure.cardDescription='不应使用的摘要';}
    render();check();
    catalog.departures[0].description='';render();check();
  }finally{timeline?.dispose();globalThis.document=oldDocument;delete globalThis[dependencyKey];}
});
