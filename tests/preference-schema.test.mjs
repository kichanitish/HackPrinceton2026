import test from 'node:test';
import assert from 'node:assert/strict';
import {createPreferenceSchema,createPreferenceToolSchema,preferenceIssueDetails} from '../worker/preference-schema.mjs';
let z;try{({z}=await import('zod'))}catch{}
const skip=!z;
test('partial preference objects default optional fields individually',{skip},()=>{
 const result=createPreferenceSchema(z).parse({scope:'housing',filters:{budget:3000,priority:'space'},location:{query:'LAX',radiusMiles:10}});
 assert.equal(result.filters.budget,3000);assert.equal(result.filters.beds,null);assert.equal(result.filters.dogs,false);assert.deepEqual(result.filters.zipCodes,[]);assert.equal(result.location.mode,'unspecified');
});
test('safe numeric strings and explicit boolean strings retain requirements',{skip},()=>{
 const result=createPreferenceSchema(z).parse({scope:'housing',issue:null,filters:{budget:'$3,000',beds:'0',baths:'1.5',dogs:'true',parking:'false',zipCodes:'90001, 90210'},location:{query:' LAX ',radiusMiles:'10',mode:null}});
 assert.equal(result.filters.budget,3000);assert.equal(result.filters.beds,0);assert.equal(result.filters.baths,1.5);assert.equal(result.filters.dogs,true);assert.equal(result.filters.parking,false);assert.deepEqual(result.filters.zipCodes,['90001','90210']);assert.equal(result.location.radiusMiles,10);
});
test('malformed hard requirements are rejected instead of dropped or turned into guesses',{skip},()=>{
 const schema=createPreferenceSchema(z);
 for(const filters of [{budget:'cheap'},{budget:-1},{beds:1.5},{dogs:'maybe'},{zipCodes:['not a zip']},{maxBeds:7}])assert.equal(schema.safeParse({scope:'housing',filters}).success,false);
 assert.equal(schema.safeParse({filters:{}}).success,false);assert.equal(schema.safeParse({scope:'housing',location:{radiusMiles:'ten'}}).success,false);
});
test('validation logs expose field/type diagnostics without raw values',{skip},()=>{
 const raw={scope:'housing',filters:{budget:'private-invalid-value'}};const result=createPreferenceSchema(z).safeParse(raw);assert.equal(result.success,false);
 const details=preferenceIssueDetails(result.error.issues,raw);assert.equal(details[0].field,'filters.budget');assert.equal(details[0].receivedType,'string');assert.ok(!JSON.stringify(details).includes('private-invalid-value'));
});
test('model-facing tool schema remains serializable to JSON Schema',{skip},()=>{assert.doesNotThrow(()=>z.toJSONSchema(createPreferenceToolSchema(z)))});
