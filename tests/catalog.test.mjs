import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('catalog contains only joinable, available, priced whole-unit floor plans with scoped scans',async()=>{
 const data=JSON.parse(await readFile(new URL('../data/catalog.json',import.meta.url)));
 assert.equal(data.properties.length,789);
 assert.equal(data.properties.reduce((n,p)=>n+p.plans.length,0),1700);
 assert.equal(new Set(data.properties.map(p=>p.id)).size,789);
 for(const p of data.properties){
  assert.ok(p.name&&p.address);assert.ok(['Houston','Los Angeles'].includes(p.city));
  for(const plan of p.plans){assert.ok(plan.rentMin>0&&plan.available>0);assert.ok(plan.tours.length);for(const t of plan.tours)assert.ok(t.id&&['Floor plan','Representative unit'].includes(t.scope));}
 }
});
