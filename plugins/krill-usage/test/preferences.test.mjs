import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
import {createPreferences,defaults} from '../src/preferences.mjs';
test('persists only allowlisted nonsecret settings with numeric bounds',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'krill-prefs-'));try{
 const prefs=createPreferences(dir);assert.deepEqual(prefs.read(),defaults);
 prefs.update({refreshIntervalMinutes:5,showBalance:false});assert.equal(createPreferences(dir).read().showBalance,false);
 assert.throws(()=>prefs.update({jwt:'synthetic'}));assert.throws(()=>prefs.update({refreshIntervalMinutes:0}));assert.throws(()=>prefs.update({refreshIntervalMinutes:1.2}));
 assert.ok(!readFileSync(path.join(dir,'preferences.json'),'utf8').includes('synthetic'));
 assert.equal(prefs.read().lowQuotaWarningPercent,15);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('native settings cannot persist critical threshold above warning',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'krill-prefs-'));try{
 const prefs=createPreferences(dir);assert.throws(()=>prefs.update({lowQuotaCriticalPercent:50}));
 assert.deepEqual(prefs.read(),defaults);
 prefs.update({lowQuotaWarningPercent:60,lowQuotaCriticalPercent:50});assert.equal(prefs.read().lowQuotaCriticalPercent,50);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('separate plugin processes preserve omitted fields and observe native changes',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'krill-prefs-'));try{
 const first=createPreferences(dir),second=createPreferences(dir);first.update({showBalance:false});
 assert.equal(second.read().showBalance,false);second.update({refreshIntervalMinutes:7});
 assert.equal(first.read().showBalance,false);assert.equal(first.read().refreshIntervalMinutes,7);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
