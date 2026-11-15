import {mkdtemp,readFile,mkdir,rm,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const version='26.10.4_webgl-1728-g1cd7e0997a',checksum='835c6879679d352ab5b9ee09b57757cbe1b2f269b712cc918fd82e2fff352d32';
const temporary=await mkdtemp(join(tmpdir(),'homefit-sdk-')),archive=join(temporary,'bundle.zip');
try{
 if(process.argv[2])await copyFile(process.argv[2],archive);
 else execFileSync('curl',['--fail','--location','--max-time','120','--output',archive,'https://static.matterport.com/showcase-sdk/bundle/'+version+'/showcase-bundle.zip'],{stdio:'inherit'});
 const bytes=await readFile(archive);if(createHash('sha256').update(bytes).digest('hex')!==checksum)throw Error('SDK archive checksum did not match the pinned release.');
 const target=new URL('../public/bundle/',import.meta.url);await mkdir(target,{recursive:true});execFileSync('unzip',['-q','-o',archive,'-d',target.pathname]);
 console.log('Installed official Matterport Bundle SDK '+version);
}finally{await rm(temporary,{recursive:true,force:true})}
