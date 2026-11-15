import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMatchInput,matchCriteria,findMatchCandidates,recommendProperties as runRecommendations} from '../worker/recommendations.mjs';
const recommendProperties=(properties,input,options)=>runRecommendations(properties,input,{...options,runAgent:async context=>{await context.tools.analyze_preferences({scope:'housing',issue:'none',filters:{},location:{}});return options.runAgent(context)}});
const plan=(id,values={})=>({id,name:'Layout '+id,beds:2,baths:2,rentMin:1500,rentMax:1800,sqftMin:900,available:1,tours:[{id:'scan'+id}],...values});
const property=(id,values={})=>({id,name:'Building '+id,city:'Houston',pets:[{type:'Dog',rent:20}],parking:[{type:'Garage'}],plans:[plan(id)],...values});
const properties=[property(1),property(2),property(3),property(4,{city:'Los Angeles'}),property(5,{noPets:true}),property(6,{plans:[plan(6,{rentMin:2500})]})];
const input={city:'Houston',budget:2000,beds:2,baths:2,dogs:true,needs:'Space for two desks'};
const pick=row=>({propertyId:row.propertyId,planId:row.planId,strengthKeys:['rent','area'],tradeoffKey:'space'});
test('explicit requirements cannot be relaxed by the model or filled with unknown values',()=>{
 const normalized=normalizeMatchInput(input),criteria=matchCriteria(normalized,{budget:5000,beds:1,baths:1,dogs:false});
 assert.equal(criteria.budget,2000);assert.equal(criteria.beds,2);assert.equal(criteria.baths,2);assert.equal(criteria.dogs,true);
 assert.deepEqual(findMatchCandidates(properties,criteria).map(r=>r.property.id),[1,2,3]);
 const missing=property(1,{plans:[plan(1,{baths:null})]});assert.deepEqual(findMatchCandidates([missing],criteria),[]);
 assert.throws(()=>normalizeMatchInput({...input,budget:'2000'}));assert.throws(()=>normalizeMatchInput({...input,needs:'x'.repeat(701)}));
});
test('agent uses catalog tools and verified scan facts; model prose never becomes a visible claim',async()=>{
 const loadScan=async()=>({ok:true,model:{rooms:[{label:'Bedroom',dimensions:{units:'imperial',width:12,depth:10}},{label:'void',dimensions:{units:'imperial',areaFloorIndoor:20}}]}});
 const result=await recommendProperties(properties,input,{loadScan,runAgent:async({tools})=>{
  const search=await tools.search_properties({});assert.equal(search.matches.length,3);
  const evidence=await tools.inspect_scan_data({selections:search.matches.map(pick)});assert.equal(evidence[0].measuredRooms,1);
  await tools.finish_shortlist({selections:search.matches.map(m=>({...pick(m),strengthKeys:['invented','scan'],reason:'Perfect fit, guaranteed!'}))});
 }});
 assert.equal(result.matches.length,3);assert.deepEqual(result.matches[0].strengths,['1 room has scan measurements']);
 assert.equal(result.matches[0].tradeoff,'Furniture fit is unverified; check room dimensions, doors and clearances.');
 assert.ok(!JSON.stringify(result).includes('guaranteed'));
});
test('failed measurements remain unknown and fewer matches never cause requirements to relax',async()=>{
 const result=await recommendProperties([properties[0]],input,{loadScan:async()=>{throw Error('private upstream message')},runAgent:async({tools})=>{
  const found=await tools.search_properties({});await tools.inspect_scan_data({selections:found.matches.map(pick)});
  await tools.finish_shortlist({selections:found.matches.map(m=>({...pick(m),strengthKeys:['scan'],tradeoffKey:'scan'}))});
 }});
 assert.equal(result.matches.length,1);assert.match(result.matches[0].strengths[0],/starting rent/);assert.match(result.matches[0].tradeoff,/could not be verified/);
});
test('out-of-catalog selections, duplicate buildings and incomplete agent output are rejected',async()=>{
 for(const selections of [[{propertyId:99,planId:99}],[pick({propertyId:1,planId:1}),pick({propertyId:1,planId:1})]]){
  await assert.rejects(recommendProperties(properties,input,{runAgent:async({tools})=>{await tools.search_properties({});await tools.finish_shortlist({selections})}}));
 }
 await assert.rejects(recommendProperties(properties,input,{runAgent:async()=>{}}),/incomplete/);
});
test('zero qualifying properties returns an empty result and no recommendation',async()=>{
 const result=await recommendProperties(properties,{...input,budget:200},{runAgent:async({tools})=>{const found=await tools.search_properties({budget:5000});assert.equal(found.matches.length,0);await tools.finish_shortlist({selections:[]})}});
 assert.deepEqual(result.matches,[]);
});
test('searches and scan checks are bounded and space priority considers larger eligible layouts',async()=>{
 const rows=[property(1),property(2,{plans:[plan(2,{sqftMin:1400,rentMin:1900})]})];
 assert.equal(findMatchCandidates(rows,matchCriteria(input,{priority:'space'}))[0].property.id,2);
 await assert.rejects(recommendProperties(properties,input,{runAgent:async({tools})=>{await tools.search_properties({});await tools.search_properties({});await tools.search_properties({})}}),/limit/);
});

test('a second agent search cannot relax requirements extracted in its first search',async()=>{
 const result=await recommendProperties(properties,{city:'Houston',needs:'under $2,000 with a dog'},{runAgent:async({tools})=>{
  await tools.search_properties({budget:2000,dogs:true});const second=await tools.search_properties({budget:5000,dogs:false});
  assert.equal(second.criteria.budget,2000);assert.equal(second.criteria.dogs,true);assert.ok(!second.matches.some(m=>m.propertyId===5||m.propertyId===6));
  await tools.finish_shortlist({selections:second.matches.map(pick)});
 }});assert.equal(result.matches.length,3);
});

test('debug events expose tool activity and evidence summaries without logging free-text needs or model thoughts',async()=>{
 const events=[];
 await recommendProperties(properties,{...input,needs:'private free-text notes'},{onEvent:(event,data)=>events.push({event,data}),runAgent:async({tools})=>{
  const found=await tools.search_properties({});await tools.inspect_scan_data({selections:found.matches.map(pick)});await tools.finish_shortlist({selections:found.matches.map(pick)});
 }});
 assert.deepEqual(events.map(x=>x.event),['preferences.analyzed','search.completed','scans.completed','selection.completed']);
 assert.equal(events[1].data.candidateLayouts,3);assert.equal(events[3].data.selections.length,3);assert.match(events[3].data.selections[0].strengths[0],/starting rent/);
 assert.ok(!JSON.stringify(events).includes('private free-text notes'));
});
