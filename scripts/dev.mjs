import http from 'node:http';
import {readFile,realpath} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {existsSync} from 'node:fs';
import {watch} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
// Local .env is optional and ignored by Git. Hosted deployments use Sites secrets.
if(existsSync(root+'.env'))process.loadEnvFile(root+'.env');
if(process.argv.includes('--secrets-stdin')){
 console.log('Ready for credentials on stdin (input is hidden).');
 process.stdin.setRawMode?.(true);process.stdin.resume();
 const input=await new Promise(resolve=>{let all='';process.stdin.on('data',function read(chunk){all+=chunk.toString();if(all.includes('\n')){process.stdin.off('data',read);resolve(all.trim())}})});
 Object.assign(process.env,JSON.parse(input));process.stdin.setRawMode?.(false);process.stdin.pause();
}
execFileSync(process.execPath,['scripts/build.mjs'],{cwd:root,stdio:'inherit'});
let worker=(await import(new URL('../dist/server/index.js',import.meta.url))).default;
// Rebuild source changes without requiring repeated manual restarts.
let refreshTimer;
for(const dir of ['src','worker','data'])watch(root+dir,{recursive:true},()=>{
 clearTimeout(refreshTimer);refreshTimer=setTimeout(async()=>{
  try{execFileSync(process.execPath,['scripts/build.mjs'],{cwd:root,stdio:'inherit'});worker=(await import(new URL('../dist/server/index.js?revision='+Date.now(),import.meta.url))).default;console.log('HomeFit updated. Refresh your browser.');}
  catch{console.log('Build failed. The previous working version is still running.');}
 },150);
});
const port=Number(process.env.PORT||4317);
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost:'+port);
  if(url.pathname.startsWith('/bundle/')){
   try{
    const base=resolve(root,'public'),file=await realpath(resolve(base,'.'+decodeURIComponent(url.pathname)));
    if(!file.startsWith(base+sep)||!['GET','HEAD'].includes(req.method)){res.writeHead(403);res.end();return}
    const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.gql':'text/plain','.wasm':'application/wasm','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff':'font/woff','.woff2':'font/woff2','.txt':'text/plain'};
    const bytes=await readFile(file);res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream','cache-control':'public, max-age=3600','x-content-type-options':'nosniff'});res.end(req.method==='HEAD'?undefined:bytes);return;
   }catch{res.writeHead(404);res.end('Bundle asset unavailable. Run npm run sdk:install.');return}
  }
  const hasBody=!['GET','HEAD'].includes(req.method);
  let body;if(hasBody){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>4096){res.writeHead(413,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,code:'invalid'}));return}chunks.push(chunk)}body=Buffer.concat(chunks)}
  const controller=new AbortController();req.on('aborted',()=>controller.abort());res.on('close',()=>{if(!res.writableEnded)controller.abort()});
  const request=new Request(url,{method:req.method,headers:req.headers,signal:controller.signal,...(hasBody?{body}:{} )});
  const response=await worker.fetch(request,process.env,{});
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:'An unexpected server error occurred'}))}
});
server.listen(port,'127.0.0.1',()=>console.log('HomeFit is ready at http://localhost:'+port));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
