export function featureList(data){return Array.isArray(data?.features)?data.features:[]}
export function collectionSummary(feature){
 const p=feature.properties||{};
 return {id:p.collection,layer:p.layer,firstCapture:p['first-capture-date']||null,lastCapture:p['last-capture-date']||null,gsd:p['min-gsd']??null,maxZoom:p['max-zoom']??null,name:p['pretty-name']||p.collection};
}
export function geometryFromWkt(input){
 if(input&&typeof input==='object')return input;
 if(typeof input!=='string')return null;
 const match=input.trim().match(/^(POLYGON|MULTIPOLYGON)\s*(\(.*\))$/i);if(!match)return null;
 try{
  const nested=match[2].replace(/(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi,'[$1,$2]').replace(/\(/g,'[').replace(/\)/g,']');
  return {type:match[1].toUpperCase()==='POLYGON'?'Polygon':'MultiPolygon',coordinates:JSON.parse(nested)};
 }catch{return null}
}
function inRing(point,ring){
 let inside=false;const [x,y]=point;
 for(let i=0,j=ring.length-1;i<ring.length;j=i++){
  const [xi,yi]=ring[i],[xj,yj]=ring[j];
  if(Math.abs((x-xi)*(yj-yi)-(y-yi)*(xj-xi))<1e-10&&x>=Math.min(xi,xj)&&x<=Math.max(xi,xj)&&y>=Math.min(yi,yj)&&y<=Math.max(yi,yj))return true;
  if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside;
 }return inside;
}
export function coversPoint(geometry,point){
 const g=geometryFromWkt(geometry);if(!g)return false;
 const polygons=g.type==='Polygon'?[g.coordinates]:g.type==='MultiPolygon'?g.coordinates:[];
 return polygons.some(rings=>rings.length&&inRing(point,rings[0])&&!rings.slice(1).some(h=>inRing(point,h)));
}
export async function propertyCoverage(env,property,rpc=vexcelRpc){
 const result=await rpc(env,'ortho_imagery_collections',{wkt:'POINT('+property.lng+' '+property.lat+')',srid:4326,layer:['urban','wide-area'],include:['layer','collection','first-capture-date','last-capture-date','min-gsd','max-zoom','pretty-name'],'order-by':['last-capture-date-desc'],'page-size':20});
 if(!result.ok)return result;
 const collections=featureList(result.data).map(collectionSummary).filter(x=>x.id&&x.layer).sort((a,b)=>String(b.lastCapture||'').localeCompare(String(a.lastCapture||'')));
 return {ok:true,propertyId:property.id,available:collections.length>0,collections,checkedAt:new Date().toISOString(),source:'Vexcel point coverage query'};
}
export async function catalogCoverage(env,properties,rpc=vexcelRpc){
 const cities=[...new Set(properties.map(p=>p.city))],results=[];
 for(const city of cities){
  const points=properties.filter(p=>p.city===city),xs=points.map(p=>p.lng),ys=points.map(p=>p.lat);
  const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const wkt='POLYGON(('+minX+' '+minY+','+maxX+' '+minY+','+maxX+' '+maxY+','+minX+' '+maxY+','+minX+' '+minY+'))';
  const result=await rpc(env,'ortho_imagery_collections',{wkt,srid:4326,layer:['urban','wide-area'],include:['layer','collection','first-capture-date','last-capture-date','geometry','min-gsd'],'order-by':['last-capture-date-desc'],'total-records':8,'page-size':8});
  if(!result.ok){results.push({city,ok:false,state:result.state,total:points.length,covered:0,unverified:points.length,propertyIds:[]});continue}
  const features=featureList(result.data),parsed=features.map(f=>({summary:collectionSummary(f),geometry:geometryFromWkt(f.geometry)}));
  const covered=points.filter(p=>parsed.some(f=>coversPoint(f.geometry,[p.lng,p.lat])));
  results.push({city,ok:true,total:points.length,covered:covered.length,unverified:points.length-covered.length,propertyIds:covered.map(p=>p.id),collections:parsed.map(f=>f.summary),geometryRecords:parsed.filter(f=>f.geometry).length});
 }
 return {ok:results.some(x=>x.ok),checkedAt:new Date().toISOString(),total:properties.length,covered:results.reduce((n,x)=>n+x.covered,0),unverified:results.reduce((n,x)=>n+x.unverified,0),cities:results,method:'Catalog coordinates tested against returned imagery-collection footprints. Unmatched points are unverified, not confirmed unavailable. Image retrieval is verified separately.'};
}
export async function extractAerial(env,property,collection,context=false,rpc=vexcelRpc){
 return rpc(env,'ortho_extract',{wkt:'POINT('+property.lng+' '+property.lat+')',srid:4326,layer:[collection.layer],collection:[collection.id],'buffer-meter':context?200:85,'destination-dimensions':'900,900','image-format':'jpeg',attribution:true,crosshair:'POINT('+property.lng+' '+property.lat+')','crosshair-color':'rgb(255,255,255)','crosshair-line-width':2});
}
export function imagePayload(result){
 if(result.image?.data)return result.image;
 const d=result.data;
 if(typeof d==='string')return {data:d.replace(/^data:image\/\w+;base64,/,''),mimeType:d.startsWith('data:image/png')?'image/png':'image/jpeg'};
 for(const key of ['image','base64','image_base64','data']){
  const value=d?.[key];if(typeof value==='string'&&value.length>200)return {data:value.replace(/^data:image\/\w+;base64,/,''),mimeType:d.mimeType||d.mime_type||'image/jpeg'};
 }return null;
}
