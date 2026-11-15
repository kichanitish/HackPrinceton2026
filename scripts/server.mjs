import {readFile,realpath} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';

const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.gql':'text/plain','.wasm':'application/wasm','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.woff':'font/woff','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8','.glb':'model/gltf-binary','.gltf':'model/gltf+json'};

export function createScoutHandler({worker,env=process.env,bundleRoot}){
 return async(req,res)=>{
  const fail=(status,code)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({ok:false,code}))};
  try{
   const trustProxy=env.TRUST_PROXY==='1'||env.RENDER==='true';
   const forwarded=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim();
   const protocol=trustProxy&&['http','https'].includes(forwarded)?forwarded:req.socket?.encrypted?'https':'http';
   const origin=new URL(protocol+'://'+(req.headers.host||'localhost'));
   if(origin.username||origin.password){fail(400,'invalid');return}
   const url=new URL(req.url,origin);
   if(url.origin!==origin.origin){fail(400,'invalid');return}
   if(url.pathname==='/healthz'){
    if(!['GET','HEAD'].includes(req.method)){fail(405,'method');return}
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(req.method==='HEAD'?undefined:JSON.stringify({ok:true,app:'Scout'}));return;
   }
   if(url.pathname.startsWith('/bundle/')){
    if(!['GET','HEAD'].includes(req.method)){fail(405,'method');return}
    try{
     const base=await realpath(bundleRoot),file=await realpath(resolve(base,'.'+decodeURIComponent(url.pathname.slice('/bundle'.length))));
     if(!file.startsWith(base+sep)){fail(403,'forbidden');return}
     const bytes=await readFile(file);
     res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream','cache-control':'public, max-age=3600','x-content-type-options':'nosniff'});
     res.end(req.method==='HEAD'?undefined:bytes);return;
    }catch{fail(404,'asset_unavailable');return}
   }
   let body;
   if(!['GET','HEAD'].includes(req.method)){
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>4096){fail(413,'invalid');return}chunks.push(chunk)}
    body=Buffer.concat(chunks);
   }
   const controller=new AbortController();req.on('aborted',()=>controller.abort());res.on('close',()=>{if(!res.writableEnded)controller.abort()});
   const request=new Request(url,{method:req.method,headers:req.headers,signal:controller.signal,...(body!==undefined?{body}:{})});
   const response=await worker.fetch(request,env,{});
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(req.method==='HEAD'?undefined:Buffer.from(await response.arrayBuffer()));
  }catch{if(!res.headersSent)fail(500,'unexpected');else res.end()}
 };
}
