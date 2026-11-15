import test from 'node:test';
import assert from 'node:assert/strict';
import {featureAvailability,scanForPlan,availablePublishedViews,defurnishPair,observePlaying} from '../src/capabilities.mjs';
test('unknown feature flags remain distinct from unavailable features',()=>{
 assert.equal(featureAvailability(true),'available');assert.equal(featureAvailability(false),'unavailable');assert.equal(featureAvailability(undefined),'unverified');assert.equal(featureAvailability(null),'unverified');
});
test('scan selection preserves a chosen linked scan and rejects arbitrary ids',()=>{
 const plan={tours:[{id:'one'},{id:'two'}]};assert.equal(scanForPlan(plan,'two').id,'two');assert.equal(scanForPlan(plan,'unknown').id,'one');
});
test('furniture removal requires a switchable original and defurnished view',()=>{
 const base={id:'original',type:'viewtype.base',setActive:async()=>{}},empty={id:'empty',type:'viewtype.defurnish',setActive:async()=>{}};
 assert.equal(defurnishPair([base]),null);assert.equal(defurnishPair([empty]),null);
 assert.equal(defurnishPair([base,empty]).empty.id,'empty');
 assert.equal(availablePublishedViews({base,empty,bad:{id:'bad'}}).length,2);
});
test('synchronous ready notifications cancel their subscriptions',async()=>{
 let cancelled=0;
 const connected={App:{state:{subscribe(callback){callback({phase:'appphase.playing'});return {cancel(){cancelled++}}}}}};
 assert.equal(await observePlaying(connected),true);assert.equal(cancelled,1);
});
test('loading is not ready, and stale sessions cancel readiness checks',async()=>{
 let changed,cancelled=0;
 const connected={App:{state:{subscribe(callback){changed=callback;callback({phase:'appphase.loading'});return {cancel(){cancelled++}}}}}};
 let current=true;
 const job=observePlaying(connected,{isCurrent:()=>current});current=false;changed({phase:'appphase.playing'});
 assert.equal(await job,false);assert.equal(cancelled,1);
 assert.equal(await observePlaying({}),false);
});
test('readiness timeouts resolve without leaking subscriptions',async()=>{
 let cancelled=0;
 assert.equal(await observePlaying({App:{state:{subscribe:()=>({cancel(){cancelled++}})}}},{timeoutMs:1}),false);assert.equal(cancelled,1);
});

import {scanDisplaySettings} from '../src/capabilities.mjs';
test('publisher settings retain explicit disabled tools; failed reads remain unknown',async()=>{
 const settings=await scanDisplaySettings({Settings:{get:async key=>{if(key==='dollhouse')return false;if(key==='measurements')return true;if(key==='labels')throw Error('not readable');return undefined}}});
 assert.deepEqual(settings,{measurements:true,dollhouse:false});assert.ok(!Object.hasOwn(settings,'labels'));
 assert.deepEqual(await scanDisplaySettings({}),{});
});

import {bestExposedScan} from '../src/capabilities.mjs';
test('the measured linked scan replaces an earlier scan with only room labels',()=>{
 const tours=[{id:'plain'},{id:'measured'}],plain={ok:true,model:{rooms:[{label:'Bedroom'}]}};
 const measured={ok:true,model:{rooms:[{label:'Bedroom',dimensions:{units:'imperial',width:12,depth:10}}]}};
 assert.equal(bestExposedScan(tours,[plain,measured]).id,'measured');
 assert.equal(bestExposedScan(tours,[measured,plain]).id,'plain');
});
test('scan ranking prefers more measured rooms then measured total area with stable ties',()=>{
 const tours=[{id:'a'},{id:'b'}],room={label:'Bedroom',dimensions:{units:'metric',areaFloorIndoor:12}};
 const result=(rooms,dimensions)=>({ok:true,model:{rooms,dimensions}});
 assert.equal(bestExposedScan(tours,[result([room]),result([room,room])]).id,'b');
 assert.equal(bestExposedScan(tours,[result([room]),result([room],{units:'metric',areaFloorIndoor:90})]).id,'b');
 assert.equal(bestExposedScan(tours,[result([room]),result([room])]).id,'a');
});
test('unmeasured plans retain a working scan and missing data is never counted as measurements',()=>{
 const tours=[{id:'a'},{id:'b'}];
 const empty={ok:true,model:{rooms:[]}};
 assert.equal(bestExposedScan(tours,[{ok:false},empty]).id,'b');
 assert.equal(bestExposedScan(tours,[{ok:false},{ok:false}]).id,'a');
 const invalid={ok:true,model:{rooms:[{label:'void',dimensions:{units:'metric',areaFloorIndoor:50}},{label:'Room',dimensions:{units:'unknown',width:12,depth:10}}]}};
 const total={ok:true,model:{rooms:[],dimensions:{units:'imperial',areaFloorIndoor:600}}};
 assert.equal(bestExposedScan(tours,[invalid,total]).id,'b');
});
