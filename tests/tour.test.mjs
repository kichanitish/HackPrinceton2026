import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectConnectedSdk,sweepForRoom,matchingRoom} from '../src/tour.mjs';
const withTimeout=promise=>promise;
test('a failing saved-tour lookup never downgrades a connected camera SDK',async()=>{
 const updates=[];
 const result=await inspectConnectedSdk({Model:{getData:async()=>({name:'Apartment'})},Tour:{getData:async()=>{throw Error('unavailable')}}},{modelId:'abc',withTimeout,onUpdate:s=>updates.push(s)});
 assert.equal(updates[0].connected,true);assert.equal(updates[0].guidedState,'checking');
 assert.equal(result.connected,true);assert.equal(result.guidedState,'failed');assert.equal(result.label,'Apartment');
});
test('no saved tour is distinct from a failed query',async()=>{
 const result=await inspectConnectedSdk({Model:{getData:async()=>({})},Tour:{getData:async()=>[]}},{modelId:'abc',withTimeout,onUpdate:()=>{}});
 assert.equal(result.connected,true);assert.equal(result.guidedState,'empty');
});
test('metadata failure does not prevent guided-tour availability',async()=>{
 const result=await inspectConnectedSdk({Model:{getData:async()=>{throw Error()}},Tour:{getData:async()=>[{sid:'one'},{sid:'two'}]}},{modelId:'abc',withTimeout,onUpdate:()=>{}});
 assert.equal(result.connected,true);assert.equal(result.label,'abc');assert.equal(result.guidedState,'ready');assert.equal(result.stopCount,2);
});
test('closing or replacing a tour suppresses stale UI updates',async()=>{
 let current=true;const updates=[];
 await inspectConnectedSdk({Model:{getData:async()=>{current=false;return {name:'Old tour'}}},Tour:{getData:async()=>[]}},{modelId:'abc',withTimeout,isCurrent:()=>current,onUpdate:s=>updates.push(s)});
 assert.equal(updates.length,1);
});
test('room navigation excludes disabled sweeps and sweeps on another floor',()=>{
 const room={center:{x:2,y:2,z:2},bounds:{min:{x:0,z:0},max:{x:4,z:4}},floorInfo:{id:'one'}};
 const sweeps=[{id:'wrong-floor',enabled:true,floorInfo:{id:'two'},position:{x:2,y:2,z:2}},{id:'disabled',enabled:false,floorInfo:{id:'one'},position:{x:2,y:2,z:2}},{id:'correct',enabled:true,floorInfo:{id:'one'},position:{x:1,y:2,z:1}}];
 assert.equal(sweepForRoom(room,sweeps).id,'correct');assert.equal(sweepForRoom(room,[]),null);
});
test('room label matching rejects ambiguous matches',()=>{
 assert.equal(matchingRoom([{label:' Kitchen ',id:'one'}],'kitchen').id,'one');
 assert.equal(matchingRoom([{label:'Bedroom',id:'one'},{label:'Bedroom',id:'two'}],'bedroom'),null);
});
