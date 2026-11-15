import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';

test('contact extraction preserves exact property roles, portfolio broker scope and display restrictions',()=>{
 execFileSync('python3',[new URL('./property-contacts.test.py',import.meta.url).pathname],{stdio:'pipe'});
});
const source=await readFile(new URL('../src/contacts.js',import.meta.url),'utf8');
const context=vm.createContext({escape:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),isCommercial:p=>p.mode==='commercial'});
vm.runInContext(source,context);
test('contact actions are escaped and phone/email links cannot become executable URLs',()=>{
 const html=vm.runInContext(`contactMarkup({role:'Listing broker',name:'<script>',company:'Business',phone:'+1 (555) 123-4567',extension:'42',email:'broker@example.com',phoneKind:'Company'})`,context);
 assert.ok(html.includes('&lt;script>'));assert.ok(html.includes('href="tel:+15551234567;ext=42"'));assert.ok(html.includes('href="mailto:broker@example.com"'));assert.ok(html.includes('company line'));
 const invalid=vm.runInContext(`contactMarkup({role:'Owner',email:'javascript:alert(1)',phone:'javascript:alert()'})`,context);
 assert.ok(!invalid.includes('href='));
});
test('summaries show two contacts, offer remaining details and keep missing roles explicit',()=>{
 context.property={id:1,contacts:[{role:'Owner',company:'First'},{role:'Recorded owner',company:'Second'},{role:'Owner',company:'Third'}]};
 const html=vm.runInContext(`contactSummary(property,'owner')`,context);
 assert.ok(html.includes('First'));assert.ok(html.includes('Second'));assert.ok(!html.includes('Third'));assert.ok(html.includes('All 3 ownership contacts'));
 assert.ok(vm.runInContext(`contactSummary(property,'leasing')`,context).includes('Not reported'));
});
