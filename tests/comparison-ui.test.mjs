import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const html=await readFile(new URL('../HomeFit.html',import.meta.url),'utf8');
const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/\ninit\(\);\s*$/,'');
const fixture={id:1,name:'One-property regression',address:'Test street',city:'Houston',state:'TX',zip:'00000',pets:[],parking:[],style:'Garden',plans:[{id:10,name:'A1',beds:1,baths:1,rentMin:1000,rentMax:1100,sqftMin:700,sqftMax:700,available:1,tours:[{id:'scan',scope:'Floor plan'}]}]};
function render(count,commercial=false){
 const nodes=new Map();
 const element=()=>({value:'',hidden:false,disabled:false,textContent:'',innerHTML:'',dataset:{},classList:{toggle(){}},addEventListener(){},querySelectorAll(){return []},querySelector(){return element()},setAttribute(){}});
 const document={getElementById(id){if(!nodes.has(id))nodes.set(id,element());return nodes.get(id)},addEventListener(){},querySelectorAll(){return []},querySelector(){return element()}};
 const context=vm.createContext({document,window:{addEventListener(){}},fixture,count,commercial,URL,setTimeout,clearTimeout});
 vm.runInContext(script,context);
 vm.runInContext("propertyMap.set(1,commercial?{...fixture,mode:'commercial',plans:[{...fixture.plans[0],name:'Suite A',use:'Retail',floorLabel:'Ground floor',annualRateMin:18,serviceType:'TripleNet',tours:[]}]}:fixture);propertyMap.set(2,{...fixture,id:2,name:'Second property'});selected=count===0?[]:[{propertyId:1,planId:10}];if(count===2)selected.push({propertyId:2,planId:10});renderCompareLive=()=>{};renderComparison();renderTray();",context);
 return nodes;
}
test('a single shortlisted property renders facts, actions and export instead of the empty state',()=>{
 const nodes=render(1),content=nodes.get('comparisonContent').innerHTML;
 assert.ok(content.includes(fixture.name));assert.ok(content.includes('ASKING RENT'));assert.ok(content.includes('3D tour'));assert.ok(!content.includes('data-furnish'));assert.ok(!content.includes('STILL TO VERIFY'));assert.ok(content.includes('Available floor plans'));assert.ok(content.includes('View details for '+fixture.name));assert.ok(content.includes('class="comparison-table one"'));
 assert.ok(!content.includes('Lowest starting rent'));assert.ok(!content.includes('Your shortlist is ready to begin'));
 assert.equal(nodes.get('exportButton').hidden,false);assert.equal(nodes.get('compareButton').disabled,false);
 assert.equal(nodes.get('comparisonHeading').textContent,'Your shortlist.');
});
test('only an empty shortlist gets the empty page',()=>{
 const nodes=render(0);assert.ok(nodes.get('comparisonContent').innerHTML.includes('Your shortlist is ready to begin'));
 assert.equal(nodes.get('exportButton').hidden,true);assert.equal(nodes.get('compareButton').disabled,true);
});
test('two selected properties keep the side-by-side comparison and pricing observations',()=>{
 const nodes=render(2),content=nodes.get('comparisonContent').innerHTML;
 assert.ok(content.includes(fixture.name));assert.ok(content.includes('Second property'));assert.ok(content.includes('class="comparison-table two"'));assert.ok(content.includes('Lowest starting rent'));
});
test('a commercial shortlist preserves missing scans and shows estimated rent and lease basis',()=>{
 const nodes=render(1,true),content=nodes.get('comparisonContent').innerHTML;
 assert.ok(content.includes('Suite A'));assert.ok(content.includes('3D scan not provided'));assert.ok(!content.includes('Furnish in 3D'));
 assert.ok(content.includes('/mo est.'));assert.ok(content.includes('LEASE BASIS'));assert.ok(content.includes('Triple Net'));
 assert.ok(nodes.get('comparisonSubtitle').textContent.includes('selected space'));
});
test('mixed home and business shortlists retain photos, distinct lease terms and shared details actions',()=>{
 const content=render(2,true).get('comparisonContent').innerHTML;
 assert.ok(content.includes('Second property'));assert.ok(content.includes('Whole apartment · monthly asking rent'));
 assert.ok(content.includes('View details for'));assert.ok(content.includes('Available spaces'));assert.ok(content.includes('Available floor plans'));
});
