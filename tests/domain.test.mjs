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
