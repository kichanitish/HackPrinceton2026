import http from 'node:http';
import {access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import worker from '../dist/server/index.js';
import {createScoutHandler} from './server.mjs';

const bundleRoot=fileURLToPath(new URL('../public/bundle/',import.meta.url));
await access(new URL('../public/bundle/version.txt',import.meta.url));
const port=Number(process.env.PORT||4317),host=process.env.HOST||'0.0.0.0';
if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid PORT');
const server=http.createServer(createScoutHandler({worker,bundleRoot}));
server.requestTimeout=90000;
server.listen(port,host,()=>console.log('Scout is listening on port '+port));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.close(()=>process.exit(0));server.closeIdleConnections()});
