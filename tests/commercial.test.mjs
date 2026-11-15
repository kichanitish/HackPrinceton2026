import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {recommendProperties,findMatchCandidates} from '../worker/recommendations.mjs';
import {commercialPlanMatches} from '../worker/business.mjs';
const catalog=JSON.parse(await readFile(new URL('../data/commercial-catalog.json',import.meta.url)));
const profiles=JSON.parse(await readFile(new URL('../data/business-profiles.json',import.meta.url)));
const input={mode:'commercial',business:'cafe',city:'Houston',budget:4000,minSqft:800,maxSqft:2500,needs:'A coffee shop with food-service infrastructure'};
test('commercial data keeps photos, true source IDs, suites, asking-rate basis and scan scope',()=>{
 assert.equal(catalog.stats.spaces,3949);assert.equal(catalog.stats.properties,561);assert.ok(catalog.stats.withPhotos>550);
 for(const p of catalog.properties){assert.equal(p.mode,'commercial');assert.equal(p.id,-p.sourceId);assert.ok(p.lat&&p.lng);
  for(const plan of p.plans){if(plan.rentMin!==null)assert.ok(Math.abs(plan.rentMin-plan.annualRateMin*plan.sqftMin/12)<.01);for(const t of plan.tours)assert.ok(['Suite','Building','Unverified space'].includes(t.scope))}
 }
});
test('commercial search enforces intended use, area, monthly base budget, floor and known kitchen claims',async()=>{
 const result=await recommendProperties(catalog.properties,input,{businessProfiles:profiles,runAgent:async({tools})=>{
  const analyzed=await tools.analyze_preferences({scope:'housing',mode:'commercial',issue:'none',filters:{business:'cafe',priority:'business'},location:{}});assert.equal(analyzed.status,'ready');
  const found=await tools.search_properties({});const unique=found.matches.filter((m,i,all)=>all.findIndex(x=>x.propertyId===m.propertyId)===i).slice(0,3);assert.ok(unique.length>0);
  await tools.finish_shortlist({selections:unique.map(m=>({propertyId:m.propertyId,planId:m.planId,strengthKeys:['rent','use'],tradeoffKey:'business'}))});
 }});
 assert.ok(result.matches.length>0);for(const match of result.matches){const p=catalog.properties.find(p=>p.id===match.propertyId),plan=p.plans.find(x=>x.id===match.planId);assert.ok(profiles.cafe.uses.includes(plan.use));assert.ok(plan.sqftMin>=800&&plan.sqftMin<=2500);assert.ok(plan.rentMin<=4000);assert.match(match.strengths[0],/estimated base rent/)}
 assert.equal(commercialPlanMatches({}, {features:['kitchen_infrastructure'],notes:'No kitchen installed',use:'Retail'}, {kitchen:true}),false);
 assert.equal(commercialPlanMatches({}, {features:[],notes:'',isGround:false}, {groundFloor:true}),false);
});
test('business requests from home mode ask before switching and unknown rent cannot satisfy a budget',async()=>{
 const mode=await recommendProperties(catalog.properties,{city:'Houston',needs:'A cafe'},{runAgent:async({tools})=>tools.analyze_preferences({scope:'housing',mode:'commercial',filters:{},location:{}})});assert.equal(mode.status,'clarification');assert.equal(mode.actions[0].kind,'mode');
 const sample=catalog.properties.find(p=>p.plans.some(plan=>plan.rentMin===null));assert.ok(sample);const criteria={mode:'commercial',city:sample.city,budget:3000,beds:null,baths:null};
 assert.ok(findMatchCandidates([sample],criteria).every(row=>row.plan.rentMin>0));
});
