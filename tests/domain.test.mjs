import test from 'node:test';
import assert from 'node:assert/strict';
import {matchingPlans,selectPlan,normalizeSelections,comparisonInsights} from '../src/domain.mjs';
const p={id:1,name:'Oak House',city:'Houston',address:'10 Main St',zip:'77001',noPets:false,noParking:false,pets:[{type:'Dog'}],parking:[{type:'Garage'}],plans:[{id:10,beds:0,rentMin:900,available:2,sqftMin:450},{id:11,beds:2,rentMin:1500,rentMax:1800,available:1,sqftMin:1000},{id:12,beds:3,rentMin:2200,available:2},{id:13,beds:2,rentMin:0,available:5}]};
test('filters apply at the floor-plan level and zero rent is not a cheap apartment',()=>{
 assert.deepEqual(matchingPlans(p,{beds:'2',budget:'1600'}).map(x=>x.id),[11]);
 assert.deepEqual(matchingPlans(p,{beds:'0'}).map(x=>x.id),[10]);
 assert.deepEqual(matchingPlans(p,{beds:'3'}).map(x=>x.id),[12]);
 assert.equal(matchingPlans(p,{city:'Los Angeles'}).length,0);
 assert.equal(matchingPlans(p,{query:'77001',dogs:true,parking:true}).length,3);
 assert.equal(matchingPlans({...p,noPets:true},{dogs:true}).length,0);
});
test('preferred plan falls back to a valid filtered plan',()=>{
 assert.equal(selectPlan(p,{beds:'2'},10).id,11);
 assert.equal(selectPlan(p,{budget:'500'}),null);
});
test('restored shortlist rejects invalid ids, duplicate properties, and more than three properties',()=>{
 const props=[p,...[2,3,4].map(id=>({...p,id}))];
 assert.deepEqual(normalizeSelections([{propertyId:1,planId:99},{propertyId:1,planId:11},{propertyId:1,planId:10},{propertyId:2,planId:11},{propertyId:3,planId:11},{propertyId:4,planId:11}],props),[{propertyId:1,planId:11},{propertyId:2,planId:11},{propertyId:3,planId:11}]);
 assert.deepEqual(normalizeSelections(null,props),[]);
});
test('comparison explains rent differences and flags mismatched bedroom counts',()=>{
 const notes=comparisonInsights([{property:p,plan:p.plans[0]},{property:{...p,id:2,name:'Pine House'},plan:p.plans[1]}]);
 assert.equal(notes.find(x=>x.kind==='rent').difference,600);
 assert.ok(notes.find(x=>x.kind==='beds'));
 assert.ok(notes.find(x=>x.kind==='space'));
});

import {latestAerialCollection} from '../src/domain.mjs';
test('latest aerial collection is selected by capture date across imagery layers',()=>{
 const collections=[{id:'urban-old',layer:'urban',lastCapture:'2025-12-01'},{id:'wide-new',layer:'wide-area',lastCapture:'2026-06-01'},{id:'unknown',layer:'urban'}];
 assert.equal(latestAerialCollection(collections).id,'wide-new');assert.equal(collections[0].id,'urban-old');
 assert.equal(latestAerialCollection([]),null);
 assert.equal(latestAerialCollection([{id:'first-only',firstCapture:'2026-01-01'},{id:'bad',lastCapture:'invalid'}]).id,'first-only');
});

test('bathroom filters use the same available plan as bedroom and budget filters, including half baths',()=>{
 const property={...p,plans:[
  {id:1,beds:1,baths:1,rentMin:1000,available:1},
  {id:2,beds:1,baths:1.5,rentMin:1200,available:1},
  {id:3,beds:2,baths:2,rentMin:1800,available:1},
  {id:4,beds:3,baths:3.5,rentMin:2500,available:1},
  {id:5,beds:1,baths:null,rentMin:1100,available:1},
  {id:6,beds:1,baths:2,rentMin:1000,available:0}
 ]};
 assert.deepEqual(matchingPlans(property,{baths:'1'}).map(x=>x.id),[1]);
 assert.deepEqual(matchingPlans(property,{baths:'1.5'}).map(x=>x.id),[2]);
 assert.deepEqual(matchingPlans(property,{baths:'2',beds:'1'}),[]);
 assert.deepEqual(matchingPlans(property,{baths:'2',budget:'1700'}),[]);
 assert.deepEqual(matchingPlans(property,{baths:'2',beds:'2',budget:'1800'}).map(x=>x.id),[3]);
 assert.deepEqual(matchingPlans(property,{baths:'3'}).map(x=>x.id),[4]);
 assert.deepEqual(matchingPlans(property,{baths:''}).map(x=>x.id),[1,2,3,4,5]);
 assert.equal(selectPlan(property,{baths:'2'},1).id,3);
});
