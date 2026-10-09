import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
test('built server negotiates stdio and serves packaged HTML without credentials',async()=>{
 const home=mkdtempSync(path.join(tmpdir(),'krill-built-'));const client=new Client({name:'packaged-fixture-client',version:'1.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/server.js')],cwd:process.cwd(),env:{...process.env,HOME:home,USERPROFILE:home,LOCALAPPDATA:home,XDG_STATE_HOME:home},stderr:'pipe'});
 let stderr='';transport.stderr?.on('data',data=>stderr+=data.toString());
 try {await client.connect(transport);const listed=await client.listTools();assert.ok(listed.tools.some(t=>t.name==='krill.panel'));
 const resources=await client.listResources();assert.equal(resources.resources.length,1);const resource=await client.readResource({uri:resources.resources[0].uri});
 assert.ok(resource.contents[0].text.startsWith('<!doctype html>'));assert.ok(!resource.contents[0].text.includes('synthetic-account'));assert.equal(stderr,'');
 }finally{await client.close();await transport.close();rmSync(home,{recursive:true,force:true});}
});
test('built credential CLI help does not initialize the native vault',()=>{
 const result=execFileSync(process.execPath,['dist/credential-cli.cjs','--help'],{encoding:'utf8',stdio:['pipe','pipe','pipe']});assert.equal(result,'');
});
