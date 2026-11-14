import test from 'node:test';
import assert from 'node:assert/strict';
import {geometryFromWkt,coversPoint,propertyCoverage,catalogCoverage,extractAerial,imagePayload} from '../worker/vexcel.mjs';
const polygon='POLYGON ((0 0,10 0,10 10,0 10,0 0),(3 3,7 3,7 7,3 7,3 3))';
test('coverage geometry respects holes and multipolygon islands',()=>{
 assert.equal(geometryFromWkt(polygon).type,'Polygon');
 assert.equal(coversPoint(polygon,[1,1]),true);assert.equal(coversPoint(polygon,[5,5]),false);assert.equal(coversPoint(polygon,[11,1]),false);
 const multi='MULTIPOLYGON (((0 0,1 0,1 1,0 1,0 0)),((3 3,4 3,4 4,3 4,3 3)))';
 assert.equal(coversPoint(multi,[3.5,3.5]),true);assert.equal(coversPoint(multi,[2,2]),false);
 assert.equal(coversPoint('broken',[1,1]),false);
});
test('a successful empty point query is distinct from product denial',async()=>{
 const property={id:1,lng:1,lat:1};
 assert.equal((await propertyCoverage({},property,async()=>({ok:true,data:{features:[]}}))).available,false);
 assert.equal((await propertyCoverage({},property,async()=>({ok:false,state:'Access denied'}))).state,'Access denied');
});
test('catalog audit uses footprints and marks unmatched points unverified',async()=>{
 const properties=[{id:1,city:'A',lng:1,lat:1},{id:2,city:'A',lng:5,lat:5},{id:3,city:'B',lng:20,lat:20}];
 const result=await catalogCoverage({},properties,async()=>({ok:true,data:{features:[{properties:{collection:'test',layer:'urban'},geometry:polygon}]}}));
 assert.equal(result.total,3);assert.equal(result.covered,1);assert.equal(result.unverified,2);assert.deepEqual(result.cities[0].propertyIds,[1]);
});
test('image extraction is bounded, attributed, and uses a returned collection',async()=>{
 let called;
 await extractAerial({}, {lng:-95,lat:29}, {id:'allowed-collection',layer:'urban'},false,async(env,name,args)=>{called={name,args};return {ok:true}});
 assert.equal(called.name,'ortho_extract');assert.equal(called.args.attribution,true);assert.deepEqual(called.args.collection,['allowed-collection']);assert.equal(called.args['destination-dimensions'],'900,900');assert.equal(called.args['buffer-meter'],85);
});
test('imagery supports MCP image blocks and JSON base64 payloads',()=>{
 assert.deepEqual(imagePayload({image:{data:'abc',mimeType:'image/jpeg'}}),{data:'abc',mimeType:'image/jpeg'});
 assert.equal(imagePayload({data:{image_base64:'a'.repeat(300)}}).data.length,300);
 assert.equal(imagePayload({data:{message:'Unavailable'}}),null);
});
