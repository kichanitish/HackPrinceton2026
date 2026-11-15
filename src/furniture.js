let furnitureScene=null,furnitureControl=null,furnitureNodes=new Map(),furnitureModel=null,furnitureActive=null,furniturePose=null,furnitureSubscriptions=[],furnitureSaveTimer=null,furnitureBusy=false,furnitureRoomChosen=false;
const furnitureRegistered=new WeakSet();
function setFurnitureState(text,ready){
 $('furnitureStatus').textContent=text;
 for(const id of ['furnitureAdd','furnitureSave','furnitureClear'])$(id).disabled=!ready;
}
function clearFurnitureScene(){
 clearInterval(furnitureSaveTimer);furnitureSaveTimer=null;
 for(const subscription of furnitureSubscriptions)try{subscription.cancel?.()}catch{}
 furnitureSubscriptions=[];
 if(furnitureModel)saveFurniture(false);
 try{if(furnitureControl)furnitureControl.inputs.selection=null;for(const entry of furnitureNodes.values())entry.scene.stop();furnitureScene?.stop()}catch{}
 furnitureScene=null;furnitureControl=null;furnitureNodes.clear();furnitureModel=null;furnitureActive=null;furniturePose=null;furnitureBusy=false;furnitureRoomChosen=false;
 $('furnitureEditor').hidden=true;$('furnitureSelection').innerHTML='<option value="">No furniture yet</option>';
}
function nodePosition(node){return node.position||node.obj3D?.position}
function nodeQuaternion(node){return node.quaternion||node.obj3D?.quaternion}
function furnitureFactory(){
 return {
  inputs:{kind:'bed',width:1.524,depth:2.033,height:1,itemId:0},outputs:{},
  rebuild(){
   this.destroyMeshes();const THREE=this.context.three,group=new THREE.Group();
   for(const part of furnitureParts(this.inputs.kind,this.inputs.width,this.inputs.depth,this.inputs.height)){
    const geometry=new THREE.BoxGeometry(part.width,part.height,part.depth),material=new THREE.MeshStandardMaterial({color:part.color,roughness:.88});
    const mesh=new THREE.Mesh(geometry,material);mesh.position.set(part.x,part.y,part.z);group.add(mesh);
   }
   this.outputs.objectRoot=group;this.outputs.collider=group;
  },
  destroyMeshes(){this.outputs.objectRoot?.traverse(child=>{child.geometry?.dispose();if(Array.isArray(child.material))child.material.forEach(m=>m.dispose());else child.material?.dispose()})},
  onInit(){this.rebuild()},onInputsUpdated(){this.rebuild()},onDestroy(){this.destroyMeshes()},
  onEvent(type){if(String(type).toLowerCase().includes('click'))selectFurniture(this.inputs.itemId)}
 };
}
function importedFurnitureFactory(){
 return {
  inputs:{model:null,loadingState:'Idle',width:2,depth:1,height:1,itemId:0},outputs:{ready:false,failed:false},pending:true,
  onInit(){this.pending=true},onInputsUpdated(){this.pending=true;this.outputs.ready=false},
  onTick(){
   if(this.inputs.loadingState==='Error'){this.outputs.failed=true;return}
   const model=this.inputs.model,parent=model?.parent;if(!this.pending||!parent)return;
   const THREE=this.context.three;
   model.position.set(0,0,0);parent.updateWorldMatrix(true,true);
   const inverse=parent.matrixWorld.clone().invert(),bounds=new THREE.Box3().makeEmpty();
   model.traverse(mesh=>{
    if(!mesh.geometry?.attributes?.position)return;
    mesh.geometry.computeBoundingBox();
    const matrix=new THREE.Matrix4().multiplyMatrices(inverse,mesh.matrixWorld);
    bounds.union(mesh.geometry.boundingBox.clone().applyMatrix4(matrix));
   });
   const fit=furnitureModelFit(bounds,this.inputs);
   if(!fit){this.outputs.failed=true;this.pending=false;return}
   parent.scale.set(fit.scale.x,fit.scale.y,fit.scale.z);model.position.set(fit.offset.x,fit.offset.y,fit.offset.z);parent.updateWorldMatrix(true,true);
   this.outputs.collider=model;this.outputs.failed=false;this.outputs.ready=true;this.pending=false;
  },
  onEvent(type){if(String(type).toLowerCase().includes('click'))selectFurniture(this.inputs.itemId)},
  onDestroy(){this.outputs.collider=null}
 };
}
async function waitForFurniture(entry,session){
 if(!entry.loader)return;
 const started=Date.now();
 while(true){
  if(session!==tourSession)throw Error('Scene closed');
  if(entry.component.outputs.ready)return;
  if(entry.component.outputs.failed||Date.now()-started>30000)throw Error('Furniture model unavailable');
  await new Promise(resolve=>setTimeout(resolve,100));
 }
}
function discardFurniture(id){
 const entry=furnitureNodes.get(id);if(!entry)return;
 if(furnitureControl?.inputs.selection===entry.node)furnitureControl.inputs.selection=null;
 entry.scene.stop();furnitureNodes.delete(id);
 if(furnitureActive===id)furnitureActive=null;
 refreshFurnitureSelection();
}
async function initializeFurnitureScene(connected,token,modelId){
 const current=()=>token===tourSession&&sdk===connected;
 if(!connected.Scene?.createObjects){setFurnitureState('This viewer has no Bundle SDK scene access.',false);return}
 try{
  if(!furnitureRegistered.has(connected)){await connected.Scene.register('homefit.furniture',furnitureFactory);await connected.Scene.register('homefit.modelFit',importedFurnitureFactory);furnitureRegistered.add(connected)}
  if(!current())return;
  const [scene]=await connected.Scene.createObjects(1);if(!current()){scene.stop();return}
  furnitureScene=scene;furnitureModel=modelId;
  const light=scene.addNode();light.addComponent('mp.ambientLight',{intensity:.9,color:{r:1,g:1,b:1}});light.addComponent('mp.directionalLight',{intensity:.7,color:{r:1,g:1,b:1}});
  const controls=scene.addNode();furnitureControl=controls.addComponent('mp.transformControls',{mode:'translate',showX:true,showY:false,showZ:true,size:.8});
  if(connected.Camera?.pose?.subscribe)furnitureSubscriptions.push(connected.Camera.pose.subscribe(pose=>{if(current())furniturePose=pose}));
  scene.start();
  let saved=[];try{saved=restoreFurniture(JSON.parse(localStorage.getItem('homefit-furniture3d-v1:'+modelId)||'[]'))}catch{}
  for(const item of saved){if(!current())return;await createFurnitureNode(item)}
  let failed=0;
  if(saved.some(item=>furnitureCatalog[item.kind].assetUrl))setFurnitureState('Restoring furniture models…',false);
  await Promise.all([...furnitureNodes.entries()].map(async([id,entry])=>{try{await waitForFurniture(entry,token)}catch{if(current()){discardFurniture(id);failed++}}}));
  if(!current())return;
  const last=[...furnitureNodes.keys()].at(-1);if(last)selectFurniture(last);
  renderFurnitureRooms();refreshFurnitureSelection();
  setFurnitureState('3D studio ready'+(furnitureNodes.size?' · restored '+furnitureNodes.size+' piece'+(furnitureNodes.size===1?'':'s')+'.':'. Add furniture to a room, then adjust it in the scan.')+(failed?' Some models could not load; choose another piece to retry.':''),true);
  furnitureSaveTimer=setInterval(()=>{if(current()&&furnitureNodes.size)saveFurniture(false)},1000);
 }catch{if(current())setFurnitureState('The Bundle viewer connected, but furniture tools could not initialize. Reopen the tour to retry.',false)}
}
async function createFurnitureNode(item){
 const connected=sdk,session=tourSession,created=await instantiateFurniture(connected,item);
 if(session!==tourSession||sdk!==connected){created.scene.stop();return null}
 furnitureNodes.set(item.id,{...created,item:{...item}});return created.node;
}
function renderFurnitureRooms(){
 if(!furnitureScene)return;
 const select=$('furnitureRoom'),previous=select.value;
 select.innerHTML='<option value="">Current view</option>'+sdkRooms.filter(r=>r.center&&r.bounds).map((r,i)=>'<option value="'+escape(r.id)+'">'+escape(r.label||'Room '+(i+1))+'</option>').join('');
 if([...select.options].some(o=>o.value===previous))select.value=previous;
 if(!furnitureRoomChosen&&sdkRooms[0])select.value=sdkRooms[0].id;
}
function refreshFurnitureSelection(){
 $('furnitureSelection').innerHTML=furnitureNodes.size?[...furnitureNodes.values()].map(({item})=>'<option value="'+item.id+'">'+escape(furnitureCatalog[item.kind].name)+' '+item.id+'</option>').join(''):'<option value="">No furniture yet</option>';
 $('furnitureSelection').value=furnitureActive||'';$('furnitureEditor').hidden=!furnitureNodes.has(furnitureActive);
}
function selectFurniture(id){
 const entry=furnitureNodes.get(Number(id));if(!entry)return;
 furnitureActive=Number(id);furnitureControl.inputs.selection=entry.node;refreshFurnitureSelection();
 for(const key of ['width','depth','height'])$('furniture'+key[0].toUpperCase()+key.slice(1)).value=entry.item[key];
}
function saveFurniture(feedback=true){
 if(!furnitureModel)return;
 const THREE=sdk?.Scene?.THREE;
 const saved=[...furnitureNodes.values()].map(entry=>{
  const position=nodePosition(entry.node),q=nodeQuaternion(entry.node),yaw=THREE?new THREE.Euler().setFromQuaternion(q,'YXZ').y:entry.item.yaw;
  return {...entry.item,x:position.x,y:position.y,z:position.z,yaw};
 });
 try{localStorage.setItem('homefit-furniture3d-v1:'+furnitureModel,JSON.stringify(saved));if(feedback)setFurnitureState('Arrangement saved on this browser for this scan.',true)}catch{if(feedback)setFurnitureState('Browser storage is unavailable. This arrangement will last for this session.',true)}
}
$('furnitureAdd').onclick=async()=>{
 if(!furnitureScene||furnitureBusy)return;if(furnitureNodes.size>=25){toast('Keep up to 25 pieces in each scan.');return}
 const connected=sdk,scene=furnitureScene,session=tourSession;let addedId=null;furnitureBusy=true;$('furnitureAdd').disabled=true;
 try{
  const room=sdkRooms.find(r=>r.id===$('furnitureRoom').value),placement=furniturePlacement(room,furniturePose);
  if(!placement){setFurnitureState('Wait for the camera position, or choose a room, then try again.',true);return}
  const kind=$('furnitureKind').value,preset=furnitureCatalog[kind],id=Math.max(0,...furnitureNodes.keys())+1;
  if(scene!==furnitureScene||connected!==sdk)return;
  $('furnitureStatus').textContent='Loading '+preset.name.toLowerCase()+'…';
  await createFurnitureNode({kind,id,width:preset.width,depth:preset.depth,height:preset.height,x:placement.x,y:placement.y,z:placement.z,yaw:0});if(session!==tourSession)return;addedId=id;await waitForFurniture(furnitureNodes.get(id),session);if(session!==tourSession)return;selectFurniture(id);saveFurniture(false);
  setFurnitureState(preset.name+' added. Drag its colored handles or use the precise controls below.',true);
  if(room){
   const sweeps=sdkSweeps.filter(s=>s.enabled&&s.position&&s.floorInfo?.id===room.floorInfo?.id&&['x','z'].every(k=>s.position[k]>=room.bounds.min[k]&&s.position[k]<=room.bounds.max[k]));
   const distance=s=>(s.position.x-placement.x)**2+(s.position.z-placement.z)**2;
   const view=sweeps.sort((a,b)=>distance(b)-distance(a))[0];
   if(view)await connected.Sweep.moveTo(view.id,{transition:connected.Camera?.TransitionType?.FLY||'transition.fly',transitionTime:800});
   if(connected===sdk)await connected.Camera.lookAt({x:placement.x,y:placement.y+preset.height*.3048*.55,z:placement.z});
  }

 }catch{if(session===tourSession){if(addedId)discardFurniture(addedId);saveFurniture(false);setFurnitureState('This furniture model could not load. Try another piece or retry shortly.',!!furnitureScene)}}finally{if(session===tourSession){furnitureBusy=false;$('furnitureAdd').disabled=!furnitureScene}}
};
$('furnitureRoom').onchange=()=>{furnitureRoomChosen=true};
$('furnitureSelection').onchange=e=>selectFurniture(Number(e.target.value));
function furnitureMode(mode){if(!furnitureControl)return;furnitureControl.inputs.mode=mode;furnitureControl.inputs.showX=mode==='translate';furnitureControl.inputs.showY=mode==='rotate';furnitureControl.inputs.showZ=mode==='translate';$('furnitureMove').classList.toggle('active',mode==='translate');$('furnitureRotate').classList.toggle('active',mode==='rotate')}
$('furnitureMove').onclick=()=>furnitureMode('translate');$('furnitureRotate').onclick=()=>furnitureMode('rotate');
$('furnitureTurn').onclick=()=>{const entry=furnitureNodes.get(furnitureActive);if(!entry)return;const THREE=sdk.Scene.THREE,q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),Math.PI/2);nodeQuaternion(entry.node).multiply(q);saveFurniture(false)};
$('furnitureResize').onclick=()=>{
 const entry=furnitureNodes.get(furnitureActive);if(!entry)return;
 const fields=['Width','Depth','Height'].map(key=>$('furniture'+key));if(!fields.every(f=>f.reportValidity()))return;
 for(const key of ['width','depth','height']){entry.item[key]=Number($('furniture'+key[0].toUpperCase()+key.slice(1)).value);entry.component.inputs[key]=entry.item[key]*.3048}
 saveFurniture();
};
$('furnitureRemove').onclick=()=>{const entry=furnitureNodes.get(furnitureActive);if(!entry)return;furnitureControl.inputs.selection=null;entry.scene.stop();furnitureNodes.delete(furnitureActive);furnitureActive=null;const next=[...furnitureNodes.keys()].at(-1);if(next)selectFurniture(next);else refreshFurnitureSelection();saveFurniture(false)};
$('furnitureClear').onclick=()=>{if(furnitureControl)furnitureControl.inputs.selection=null;for(const entry of furnitureNodes.values())entry.scene.stop();furnitureNodes.clear();furnitureActive=null;refreshFurnitureSelection();saveFurniture()};
$('furnitureSave').onclick=()=>saveFurniture();
$('furniturePanel').addEventListener('toggle',()=>{if(!furnitureControl)return;furnitureControl.inputs.selection=$('furniturePanel').open?furnitureNodes.get(furnitureActive)?.node||null:null});
document.addEventListener('click',e=>{const button=e.target.closest('[data-nudge]');if(!button)return;const entry=furnitureNodes.get(furnitureActive);if(!entry)return;const [axis,amount]=button.dataset.nudge.split(':');nodePosition(entry.node)[axis]+=Number(amount);saveFurniture(false)});

const furnitureGroups=[...new Set(Object.values(furnitureCatalog).filter(item=>!item.hidden).map(item=>item.group))];
$('furnitureKind').innerHTML=furnitureGroups.map(group=>'<optgroup label="'+escape(group)+'">'+Object.entries(furnitureCatalog).filter(([,item])=>!item.hidden&&item.group===group).map(([key,item])=>'<option value="'+escape(key)+'">'+escape(item.name)+'</option>').join('')+'</optgroup>').join('');
$('furnitureCredits').innerHTML=Object.values(furnitureCatalog).filter(item=>item.assetUrl).map(item=>'<p><a href="'+escape(item.source)+'" target="_blank" rel="noopener noreferrer">'+escape(item.title)+'</a> by '+escape(item.author)+' · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a></p>').join('')+'<p>Models are centered, rotated and rescaled for staging. Dimensions are editable visualization estimates.</p>';
