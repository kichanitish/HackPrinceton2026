import http from 'node:http';
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
  const request=new Request(url,{method:req.method,headers:req.headers});
  const response=await worker.fetch(request,process.env,{});
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:'An unexpected server error occurred'}))}
});
server.listen(port,'127.0.0.1',()=>console.log('HomeFit is ready at http://localhost:'+port));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
