// Retain original links; expose a single best scan after checking live API data.
const planScanSelections=new WeakMap();
async function selectPlanScan(plan){
 if(plan.tours.length<2||config.preview)return plan.tours[0];
 if(!planScanSelections.has(plan)){
  const tours=[...plan.tours];
  planScanSelections.set(plan,Promise.all(tours.map(t=>loadModel(t.id))).then(results=>{
   const best=bestExposedScan(tours,results);plan.tours=[best];return best;
  }));
 }
 return planScanSelections.get(plan);
}
async function loadModel(id){
 if(liveModelCache.has(id))return liveModelCache.get(id);
 if(config.preview)return {ok:false,state:'Server required'};
 if(!liveModelJobs.has(id))liveModelJobs.set(id,fetch('/api/model?id='+encodeURIComponent(id)).then(r=>r.json()).catch(()=>({ok:false,state:'Connection failed'})).then(result=>{liveModelCache.set(id,result);liveModelJobs.delete(id);return result}));
 return liveModelJobs.get(id);
}
function measuredArea(d){if(!(d?.areaFloorIndoor>0))return null;return d.units==='imperial'?d.areaFloorIndoor:d.units==='metric'?d.areaFloorIndoor*10.7639104167:null}
function areaText(d){const area=measuredArea(d);return area?Math.round(area).toLocaleString('en-US')+' sq ft':null}
function roomFacts(room){const d=room.dimensions;const parts=[];if(areaText(d))parts.push(areaText(d));if(d?.width>0&&d?.depth>0){const unit=d.units==='imperial'?'ft':d.units==='metric'?'m':null;if(unit)parts.push(Number(d.width).toFixed(1)+' × '+Number(d.depth).toFixed(1)+' '+unit)}return parts.join(' · ')||'Dimensions not reported'}
function usableRoom(room){return normalizeRoomName(room.label)!=='void'}
function clearSdkRoomData(){walkRun++;sdkRooms=[];sdkSweeps=[];activeModelData=null;for(const s of sdkSubscriptions)try{s.cancel?.()}catch{}sdkSubscriptions=[];$('autoWalk').textContent='Auto walkthrough'}
function subscribeTourRooms(connected,token){
 const current=()=>token===tourSession;
 if(connected.Room?.data?.subscribe)try{sdkSubscriptions.push(connected.Room.data.subscribe({onCollectionUpdated:rooms=>{if(!current())return;sdkRooms=Object.values(rooms).filter(usableRoom);renderTourRooms();renderFurnitureRooms()}}))}catch{}
 if(connected.Sweep?.data?.subscribe)try{sdkSubscriptions.push(connected.Sweep.data.subscribe({onCollectionUpdated:sweeps=>{if(!current())return;sdkSweeps=Object.values(sweeps);renderTourRooms();renderFurnitureRooms()}}))}catch{}
}
function renderTourRooms(){
 const model=activeModelData?.ok?activeModelData.model:null;
 $('modelArea').textContent=areaText(model?.dimensions)?areaText(model.dimensions)+' captured indoor area':'';
 const rooms=model?.rooms?.length?model.rooms.filter(usableRoom):sdkRooms;
 if(!rooms.length){$('roomStatus').textContent=activeModelData?.ok?'Room records are not available for this scan.':config.preview?'Run the server version to load live room measurements.':'Room metadata is unavailable for this scan. You can still explore the viewer.';$('roomList').replaceChildren();return}
 $('roomStatus').textContent=rooms.length+' room records · select an enabled room to move there. Dimensions below come from scan data; the ruler adds your own measurements.';
 $('roomList').innerHTML=rooms.map((room,index)=>{
  const spatial=sdkRooms.find(r=>r.id===room.id)||matchingRoom(sdkRooms,room.label),target=spatial&&sweepForRoom(spatial,sdkSweeps);
  return '<button class="room-tile" data-room="'+escape(spatial?.id||room.id)+'" '+(!target?'disabled':'')+'><strong>'+escape(room.label||'Room '+(index+1))+'</strong><span>'+escape(roomFacts(room))+'</span></button>';
 }).join('');
 $('autoWalk').disabled=!sdk||sdkRooms.filter(r=>sweepForRoom(r,sdkSweeps)).length<2;
}
async function jumpToRoom(id){
 const room=sdkRooms.find(r=>r.id===id),sweep=room&&sweepForRoom(room,sdkSweeps),connected=sdk;
 if(!connected||!sweep)return;
 try{
  await connected.Sweep.moveTo(sweep.id,{transition:connected.Camera?.TransitionType?.FLY||'transition.fly',transitionTime:1000});
  if(connected===sdk&&typeof connected.Camera.lookAt==='function'){
   const target={x:room.center.x,y:sweep.position.y,z:room.center.z};
   if(Math.hypot(target.x-sweep.position.x,target.z-sweep.position.z)<.35)target.x=room.bounds.max.x;
   await connected.Camera.lookAt(target);
  }
 }catch{toast('This room could not be reached from the current scan view.')}
}
async function saveTourView(){
 const connected=sdk;if(!connected)return;$('snapshotButton').disabled=true;
 try{const uri=await connected.Renderer.takeScreenShot({width:1600,height:1000},{mattertags:false,measurements:false,sweeps:false,views:false});if(connected!==sdk)return;const a=document.createElement('a');a.href=uri;a.download='scout-interior-view.jpg';a.click();toast('Saved the current Matterport view.')}catch{toast('This view could not be saved.')}finally{$('snapshotButton').disabled=!sdk?.Renderer?.takeScreenShot}
}
async function autoWalkthrough(){
 if($('autoWalk').textContent==='Stop walkthrough'){walkRun++;$('autoWalk').textContent='Auto walkthrough';return}
 if(!sdk)return;const run=++walkRun,session=tourSession;
 const rooms=sdkRooms.filter(r=>sweepForRoom(r,sdkSweeps));$('autoWalk').textContent='Stop walkthrough';
 for(const room of rooms){
  if(run!==walkRun||session!==tourSession)break;
  await jumpToRoom(room.id);if(run!==walkRun||session!==tourSession)break;
  $('roomStatus').textContent='Auto walkthrough · '+(room.label||'Room')+' · uses captured scan positions';
  await new Promise(resolve=>setTimeout(resolve,1800));
 }
 if(session===tourSession){$('autoWalk').textContent='Auto walkthrough';renderTourRooms()}
}
function modelSummary(result){
 if(!result.ok)return '<span class="muted">'+escape(result.state||'Unavailable')+' · room measurements not loaded</span>';
 const m=result.model,rooms=m.rooms.filter(usableRoom);return (areaText(m.dimensions)?'<strong>'+areaText(m.dimensions)+' captured indoor area</strong><br>':'')+'<span class="muted">'+rooms.length+' room records · captured scan</span>'+rooms.filter(r=>areaText(r.dimensions)).slice(0,8).map((r,i)=>'<div class="room-compare-line">'+escape(r.label||'Room '+(i+1))+' <strong>'+areaText(r.dimensions)+'</strong></div>').join('');
}
function renderCompareLive(items){
 const tbody=$('comparisonContent').querySelector('tbody');if(!tbody)return;
 renderCompareAerial(items,tbody);
}
function renderDetailLive(p,plan){
 const body=$('detailContent').querySelector('.detail-body');if(!body)return;
 if(!plan.tours.length){renderDetailAerial(p,body);return}
 const section=document.createElement('section');section.className='live-data-section';section.innerHTML='<h3>Measured interior</h3><div id="detailModel" data-model="'+escape(plan.tours[0]?.id)+'" class="live-summary">Loading Matterport room details…</div><p>These dimensions describe the scan, which may be a representative unit. They are separate from the listing’s reported floor area.</p>';body.insertBefore(section,[...body.children].find(x=>x.tagName==='H3')||null);
 const initialId=plan.tours[0]?.id;selectPlanScan(plan).then(async tour=>{const result=await loadModel(tour.id),node=$('detailModel');if(node?.dataset.model===initialId){node.dataset.model=tour.id;node.innerHTML=modelSummary(result)}});
 renderDetailAerial(p,body);
}
let aerialCache=new Map(),aerialJobs=new Map(),aerialVerified=new Set();
async function loadCoverage(p){
 if(aerialCache.has(p.id))return aerialCache.get(p.id);
 if(config.preview)return {ok:false,state:'Server required'};
 if(!aerialJobs.has(p.id))aerialJobs.set(p.id,fetch('/api/coverage?id='+p.id).then(r=>r.json()).catch(()=>({ok:false,state:'Connection failed'})).then(r=>{if(r.ok)aerialCache.set(p.id,r);aerialJobs.delete(p.id);return r}));
 return aerialJobs.get(p.id);
}
function captureWindow(c){const first=c.firstCapture?.slice(0,10),last=c.lastCapture?.slice(0,10);return first&&last?first===last?first:first+' to '+last:first||last||'Capture dates not reported'}
function preferredCollection(coverage){return latestAerialCollection(coverage.collections)}
function imageUrl(id,collection,context=false){return '/api/aerial?id='+id+'&collection='+encodeURIComponent(collection.id)+(context?'&context=1':'')}
function imageryLoaded(p){aerialVerified.add(p.id);showConnections(connectionRows)}
let aerialGallerySequence=0;
function imageryError(img){
 const box=document.createElement('div');box.className='aerial-error';
 const note=document.createElement('p');note.textContent='This image couldn’t load.';
 const retry=document.createElement('button');retry.className='text-button';retry.type='button';retry.textContent='Try again';
 retry.onclick=()=>{const next=document.createElement('img');next.className=img.className;next.dataset.vexcelImage=img.dataset.vexcelImage;next.src=img.src;next.alt=img.alt;box.replaceWith(next);bindAerialImages(next.parentElement)};
 box.append(note,retry);img.replaceWith(box);
}
function aerialMarkup(p,coverage,compact=false){
 if(!coverage.ok)return '<p class="live-loading">Vexcel imagery: '+escape(coverage.state||'Unavailable')+'.</p>';
 const selected=preferredCollection(coverage);
 if(!selected)return '<p class="live-loading">No imagery collections were returned for this location.</p>';
 const galleryId='aerialGallery'+(++aerialGallerySequence);
 const tiles=[{title:'Property',context:false,description:'Closer view'},{title:'Wider surroundings',context:true,description:'More of the neighborhood'}];
 return '<section class="aerial-gallery '+(compact?'compact':'')+'" aria-label="Latest aerial imagery of '+escape(p.name)+'"><div class="aerial-gallery-heading"><strong>Latest available</strong><div class="aerial-switch" role="group" aria-label="Aerial framing"><button class="text-button" data-aerial-tile="0" aria-controls="'+galleryId+'" aria-pressed="true">Property</button><button class="text-button" data-aerial-tile="1" aria-controls="'+galleryId+'" aria-pressed="false">Wider area →</button></div></div><div id="'+galleryId+'" class="aerial-track" tabindex="0" aria-label="Scroll between property and wider surroundings">'+tiles.map(tile=>'<figure class="aerial-tile"><figcaption><strong>'+tile.title+'</strong><span>'+tile.description+'</span></figcaption><img class="'+(compact?'compare-aerial':'aerial-image')+'" data-vexcel-image="'+p.id+'" src="'+imageUrl(p.id,selected,tile.context)+'" alt="'+(tile.context?'Wider Vexcel aerial surroundings of ':'Vexcel aerial property view of ')+escape(p.name)+'" decoding="async"></figure>').join('')+'</div><p class="live-summary">Capture window: '+escape(captureWindow(selected))+(selected.gsd?' · '+(selected.gsd*100).toFixed(1)+' cm source imagery':'')+'. © Vexcel Imaging.</p><p class="aerial-location-note">Both views use the most recent returned collection. The crosshair marks the property coordinate, not a particular apartment.'+(compact?'':' Capture dates describe the collection window. Imagery does not establish current condition, noise or safety.')+'</p></section>';
}
function bindAerialImages(root){
 root.querySelectorAll('[data-vexcel-image]').forEach(img=>{if(img.dataset.bound)return;img.dataset.bound='true';img.addEventListener('load',()=>imageryLoaded(propertyMap.get(Number(img.dataset.vexcelImage))),{once:true});img.addEventListener('error',()=>imageryError(img),{once:true});if(img.complete&&img.naturalWidth)imageryLoaded(propertyMap.get(Number(img.dataset.vexcelImage)))});
 root.querySelectorAll('.aerial-gallery').forEach(gallery=>{
  if(gallery.dataset.bound)return;gallery.dataset.bound='true';const track=gallery.querySelector('.aerial-track');
  const update=()=>{const tiles=[...track.children],nearest=tiles.reduce((best,tile,index)=>Math.abs(tile.offsetLeft-track.scrollLeft)<Math.abs(tiles[best].offsetLeft-track.scrollLeft)?index:best,0);gallery.querySelectorAll('[data-aerial-tile]').forEach(button=>button.setAttribute('aria-pressed',String(Number(button.dataset.aerialTile)===nearest)))};
  track.addEventListener('scroll',update,{passive:true});
  gallery.querySelectorAll('[data-aerial-tile]').forEach(button=>button.onclick=()=>{const tile=track.children[Number(button.dataset.aerialTile)];track.scrollTo({left:tile.offsetLeft,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'})});
 });
}
let surroundingsSequence=0;
function mountSurroundings(root,p,compact=false){
 const links=streetViewLinks(p,config.googleMapsEmbedKey),id='surroundings'+(++surroundingsSequence);
 root.innerHTML='<section class="surroundings '+(compact?'compact':'')+'" aria-label="Surroundings of '+escape(p.name)+'"><div class="surroundings-tabs" role="tablist" aria-label="Exterior view"><button type="button" role="tab" id="'+id+'StreetTab" aria-controls="'+id+'Street" data-exterior="street">Street view</button><button type="button" role="tab" id="'+id+'AerialTab" aria-controls="'+id+'Aerial" data-exterior="aerial">Aerial</button></div><div role="tabpanel" id="'+id+'Street" aria-labelledby="'+id+'StreetTab" data-exterior-panel="street" tabindex="0" hidden></div><div role="tabpanel" id="'+id+'Aerial" aria-labelledby="'+id+'AerialTab" data-exterior-panel="aerial" tabindex="0" hidden></div></section>';
 const street=root.querySelector('[data-exterior-panel="street"]'),aerial=root.querySelector('[data-exterior-panel="aerial"]');
 let streetStarted=false,aerialStarted=false;
 const show=mode=>{
  root.querySelectorAll('[data-exterior]').forEach(button=>{const active=button.dataset.exterior===mode;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1});
  street.hidden=mode!=='street';aerial.hidden=mode!=='aerial';
  if(mode==='street'&&!streetStarted){
   streetStarted=true;
   if(links?.embed){
    const frame=document.createElement('iframe');frame.className='street-view-frame';frame.title='Google Street View near '+p.name;frame.src=links.embed;frame.loading='lazy';frame.allowFullscreen=true;frame.referrerPolicy='strict-origin-when-cross-origin';
    const locationBar=document.createElement('div');locationBar.className='street-property';
    const identity=document.createElement('div');
    const propertyName=document.createElement('strong');propertyName.textContent=p.name;
    const propertyAddress=document.createElement('span');propertyAddress.textContent=links.address;
    identity.append(propertyName,propertyAddress);
    const locate=document.createElement('button');locate.type='button';locate.className='street-locate';locate.textContent='Locate property';locate.setAttribute('aria-pressed','false');
    let locating=false;
    locate.onclick=()=>{
     locating=!locating;frame.src=locating?links.placeEmbed:links.embed;
     frame.title=(locating?'Google Maps property location for ':'Google Street View near ')+p.name;
     locate.textContent=locating?'Back to street view':'Locate property';locate.setAttribute('aria-pressed',String(locating));
     note.textContent=locating?'The pin shows Google’s address match for the property, not an individual apartment.':'Street View shows a nearby camera location; its street label may differ from the property address above.';
    };
    locationBar.append(identity,locate);street.append(locationBar,frame);
    const footer=document.createElement('div');footer.className='street-view-footer';
    const note=document.createElement('p');note.textContent='Street View shows a nearby camera location; its street label may differ from the property address above.';
    const action=document.createElement('button');action.type='button';action.className='text-button';action.textContent='No street imagery? View aerial';action.onclick=()=>show('aerial');
    footer.append(note,action);street.append(footer);
   }else{
    street.innerHTML='<div class="street-view-placeholder"><svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 28s9-8 9-16a9 9 0 1 0-18 0c0 8 9 16 9 16Z"/><circle cx="16" cy="12" r="3"/></svg><strong>A feel for the neighborhood.</strong><p>'+(links?'Explore the streets around '+escape(p.name)+' in Google Maps.':'Street imagery is unavailable for this location.')+'</p></div>';
   }
   if(links){const link=document.createElement('a');link.className='street-view-link';link.href=links.external;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open Street View in Google Maps ↗';street.append(link)}
  }
  if(mode==='aerial'&&!aerialStarted){
   aerialStarted=true;aerial.innerHTML='<p class="live-loading">Loading aerial imagery…</p>';
   loadCoverage(p).then(coverage=>{if(!root.isConnected)return;aerial.innerHTML=aerialMarkup(p,coverage,compact);bindAerialImages(aerial)});
  }
 };
 const tabs=[...root.querySelectorAll('[data-exterior]')];
 tabs.forEach((button,index)=>{
  button.onclick=()=>show(button.dataset.exterior);
  button.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length;show(tabs[next].dataset.exterior);tabs[next].focus()};
 });
 show(links?.embed?'street':'aerial');
}
function renderCompareAerial(items,tbody){
 const row=document.createElement('tr');row.innerHTML='<th scope="row">SITE & SURROUNDINGS</th>'+items.map(({property:p})=>'<td><div id="aerialCompare'+p.id+'" class="aerial-block"></div></td>').join('');tbody.insertBefore(row,[...tbody.rows].find(r=>r.querySelector('th')?.textContent==='BUILDING')||null);
 for(const {property:p} of items){const node=$('aerialCompare'+p.id);if(node)mountSurroundings(node,p,true)}
}
function renderDetailAerial(p,body){
 const section=document.createElement('section');section.className='live-data-section aerial-block';section.innerHTML='<h3>Site & surroundings</h3><div class="detail-surroundings"></div>';body.insertBefore(section,[...body.children].find(x=>x.tagName==='H3')||null);
 mountSurroundings(section.querySelector('.detail-surroundings'),p);
}
