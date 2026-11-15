import {readFile,mkdir,writeFile,rename,cp,access} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
let worker=await readFile(new URL('worker/index.js',root),'utf8');
let html=await readFile(new URL('src/index.html',root),'utf8');
const domain=(await readFile(new URL('src/domain.mjs',root),'utf8')).replace(/^export /gm,'');
const tour=(await readFile(new URL('src/tour.mjs',root),'utf8')).replace(/^export /gm,'');
const capabilities=(await readFile(new URL('src/capabilities.mjs',root),'utf8')).replace(/^export /gm,'');
const capabilityUI=await readFile(new URL('src/capabilities.js',root),'utf8');
const furniture=await readFile(new URL('src/furniture.js',root),'utf8');
const furnitureCore=(await readFile(new URL('src/furniture.mjs',root),'utf8')).replace(/^export /gm,'');
const surroundings=(await readFile(new URL('src/surroundings.mjs',root),'utf8')).replace(/^export /gm,'');
const live=await readFile(new URL('src/live.js',root),'utf8');
const client=(await readFile(new URL('src/app.js',root),'utf8')).replace('/*__DOMAIN__*/',()=>domain).replace('/*__TOUR__*/',()=>tour).replace('/*__LIVE__*/',()=>surroundings+'\n'+live).replace('/*__CAPABILITIES__*/',()=>capabilities+'\n'+capabilityUI).replace('/*__FURNITURE__*/',()=>furnitureCore+'\n'+furniture);
const css=await readFile(new URL('src/style.css',root),'utf8');
html=html.replace('/*__CSS__*/',()=>css).replace('/*__JS__*/',()=>client);
const api=(await readFile(new URL('worker/api.mjs',root),'utf8')).replace(/^export /gm,'');
const vexcel=(await readFile(new URL('worker/vexcel.mjs',root),'utf8')).replace(/^export /gm,'');
const catalog=await readFile(new URL('data/catalog.json',root),'utf8');
worker=worker.replace('/*__API__*/',()=>api+'\n'+vexcel);
worker=worker.replace('"__PAGE__"',()=>JSON.stringify(html)).replace('"__CATALOG__"',()=>catalog);
await mkdir(new URL('dist/server/',root),{recursive:true});await mkdir(new URL('dist/.openai/',root),{recursive:true});
async function atomicWrite(relative,value){const target=new URL(relative,root),temporary=new URL(relative+'.'+process.pid+'.tmp',root);await writeFile(temporary,value);await rename(temporary,target)}
await atomicWrite('dist/server/index.js',worker);await atomicWrite('dist/.openai/hosting.json',await readFile(new URL('.openai/hosting.json',root)));
// A dependency-free preview remains usable when the environment cannot run a server.
const standalone=html.replace('<script type="module">',()=>'<script>window.HOMEFIT_CATALOG='+catalog.replace(/<\/script/gi,'<\\/script')+';</script><script type="module">');
await atomicWrite('HomeFit.html',standalone);
console.log('Built HomeFit: '+(Buffer.byteLength(worker)/1024/1024).toFixed(2)+' MB');

try{await access(new URL('public/bundle/version.txt',root));await cp(new URL('public/bundle/',root),new URL('dist/client/bundle/',root),{recursive:true})}catch(error){if(error.code!=='ENOENT')throw error}
