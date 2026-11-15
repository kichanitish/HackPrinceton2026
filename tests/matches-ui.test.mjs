import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const html=await readFile(new URL('../HomeFit.html',import.meta.url),'utf8');
const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/\ninit\(\);\s*$/,'');
function setup(){
 const nodes=new Map(),storage=new Map();
 const element=()=>({children:[],append(node){this.children.push(node)},replaceChildren(){this.children=[]},value:'',checked:false,hidden:false,disabled:false,textContent:'',innerHTML:'',dataset:{},events:{},classList:{toggle(){}},addEventListener(type,fn){this.events[type]=fn},querySelectorAll(){return []},querySelector(){return element()},setAttribute(){},showModal(){this.open=true},close(){this.open=false;this.events.close?.()}});
 const document={createElement:element,getElementById(id){if(!nodes.has(id))nodes.set(id,element());return nodes.get(id)},addEventListener(){},querySelector(){return element()},querySelectorAll(){return []}};
 const context=vm.createContext({document,window:{addEventListener(){},scrollTo(){}},localStorage:{setItem(k,v){storage.set(k,v)},getItem(k){return storage.get(k)},removeItem(k){storage.delete(k)}},URL,setTimeout,clearTimeout,AbortController});
 vm.runInContext(script,context);
 vm.runInContext(`properties=[1,2,3,4].map(id=>({id,name:'Property '+id,address:'Street',city:'Houston',state:'TX',pets:[],parking:[],style:'Garden',plans:[{id:id*10,name:'A1',beds:2,baths:2,rentMin:1500,sqftMin:900,available:1,tours:[{id:'scan'+id,scope:'Floor plan'}]}]}));properties.forEach(p=>propertyMap.set(p.id,p));selected=[{propertyId:1,planId:10}];preferred={1:10};config={recommendationsConfigured:true};renderCompareLive=()=>{};updateURL=()=>{};`,context);
 const result={ok:true,criteria:{city:'Houston',budget:2000,beds:2,baths:2,dogs:false},matches:[2,3,4].map(id=>({propertyId:id,planId:id*10,plan:'A1',rentMin:1500,strengths:['Within your budget'],tradeoff:'Fees need confirmation.'}))};
 context.result=result;return {context,nodes,storage,run:code=>vm.runInContext(code,context)};
}
test('successful matches open the shared shortlist automatically; Undo restores the manual list',async()=>{
 const ui=setup();ui.context.fetch=async()=>({ok:true,json:async()=>ui.context.result});
 await ui.run('findPersonalMatches({preventDefault(){}})');
 assert.equal(ui.run('selected.length'),3);assert.equal(ui.run('selected[0].propertyId'),2);assert.equal(ui.run('currentView'),'comparison');
 assert.equal(ui.nodes.get('homeExample').disabled,false);assert.equal(ui.nodes.get('businessExample').disabled,false);
 assert.match(ui.nodes.get('comparisonContent').innerHTML,/Agent summary/);assert.doesNotMatch(ui.nodes.get('comparisonContent').innerHTML,/Best match for you/);
 assert.equal((ui.nodes.get('comparisonContent').innerHTML.match(/Agent summary/g)||[]).length,3);
 ui.run('undoPersonalMatches()');assert.equal(ui.run('selected.length'),1);assert.equal(ui.run('selected[0].propertyId'),1);assert.doesNotMatch(ui.nodes.get('comparisonContent').innerHTML,/Agent summary/);
});
test('manual edits remove only the changed layout summary while other recommended plans retain theirs',()=>{
 const ui=setup();ui.run('matchDraft=result;applyPersonalMatches();selected[0].planId=999;renderComparison()');
 assert.equal((ui.nodes.get('comparisonContent').innerHTML.match(/Agent summary/g)||[]).length,2);
 assert.equal(ui.run('activeMatchRecommendation().matches.length'),2);
 ui.run('selected=[{propertyId:1,planId:10},{propertyId:3,planId:30}];renderComparison()');
 assert.equal((ui.nodes.get('comparisonContent').innerHTML.match(/Agent summary/g)||[]).length,1);
});
test('saved summaries omit generic distance and pricing caveats while preserving specific tradeoffs',()=>{
 const ui=setup();ui.run("result.matches[0].tradeoff='Straight-line distance; driving miles and traffic are not verified. Mandatory fees and exact unit pricing still need confirmation.';matchDraft=result;applyPersonalMatches()");
 const html=ui.nodes.get('comparisonContent').innerHTML;
 assert.ok(!html.includes('driving miles'));assert.ok(!html.includes('Mandatory fees'));assert.ok(!html.includes('<li></li>'));
});
test('no matches preserves the current shortlist and keeps the inline search available',async()=>{
 const ui=setup();ui.context.fetch=async()=>({ok:true,json:async()=>({...ui.context.result,matches:[]})});
 await ui.run('findPersonalMatches({preventDefault(){}})');assert.equal(ui.run('selected[0].propertyId'),1);assert.match(ui.nodes.get('matchStatus').textContent,/No properties matched/);
});
test('model failure never changes the existing shortlist and offers an understandable retry',async()=>{
 const ui=setup();ui.context.fetch=async()=>({ok:false,json:async()=>({ok:false,code:'unavailable'})});
 await ui.run('findPersonalMatches({preventDefault(){}})');assert.equal(ui.run('selected[0].propertyId'),1);assert.match(ui.nodes.get('matchStatus').textContent,/shortlist hasn’t changed/);assert.equal(ui.nodes.get('matchSubmit').disabled,false);
});
test('cancelling a pending inline search aborts it and discards a late response',async()=>{
 const ui=setup();let complete;ui.context.fetch=()=>new Promise(resolve=>{complete=resolve});
 const pending=ui.run('findPersonalMatches({preventDefault(){}})');ui.run('cancelPersonalMatches()');complete({ok:true,json:async()=>ui.context.result});await pending;
 assert.equal(ui.run('matchDraft'),null);assert.equal(ui.run('selected[0].propertyId'),1);
});
test('the needs bar uses the description without inheriting hidden browsing constraints',async()=>{
 const ui=setup();let body;ui.context.fetch=async(url,options)=>{body=JSON.parse(options.body);return {ok:true,json:async()=>ui.context.result}};
 ui.run("$('purpose').value='commercial';$('city').value='Houston';$('budget').value='1000';$('beds').value='3';$('businessType').value='clinic';$('matchNeeds').value='A coffee shop under $4000';");
 await ui.run('startNeedsSearch({preventDefault(){}})');
 assert.equal(body.mode,'commercial');assert.equal(body.needs,'A coffee shop under $4000');assert.equal(body.budget,null);assert.equal(body.business,null);assert.equal(body.beds,null);
});
test('empty text never starts a model request',async()=>{
 const ui=setup();let called=false;ui.context.fetch=async()=>{called=true};
 await ui.run('startNeedsSearch({preventDefault(){}})');assert.equal(called,false);assert.match(ui.nodes.get('matchStatus').textContent,/Tell us/);
});
test('switching purpose keeps a separate needs draft and relevant example for each mode',()=>{
 const ui=setup();ui.run("$('city').value='Los Angeles';updateNeedsMode('home');$('matchNeeds').value='Two bedrooms';updateNeedsMode('commercial')");
 assert.equal(ui.nodes.get('matchNeeds').value,'');assert.equal(ui.nodes.get('homeExample').hidden,true);assert.match(ui.nodes.get('businessExample').textContent,/Los Angeles/);
 ui.run("$('matchNeeds').value='A coffee shop';updateNeedsMode('home')");assert.equal(ui.nodes.get('matchNeeds').value,'Two bedrooms');
 ui.run("updateNeedsMode('commercial')");assert.equal(ui.nodes.get('matchNeeds').value,'A coffee shop');
});

test('scope and clarification replies preserve the shortlist and show no recommendation summaries',async()=>{
 const ui=setup();ui.context.fetch=async()=>({ok:true,json:async()=>({ok:true,status:'out_of_scope',message:'That request is outside HomeFit’s apartment-search service.',matches:[]})});
 await ui.run('findPersonalMatches({preventDefault(){}})');assert.equal(ui.run('selected[0].propertyId'),1);assert.match(ui.nodes.get('matchStatus').textContent,/outside/);assert.equal(ui.run('matchDraft'),null);
});
test('a wider radius is used only after its suggestion is clicked',async()=>{
 const ui=setup();const bodies=[];
 ui.context.fetch=async(url,options)=>{bodies.push(JSON.parse(options.body));return {ok:true,json:async()=>bodies.length===1?{ok:true,status:'no_matches',message:'No nearby results. Expand?',actions:[{kind:'radius',label:'Try 23 miles',radiusOverride:23,locationChoiceId:'landmark:lax'}],matches:[]}:ui.context.result}};
 await ui.run('findPersonalMatches({preventDefault(){}})');assert.equal(bodies.length,1);assert.equal(ui.run('selected[0].propertyId'),1);
 await ui.nodes.get('matchFollowups').children[0].onclick();assert.equal(bodies.length,2);assert.equal(bodies[1].radiusOverride,23);assert.equal(bodies[1].locationChoiceId,'landmark:lax');assert.equal(ui.run('selected[0].propertyId'),2);
});
