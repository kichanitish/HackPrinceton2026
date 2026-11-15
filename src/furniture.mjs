const sampleAssetBase='https://static.matterport.com/showcase-sdk/examples/assets-1.1.0/assets/models/';
export const furnitureCatalog={
 'scandinavian-sofa':{name:'Scandinavian sofa',group:'Detailed seating',width:7,depth:3,height:2.8,assetUrl:sampleAssetBase+'sofa/9/scene.gltf',sourceYaw:90,author:'harmonic100100',title:'Scandinavian Design Sofa',source:'https://sketchfab.com/models/ac1fd61e45d0425c8ce014fa520458ee',license:'CC BY 4.0'},
 'black-armchair':{name:'Black armchair',group:'Detailed seating',width:3,depth:3,height:3.1,assetUrl:sampleAssetBase+'arm-chair/4/scene.gltf',sourceYaw:0,author:'adhils',title:'Arm Chair',source:'https://sketchfab.com/3d-models/arm-chair-cf5c229d44da47f7bf5b0e3467b76896',license:'CC BY 4.0'},
 'burgundy-armchair':{name:'Burgundy armchair',group:'Detailed seating',width:3,depth:3.1,height:3.3,assetUrl:sampleAssetBase+'arm-chair/5/scene.gltf',sourceYaw:-90,author:'Irina.Tuchna',title:'Armchair',source:'https://sketchfab.com/3d-models/armchair-aa996d92464a4d2bb5d84377944f6227',license:'CC BY 4.0'},
 'vintage-coffee-table':{name:'Vintage coffee table',group:'Detailed tables',width:4,depth:2.4,height:1.6,assetUrl:sampleAssetBase+'coffee-table/2/scene.gltf',sourceYaw:0,author:'Geug',title:'Vintage Coffee Table 70s 02 Freebie',source:'https://sketchfab.com/3d-models/vintage-coffee-table-70s-02-freebie-5f1dbecdc7f14ab4886a594a074b3c83',license:'CC BY 4.0'},
 'vintage-coffee-table-2':{name:'Vintage coffee table II',group:'Detailed tables',width:4,depth:2.4,height:1.6,assetUrl:sampleAssetBase+'coffee-table/3/scene.gltf',sourceYaw:0,author:'Geug',title:'Vintage Coffee Table 70s 03 Freebie',source:'https://sketchfab.com/3d-models/vintage-coffee-table-70s-03-freebie-96bedccbbc3d470f8f7d636b598c7bd2',license:'CC BY 4.0'},
 'classic-coffee-table':{name:'Classic coffee table',group:'Detailed tables',width:4,depth:2.5,height:1.6,assetUrl:sampleAssetBase+'coffee-table/6/scene.gltf',sourceYaw:0,author:'mhanna',title:'Classic Coffee Table',source:'https://sketchfab.com/3d-models/classic-coffee-table-0b151b371da847d3a2dd960f9339eef1',license:'CC BY 4.0'},
 bed:{name:'Queen bed',group:'Simple essentials',width:5,depth:6.67,height:3.3},sofa:{name:'Simple sofa',hidden:true,width:7,depth:3,height:2.8},desk:{name:'Desk',group:'Simple essentials',width:4,depth:2,height:2.5},table:{name:'Dining table',group:'Simple essentials',width:5,depth:3,height:2.5}
};
export function furniturePlacement(room,pose){
 const finite=v=>v&&['x','y','z'].every(k=>Number.isFinite(v[k]));
 if(finite(room?.center)&&finite(room?.bounds?.min))return {x:room.center.x,y:room.bounds.min.y+.025,z:room.center.z,source:'room'};
 if(finite(pose?.position)){
  const yaw=Number(pose.rotation?.y||0)*Math.PI/180;
  return {x:pose.position.x-Math.sin(yaw)*2,y:pose.position.y-1.55,z:pose.position.z-Math.cos(yaw)*2,source:'view'};
 }
 return null;
}
export function restoreFurniture(value){
 if(!Array.isArray(value))return [];
 return value.slice(0,25).filter(item=>Object.hasOwn(furnitureCatalog,item?.kind)&&[item.width,item.depth,item.height,item.x,item.y,item.z,item.yaw].every(Number.isFinite)&&item.width>=.5&&item.width<=20&&item.depth>=.5&&item.depth<=20&&item.height>=.5&&item.height<=12&&Math.abs(item.x)<10000&&Math.abs(item.y)<10000&&Math.abs(item.z)<10000).map((item,index)=>({...item,id:index+1}));
}
// Original low-poly furniture, in meters. No external model license or fetch is needed.
export function furnitureParts(kind,w,d,h){
 const parts=[],add=(x,y,z,width,height,depth,color)=>parts.push({x,y,z,width,height,depth,color});
 const wood=0x86684b,fabric=0x839481,cream=0xe8e4d7,dark=0x343d35;
 if(kind==='bed'){
  for(const x of [-1,1])for(const z of [-1,1])add(x*w*.4,h*.08,z*d*.4,w*.055,h*.16,d*.045,dark);
  add(0,h*.22,0,w,h*.28,d,wood);add(0,h*.44,0,w*.98,h*.2,d*.98,cream);
  add(0,h*.5,-d*.475,w,h,d*.05,wood);
  add(-w*.25,h*.58,-d*.32,w*.4,h*.09,d*.22,0xf8f5ec);add(w*.25,h*.58,-d*.32,w*.4,h*.09,d*.22,0xf8f5ec);
  add(0,h*.56,d*.15,w*.99,h*.03,d*.57,fabric);
 }else if(kind==='sofa'){
  for(const x of [-1,1])for(const z of [-1,1])add(x*w*.4,h*.11,z*d*.3,w*.04,h*.22,d*.08,wood);
  add(0,h*.26,0,w*.95,h*.3,d*.9,dark);add(0,h*.46,d*.05,w*.8,h*.18,d*.8,fabric);
  add(0,h*.69,-d*.38,w,h*.62,d*.2,fabric);
  for(const x of [-1,1])add(x*w*.455,h*.52,0,w*.09,h*.42,d,fabric);
  for(const x of [-1,1])add(x*w*.205,h*.57,d*.05,w*.39,h*.04,d*.75,0x9aaa96);
 }else{
  add(0,h*.95,0,w,h*.1,d,kind==='desk'?0xb69b78:wood);
  const leg=Math.min(w,d)*.075;
  for(const x of [-1,1])for(const z of [-1,1])add(x*(w/2-leg),h*.45,z*(d/2-leg),leg,h*.9,leg,dark);
  if(kind==='desk')add(w*.3,h*.77,0,w*.28,h*.25,d*.85,wood);
 }
 return parts;
}
export async function instantiateFurniture(connected,item){
 const [scene]=await connected.Scene.createObjects(1);
 try{
  const node=scene.addNode(),preset=furnitureCatalog[item.kind];let component,loader=null;
  const dimensions={width:item.width*.3048,depth:item.depth*.3048,height:item.height*.3048,itemId:item.id};
  if(preset.assetUrl){
   loader=node.addComponent('mp.gltfLoader',{url:preset.assetUrl,localRotation:{x:0,y:preset.sourceYaw||0,z:0},colliderEnabled:false});
   component=node.addComponent('homefit.modelFit',dimensions);
   scene.bindPath(scene.addInputPath(component,'model'),scene.addOutputPath(loader,'objectRoot'));
   scene.bindPath(scene.addInputPath(component,'loadingState'),scene.addOutputPath(loader,'loadingState'));
  }else component=node.addComponent('homefit.furniture',{kind:item.kind,...dimensions});
  (node.position||node.obj3D.position).set(item.x,item.y,item.z);
  const THREE=connected.Scene.THREE;
  (node.quaternion||node.obj3D.quaternion).setFromAxisAngle(new THREE.Vector3(0,1,0),item.yaw);
  scene.start();return {scene,node,component,loader};
 }catch(error){scene.stop();throw error}
}

// Fit a source model into the requested staging dimensions and ground its base.
export function furnitureModelFit(bounds,dimensions){
 const keys=['x','y','z'],sizes=keys.map(key=>bounds?.max?.[key]-bounds?.min?.[key]);
 const targets=[dimensions.width,dimensions.height,dimensions.depth];
 if(!sizes.every(n=>Number.isFinite(n)&&n>1e-8)||!targets.every(n=>Number.isFinite(n)&&n>0))return null;
 return {scale:{x:targets[0]/sizes[0],y:targets[1]/sizes[1],z:targets[2]/sizes[2]},offset:{x:-(bounds.min.x+bounds.max.x)/2,y:-bounds.min.y,z:-(bounds.min.z+bounds.max.z)/2}};
}
