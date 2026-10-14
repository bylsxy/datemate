import test from 'node:test';
import {CAMPING_EXPLORATION_MIN,isSceneAllowedAtExploration} from '../exploration.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {escapeHTML} from '../planner.mjs';

const decode=value=>value.replace(/&(?:amp|lt|gt|quot|#39);/g,entity=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[entity]));
// 解析实际渲染产生的嵌套 HTML；只替换轮播等无关依赖，不替换卡片模板。
class Element {
  constructor(doc,tag='div'){this.ownerDocument=doc;this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes={};this.className='';this.scrollLeft=0;this._text='';}
  get classList(){return {contains:name=>this.className.split(' ').includes(name),add:(...names)=>names.forEach(name=>this.classList.toggle(name,true)),remove:(...names)=>names.forEach(name=>this.classList.toggle(name,false)),toggle:(name,on)=>{const names=new Set(this.className.split(' ').filter(Boolean));on??=!names.has(name);if(on)names.add(name);else names.delete(name);this.className=[...names].join(' ');return on;}};}
  set innerHTML(html){
    for(const child of this.children)child.parentElement=null;
    this.children=[];this._text='';this._html=html;
    const stack=[this];
    for(const token of html.match(/<[^>]+>|[^<]+/g)||[]){
      if(token.startsWith('</')){stack.pop();continue;}
      if(!token.startsWith('<')){stack.at(-1)._text+=decode(token);continue;}
      const tag=token.match(/^<([\w-]+)/)?.[1];if(!tag)continue;
      const el=new Element(this.ownerDocument,tag);
      for(const [,name,value]of token.matchAll(/([\w-]+)="([^"]*)"/g)){
        const decoded=decode(value);el.setAttribute(name,decoded);
        if(name==='class')el.className=decoded;
        if(name==='title')el.title=decoded;
        if(name.startsWith('data-'))el.dataset[name.slice(5)]=decoded;
      }
      if(tag==='input')el.checked=/\schecked(?:\s|>)/.test(token);
      stack.at(-1).append(el);
      if(!['input','br','hr'].includes(tag))stack.push(el);
    }
  }
  get innerHTML(){return this._html||'';}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  append(el){this.insertBefore(el,null);}
  insertBefore(el,before){if(el===before)return;el.remove();this.children.splice(before?this.children.indexOf(before):this.children.length,0,el);el.parentElement=this;}
  remove(){if(this.parentElement){const siblings=this.parentElement.children;siblings.splice(siblings.indexOf(this),1);this.parentElement=null;}}
  contains(el){return el===this||this.children.some(child=>child.contains(el));}
  matches(selector){return selector.startsWith('.')?this.classList.contains(selector.slice(1)):selector==='input'&&this.tagName==='INPUT';}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  setAttribute(name,value){this.attributes[name]=String(value);}
  removeAttribute(name){delete this.attributes[name];}
  addEventListener(){}
  removeEventListener(){}
  getBoundingClientRect(){return {left:0,right:320,top:0,bottom:100,width:320,height:100};}
}

test('全部地点卡和活动卡直接渲染 description 全文，旧摘要不覆盖，更新与空值安全',async()=>{
  const long='自定义的第一句说明超过三十二字，必须完整展示所有内容并方便直接手工修改。第二句包含额外提醒；第三句结尾不能丢失。';
  assert.ok(long.length>32);
  const activity={id:'walk',title:'散步',group:'活动',description:`活动：${long}<带水> & "慢走"`,cardDescription:'旧活动摘要'};
  const scenes=[
    {id:'park',title:'公园',description:long,cardDescription:'旧地点摘要',activities:[activity]},
    {id:'restaurant',title:'餐馆',description:`餐馆：${long}`,cardDescription:'旧餐馆摘要',mealRoles:['breakfast'],activities:[{id:'eat',title:'早餐',group:'用餐',description:`用餐：${long}`,mealRoles:['breakfast']}]},
    {id:'rest',title:'休息',kind:'rest',description:`休息：${long}`,activities:[]},
    ...['',null,undefined].map((description,index)=>({id:`empty-${index}`,title:'空说明',description,cardDescription:'空值也不能回退摘要',activities:[]}))
  ];
  const catalog={scenes,departures:[{id:'hotel',title:'酒店',description:`酒店：${long}`,cardDescription:'旧酒店摘要'}]};
  const win={requestAnimationFrame:()=>1,cancelAnimationFrame(){},setTimeout:()=>1,clearTimeout(){},addEventListener(){},removeEventListener(){},innerWidth:320,innerHeight:500};
  const doc={defaultView:win,documentElement:{clientWidth:320,clientHeight:500},createElement:tag=>new Element(doc,tag),activeElement:null};
  const root=new Element(doc);doc.querySelector=()=>root;
  const key=Symbol.for('datemate.card.description.test'),oldDocument=globalThis.document;
  globalThis.document=doc;
  globalThis[key]={isSceneAllowedAtExploration,attachCarousel:()=>({update(){},destroy(){}}),centerCard(){},syncCarousel(){},esc:escapeHTML,formatTime:String,toggleActivity(){},isSceneInSchoolScope:()=>true};
  let timeline;
  try{
    const source=(await readFile(new URL('../timeline.mjs',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
    const {createTimeline}=await import(`data:text/javascript;base64,${Buffer.from(`const CAMPING_EXPLORATION_MIN=${CAMPING_EXPLORATION_MIN}; const {isSceneAllowedAtExploration,attachCarousel,centerCard,syncCarousel,esc,formatTime,toggleActivity,isSceneInSchoolScope}=globalThis[Symbol.for('datemate.card.description.test')];\n${source}`).toString('base64')}`);
    timeline=createTimeline({catalog,getIntent:()=>({prefix:[],context:{}})});
    const candidate=sceneId=>({sceneId,fitScore:70,scoreStatus:'evaluated'});
    const render=()=>timeline.render({ok:true,stages:[
      {sceneId:'park',activityIds:['walk'],startMinute:600,endMinute:660,candidates:scenes.map(scene=>candidate(scene.id))},
      {sceneId:'restaurant',activityIds:['eat'],mealRole:'breakfast',startMinute:660,endMinute:690,candidates:[candidate('restaurant')]}
    ],departure:{id:'hotel',startMinute:690,endMinute:705,candidates:[{id:'hotel'}]}});
    const check=()=>{
      for(const scene of [...scenes,...catalog.departures]){
        const cards=root.querySelectorAll('.scene-card').filter(card=>card.dataset.scene===scene.id);
        assert.ok(cards.length,scene.id);
        for(const card of cards)assert.equal(card.querySelector('.scene-desc').textContent,scene.description??'');
      }
      const activities=root.querySelectorAll('.activity-card');
      assert.equal(activities.length,2);
      for(const [index,expected]of [activity,scenes[1].activities[0]].entries()){
        const card=activities[index];
        assert.equal(card.querySelector('.activity-title').textContent,expected.title);
        assert.equal(card.querySelector('.activity-desc').textContent,expected.description??'');
        assert.equal(card.title,expected.description??'');
        assert.equal(card.querySelector('input').checked,true);
        assert.ok(card.classList.contains('selected'));
        assert.equal(card.querySelector('.activity-title').parentElement,card.querySelector('.activity-desc').parentElement);
      }
    };
    render();check();
    for(const scene of scenes.slice(0,3))scene.description=`手改更新：${scene.description}。新增最后一句`;
    activity.description=`活动手改更新：${long}。新增末尾`;
    render();check();
    for(const empty of ['',null,undefined]){activity.description=empty;scenes[1].activities[0].description=empty;render();check();}
    timeline.render({ok:true,stages:[],mealRequirements:[{mealRole:'breakfast',choiceMode:'before_meeting',targetMinute:540},{mealRole:'supper',choiceMode:'skip',targetMinute:1200}]});
    assert.deepEqual(root.querySelectorAll('.scene-desc').map(el=>el.textContent),['见面前各自吃好早餐，见面后直接开始。']);
  }finally{timeline?.dispose();globalThis.document=oldDocument;delete globalThis[key];}
});
