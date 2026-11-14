import {checkCapabilities} from '../worker/api.mjs';
import {writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
if(existsSync('.env'))process.loadEnvFile('.env');
if(process.argv.includes('--secrets-stdin')){
 console.log('Ready for credentials on stdin (input is hidden).');process.stdin.setRawMode?.(true);process.stdin.resume();
 const input=await new Promise(resolve=>{let text='';process.stdin.on('data',function read(chunk){text+=chunk;if(text.includes('\n')){process.stdin.off('data',read);resolve(text.trim())}})});
 Object.assign(process.env,JSON.parse(input));process.stdin.setRawMode?.(false);process.stdin.pause();
}
const result=await checkCapabilities(process.env,'QAVsUEviwyK');
await writeFile('data/api-access.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
