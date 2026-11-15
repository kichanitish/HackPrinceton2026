import test from 'node:test';
import assert from 'node:assert/strict';
import {recommendProperties,normalizeMatchInput} from '../worker/recommendations.mjs';
import {distanceMiles,resolveMatchPlace,supportedCityForPlace} from '../worker/places.mjs';
const input={city:'Los Angeles',budget:2000,beds:1,baths:1,needs:'Within 20 miles of LAX'};
const analysis=(values={})=>({scope:'housing',issue:'none',filters:{},location:{query:'LAX',radiusMiles:20,mode:'straight_line'},...values});
const property=(id,lat,lng,zip='90001')=>({id,name:'Property '+id,city:'Los Angeles',lat,lng,zip,pets:[],parking:[],plans:[{id:id*10,name:'A1',rentMin:1500,rentMax:1700,beds:1,baths:1,sqftMin:800,available:1,tours:[{id:'scan'+id}]}]});
const properties=[property(1,33.95,-118.4),property(2,34.0,-118.3),property(3,34.25,-118.1),property(4,null,null),property(5,33.94,-118.41)];
const selections=matches=>matches.filter((m,i,all)=>all.findIndex(x=>x.propertyId===m.propertyId)===i).slice(0,3).map(m=>({propertyId:m.propertyId,planId:m.planId,strengthKeys:['rent'],tradeoffKey:'fees'}));
test('description-first search adopts an explicitly requested city while retaining hard requirements',async()=>{
 const result=await recommendProperties(properties,{...input,city:'Houston',descriptionFirst:true,needs:'An apartment in Los Angeles under $2000'},{runAgent:async({tools})=>{
  const a=await tools.analyze_preferences(analysis({filters:{city:'Los Angeles'},location:{}}));assert.equal(a.status,'ready');
  const found=await tools.search_properties({city:'Houston'});assert.ok(found.matches.length);await tools.finish_shortlist({selections:selections(found.matches)});
 }});
 assert.equal(result.criteria.city,'Los Angeles');assert.ok(result.matches.every(m=>m.rentMin<=2000));
});
test('description-first landmark search adopts the verified landmark city without guessing a radius',async()=>{
 const result=await recommendProperties(properties,{...input,city:'Houston',descriptionFirst:true},{runAgent:async({tools})=>{
  const a=await tools.analyze_preferences(analysis());assert.equal(a.status,'ready');
  const found=await tools.search_properties({});await tools.finish_shortlist({selections:selections(found.matches)});
 }});
 assert.equal(result.criteria.city,'Los Angeles');assert.equal(result.criteria.radiusMiles,20);
});
test('radius checks use listing coordinates, not broad ZIP matches or model-provided locations',async()=>{
 const result=await recommendProperties(properties,input,{runAgent:async({tools})=>{
  const a=await tools.analyze_preferences(analysis());assert.equal(a.status,'ready');
  const found=await tools.search_properties({});assert.deepEqual(found.matches.map(m=>m.propertyId).sort(),[1,2,5]);await tools.finish_shortlist({selections:selections(found.matches)});
 }});
 assert.equal(result.matches.length,3);assert.match(result.matches[0].strengths[0],/mi from.*straight-line/);assert.equal(result.matches[0].tradeoff,'');
 for(const m of result.matches)assert.ok(distanceMiles(properties.find(p=>p.id===m.propertyId),result.criteria.location)<=20);
});
test('scope analysis is mandatory and off-topic requests never invoke search or change selections',async()=>{
 await assert.rejects(recommendProperties(properties,input,{runAgent:async({tools})=>tools.search_properties({})}),/analysis_required/);
 let invoked=false;const obvious=await recommendProperties(properties,{...input,needs:'Write a poem about apartments'},{runAgent:async()=>{invoked=true}});assert.equal(obvious.status,'out_of_scope');assert.equal(invoked,false);
 const semantic=await recommendProperties(properties,{...input,needs:'Explain black holes'},{runAgent:async({tools})=>{await tools.analyze_preferences(analysis({scope:'out_of_scope'}))}});assert.equal(semantic.status,'out_of_scope');assert.deepEqual(semantic.matches,[]);
});
test('unsupported housing types and driving-time requests ask for clarification',async()=>{
 for(const needs of ['A detached house near LAX','An apartment within 20 minutes of LAX','An apartment within 20 driving miles of LAX']){
  const result=await recommendProperties(properties,{...input,needs},{runAgent:async({tools})=>{await tools.analyze_preferences(analysis({issue:'travel_time'}))}});assert.equal(result.status,'clarification');assert.deepEqual(result.matches,[]);
 }
});
test('ambiguous and unavailable landmarks do not fall back to unrelated apartments',async()=>{
 const result=await recommendProperties(properties,input,{resolvePlace:async()=>({status:'ambiguous',choices:[{id:'one',name:'First place'},{id:'two',name:'Second place'}]}),runAgent:async({tools})=>tools.analyze_preferences(analysis())});
 assert.equal(result.code,'ambiguous');assert.equal(result.actions.length,2);
 const failed=await recommendProperties(properties,input,{resolvePlace:async()=>({status:'unavailable'}),runAgent:async({tools})=>tools.analyze_preferences(analysis())});assert.equal(failed.code,'location_unavailable');
});
test('city conflicts ask before switching instead of silently searching the wrong city',async()=>{
 const result=await recommendProperties(properties,{...input,city:'Houston'},{runAgent:async({tools})=>tools.analyze_preferences(analysis())});
 assert.equal(result.status,'clarification');assert.equal(result.actions[0].city,'Los Angeles');
});
test('no properties inside the radius offers the nearest qualifying radius without applying it',async()=>{
 const result=await recommendProperties([properties[2]],{...input,needs:'within 1 mile of LAX'},{runAgent:async({tools})=>{
  await tools.analyze_preferences(analysis({location:{query:'LAX',radiusMiles:1,mode:'straight_line'}}));const found=await tools.search_properties({});assert.equal(found.matches.length,0);await tools.finish_shortlist({selections:[]});
 }});
 assert.equal(result.status,'no_matches');assert.deepEqual(result.matches,[]);assert.ok(result.actions[0].radiusOverride>1);assert.equal(result.actions[0].kind,'radius');
 const accepted=await recommendProperties([properties[2]],{...input,needs:'within 1 mile of LAX',...result.actions[0]},{runAgent:async({tools})=>{
  await tools.analyze_preferences(analysis({location:{query:'LAX',radiusMiles:1,mode:'straight_line'}}));const found=await tools.search_properties({});await tools.finish_shortlist({selections:selections(found.matches)});
 }});assert.equal(accepted.matches.length,1);
});
test('derived constraints retain missing-data distinctions and filter exact ZIP, pets, area and room maximum',async()=>{
 const rows=[...properties];rows[0]={...rows[0],pets:[{type:'Cat'}]};
 const result=await recommendProperties(rows,{...input,needs:'Cats, ZIP 90001, at least 750 sq ft, exactly 1 bedroom'},{runAgent:async({tools})=>{
  await tools.analyze_preferences(analysis({filters:{cats:true,minSqft:750,maxBeds:1,zipCodes:['90001']},location:{}}));const found=await tools.search_properties({});assert.equal(found.matches.length,1);await tools.finish_shortlist({selections:selections(found.matches)});
 }});assert.equal(result.matches[0].propertyId,1);
 assert.throws(()=>normalizeMatchInput({...input,radiusOverride:-1}));
});
test('trusted LAX anchor works offline, other geocoding is bounded, attributed and rejects malformed coordinates',async()=>{
 const lax=await resolveMatchPlace({query:'Los Angeles Airport',city:'Los Angeles'}, {},async()=>{throw Error('No network')});assert.equal(lax.status,'resolved');assert.equal(supportedCityForPlace(lax.place),'Los Angeles');
 const result=await resolveMatchPlace({query:'Example test landmark',city:'Los Angeles'},{},async address=>{
  assert.equal(new URL(address).hostname,'photon.komoot.io');return {ok:true,json:async()=>({features:[{properties:{name:'Test landmark',countrycode:'US',osm_type:'N',osm_id:9},geometry:{coordinates:[-118.4,33.95]}},{properties:{name:'Bad',countrycode:'US'},geometry:{coordinates:[0,'not-a-latitude']}}]})};
 });assert.equal(result.status,'resolved');assert.match(result.place.source,/OpenStreetMap/);
 const selected=await resolveMatchPlace({choiceId:result.place.id,city:'Los Angeles'});assert.equal(selected.place.id,result.place.id);
 assert.equal(distanceMiles({lat:null,lng:null},lax.place),null);
});

test('full address lookups require the requested house number, never a street centroid',async()=>{
 const valid={properties:{name:'Office',housenumber:'1200',street:'Main Street',city:'Los Angeles',countrycode:'US',osm_type:'N',osm_id:1200},geometry:{coordinates:[-118.24,34.05]}};
 // Earlier test uses the same process-level public-service throttle. Use an isolated module to test a fresh lookup.
 const fresh=await import('../worker/places.mjs?address-test');
 const address=await fresh.resolveMatchPlace({query:'1200 Main Street, Los Angeles',city:'Los Angeles'},{},async()=>({ok:true,json:async()=>({features:[{...valid,properties:{...valid.properties,housenumber:undefined,osm_id:12}},valid]})}));
 assert.equal(address.status,'resolved');assert.match(address.place.name,/1200 Main Street/);
 const separate=await import('../worker/places.mjs?street-test');
 const street=await separate.resolveMatchPlace({query:'1200 Main Street, Los Angeles',city:'Los Angeles'},{},async()=>({ok:true,json:async()=>({features:[{...valid,properties:{...valid.properties,housenumber:undefined}}]})}));
 assert.equal(street.status,'unavailable');
});
test('an exact ZIP invented by a model cannot silently constrain a radius request',async()=>{
 const result=await recommendProperties(properties,input,{runAgent:async({tools})=>{
  const prepared=await tools.analyze_preferences(analysis({filters:{zipCodes:['99999']}}));assert.deepEqual(prepared.criteria.zipCodes,[]);
  const found=await tools.search_properties({});await tools.finish_shortlist({selections:selections(found.matches)});
 }});assert.equal(result.matches.length,3);
});
