import test from 'node:test';
import assert from 'node:assert/strict';
import {furnitureCatalog,furniturePlacement,restoreFurniture,furnitureParts} from '../src/furniture.mjs';
test('placement uses room coordinates and floor bound instead of a guessed origin',()=>{
 const point=furniturePlacement({center:{x:10,y:2,z:-8},bounds:{min:{x:8,y:.2,z:-10}}},null);
 assert.deepEqual(point,{x:10,y:.225,z:-8,source:'room'});
 assert.equal(furniturePlacement(null,null),null);
});
test('camera fallback places furniture in front of the camera and marks the estimate',()=>{
 const point=furniturePlacement(null,{position:{x:10,y:2,z:5},rotation:{y:90}});
 assert.ok(Math.abs(point.x-8)<.00001);assert.equal(point.z,5);assert.equal(point.source,'view');assert.ok(Math.abs(point.y-.45)<.00001);
});
test('saved scenes reject invalid dimensions, positions and unsupported furniture',()=>{
 const item={kind:'desk',width:4,depth:2,height:2.5,x:10,y:1,z:-2,yaw:Math.PI/2};
 const saved=restoreFurniture([item,{...item,x:NaN},{...item,width:-1},{...item,kind:'untrusted'},{...item,z:Infinity}]);
 assert.equal(saved.length,1);assert.equal(saved[0].id,1);assert.equal(saved[0].yaw,Math.PI/2);
 assert.deepEqual(restoreFurniture({}),[]);
});
test('all furniture mesh parts fit the requested dimensions and sit above the base',()=>{
 for(const [kind,preset] of Object.entries(furnitureCatalog)){
  if(preset.assetUrl)continue;
  const w=preset.width*.3048,d=preset.depth*.3048,h=preset.height*.3048,parts=furnitureParts(kind,w,d,h);
  assert.ok(parts.length>=5);
  for(const p of parts){
   assert.ok(p.width>0&&p.depth>0&&p.height>0);
   assert.ok(Math.abs(p.x)+p.width/2<=w/2+.0001,kind+' width');
   assert.ok(Math.abs(p.z)+p.depth/2<=d/2+.0001,kind+' depth');
   assert.ok(p.y-p.height/2>=-.0001,kind+' floor');
   assert.ok(p.y+p.height/2<=h+.0001,kind+' height');
  }
 }
});

import {instantiateFurniture} from '../src/furniture.mjs';
test('each furniture item starts its own configured scene object and cleans up failed creation',async()=>{
 const objects=[];
 const connected={Scene:{THREE:{Vector3:class{constructor(x,y,z){Object.assign(this,{x,y,z})}}},async createObjects(){
  const object={started:false,stopped:false,addNode(){assert.equal(this.started,false,'cannot add nodes after scene start');return {position:{set(...args){object.position=args}},quaternion:{setFromAxisAngle(axis,yaw){object.yaw=yaw}},addComponent(name,inputs){object.inputs=inputs;return {inputs}}}},start(){this.started=true},stop(){this.stopped=true}};
  objects.push(object);return [object];
 }}};
 const item={id:1,kind:'desk',width:4,depth:2,height:2.5,x:1,y:0,z:3,yaw:Math.PI/2};
 const first=await instantiateFurniture(connected,item),second=await instantiateFurniture(connected,{...item,id:2});
 assert.notEqual(first.scene,second.scene);assert.deepEqual(first.scene.position,[1,0,3]);assert.equal(first.component.inputs.width,1.2192);assert.equal(first.scene.started,true);
 const broken={Scene:{...connected.Scene,THREE:null}};
 await assert.rejects(()=>instantiateFurniture(broken,item));assert.equal(objects.at(-1).stopped,true);
});

import {furnitureModelFit} from '../src/furniture.mjs';
test('sample models have explicit source credits and use the official versioned asset host',()=>{
 const detailed=Object.values(furnitureCatalog).filter(item=>item.assetUrl);
 assert.equal(detailed.length,6);
 for(const item of detailed){assert.match(item.assetUrl,/^https:\/\/static\.matterport\.com\/showcase-sdk\/examples\/assets-1\.1\.0\/assets\/models\//);assert.equal(item.license,'CC BY 4.0');assert.ok(item.author&&item.title);assert.match(item.source,/^https:\/\/sketchfab\.com\//)}
});
test('model fitting centers and grounds authoring-unit geometry at editable dimensions',()=>{
 const bounds={min:{x:-100,y:-20,z:40},max:{x:300,y:180,z:240}};
 const fit=furnitureModelFit(bounds,{width:2,height:1,depth:1.5});
 assert.deepEqual(fit.scale,{x:.005,y:.005,z:.0075});assert.deepEqual(fit.offset,{x:-100,y:20,z:-140});
 assert.equal((bounds.min.y+fit.offset.y)*fit.scale.y,0);
 assert.equal((bounds.max.x-bounds.min.x)*fit.scale.x,2);
 assert.equal(furnitureModelFit({min:{x:0,y:0,z:0},max:{x:0,y:1,z:1}},{width:2,height:1,depth:1}),null);
});
test('GLTF furniture uses the SDK loader with fitting bindings and preserves its scene pose',async()=>{
 const components=[],bindings=[];
 const node={position:{set(...args){node.pose=args}},quaternion:{setFromAxisAngle(axis,yaw){node.yaw=yaw}},addComponent(name,inputs){const component={name,inputs};components.push(component);return component}};
 const scene={addNode:()=>node,addInputPath:(component,property)=>({component,property}),addOutputPath:(component,property)=>({component,property}),bindPath:(target,source)=>bindings.push({target,source}),start(){this.started=true},stop(){}};
 const connected={Scene:{THREE:{Vector3:class{}},createObjects:async()=>[scene]}};
 const entry=await instantiateFurniture(connected,{id:3,kind:'scandinavian-sofa',width:7,depth:3,height:2.8,x:10,y:.2,z:7,yaw:1});
 assert.equal(entry.loader.name,'mp.gltfLoader');assert.equal(entry.component.name,'homefit.modelFit');assert.equal(bindings.length,2);assert.equal(bindings[0].source.property,'objectRoot');assert.equal(bindings[1].source.property,'loadingState');assert.deepEqual(node.pose,[10,.2,7]);assert.equal(scene.started,true);
});
