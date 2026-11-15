import test from 'node:test';
import assert from 'node:assert/strict';
import {recommendProperties} from '../worker/recommendations.mjs';
import {completeMatchRanking,compactMatchCandidates} from '../worker/rank-matches.mjs';
const properties=[1,2,3,4,5].map(id=>({id,name:'Building '+id,city:'Los Angeles',lat:33.95,lng:-118.4,pets:[],parking:[],plans:[{id:id*10,name:'Layout',rentMin:2000+id*100,rentMax:2900,beds:0,baths:1,sqftMin:700+id*100,available:1,tours:[{id:'scan'+id}]}]}));
properties.push({...properties[0],id:9,lat:35,plans:[{...properties[0].plans[0],id:90,sqftMin:5000}]});
const input={city:'Los Angeles',budget:3000,beds:0,needs:'I work from home, within 10 miles of LAX'};
async function run(invokeSelection,events=[]){return recommendProperties(properties,input,{onEvent:(event,data)=>events.push({event,data}),runAgent:async({input,tools})=>{
 const analyzed=await tools.analyze_preferences({scope:'housing',issue:'none',filters:{priority:'space'},location:{query:'LAX',radiusMiles:10,mode:'straight_line'}});
 await completeMatchRanking({tools,input,criteria:analyzed.criteria,invokeSelection,onEvent:(event,data)=>events.push({event,data})});
}})}
test('the reported no-tool-call failure still returns the top three validated space matches',async()=>{
 const events=[];const result=await run(async()=>{throw Object.assign(new Error('Output exhausted'),{matchFailure:'length'})},events);
 assert.equal(result.selectionMethod,'validated_filters');assert.deepEqual(result.matches.map(m=>m.propertyId),[5,4,3]);assert.ok(!result.matches.some(m=>m.propertyId===9));
 assert.ok(result.matches.every(m=>m.rentMin<=3000));assert.ok(result.matches.every(m=>/straight-line/.test(m.strengths[0])));assert.match(result.matches[0].tradeoff,/Furniture fit is unverified/);
 assert.equal(events.find(x=>x.event==='selection.fallback').data.reason,'length');
});
test('ranking timeouts and invalid IDs use a fallback; validated model selections still work',async()=>{
 const timeout=await run(async()=>{throw Object.assign(new Error('Timeout'),{matchFailure:'ranking_timeout'})});assert.equal(timeout.matches.length,3);
 const invalid=await run(async()=>({selections:[{propertyId:999,planId:999,strengthKeys:['rent'],tradeoffKey:'fees'}]}));assert.deepEqual(invalid.matches.map(m=>m.propertyId),[5,4,3]);
 const model=await run(async({candidates})=>({selections:[...candidates].reverse().slice(0,3).map(row=>({propertyId:row.propertyId,planId:row.planId,strengthKeys:['area'],tradeoffKey:'space'}))}));assert.equal(model.selectionMethod,'model');assert.equal(model.matches.length,3);
});
test('compact context removes repeated prose and duplicate buildings while retaining numerical facts',()=>{
 const rows=Array.from({length:24},(_,index)=>({propertyId:Math.floor(index/2),planId:index,name:'Building',rentMin:1000,beds:1,baths:1,area:900,evidence:{fit:{rent:'x'.repeat(300),area:'y'.repeat(300)},tradeoffs:{fees:'z'.repeat(300)}}}));
 const compact=compactMatchCandidates(rows);assert.equal(compact.length,12);assert.equal(new Set(compact.map(x=>x.propertyId)).size,12);assert.equal(compact[0].rent,1000);assert.ok(JSON.stringify(compact).length<JSON.stringify(rows).length/4);
});
test('cancelled requests do not apply the fallback',async()=>{
 const controller=new AbortController();let finished=false;
 const tools={search_properties:async()=>({matches:[1,2,3,4].map(id=>({propertyId:id,planId:id,evidence:{fit:{rent:'Rent'},tradeoffs:{fees:'Fees'}}}))}),inspect_scan_data:async()=>[],finish_shortlist:async()=>{finished=true}};
 await assert.rejects(completeMatchRanking({tools,input,criteria:{priority:'rent'},signal:controller.signal,invokeSelection:async()=>{controller.abort();throw Error('Cancelled')}}));assert.equal(finished,false);
});
