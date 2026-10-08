import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer,UI_URI} from '../src/register.mjs';import {UsageService} from '../src/service.mjs';import {createPreferences,defaults} from '../src/preferences.mjs';
test('MCP discovery exposes native settings, all entrypoints, complete HTML and app-only refresh',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'krill-protocol-'));
 const preferences=createPreferences(dir);let requests=0;
 const service=new UsageService({preferences,credentials:{readRevision:async()=> 'fixture-v1',read:async()=> 'synthetic-only'},fetchUsage:async()=>{requests++;return{creditBalance:null,subscriptions:[]};}});
 const html=readFileSync('dist/app.html','utf8');const server=createServer({service,preferences,html});
 const client=new Client({name:'Krill fixture test',version:'1.0'});const [a,b]=InMemoryTransport.createLinkedPair();
 try{
 await server.connect(b);await client.connect(a);const tools=await client.listTools();
 for(const [name,type] of [['krill.usage','global'],['krill.panel','thread'],['krill.settings','settings']]){
 const tool=tools.tools.find(x=>x.name===name);assert.equal(tool._meta.ui.resourceUri,UI_URI);assert.deepEqual(tool._meta['openai/ui'].entrypoints,[{type}]);
 }
 for(const name of ['krill.usage','krill.panel','krill.refresh']){
 assert.deepEqual(tools.tools.find(x=>x.name===name).annotations,{readOnlyHint:true,destructiveHint:false,openWorldHint:false},name);
 }
 assert.deepEqual(tools.tools.find(x=>x.name==='krill.refresh')._meta.ui.visibility,['app']);
 assert.ok(client.getServerCapabilities().experimental['openai/settings']);
 const native=await client.callTool({name:'settings.read',arguments:{}});assert.equal(native.structuredContent.values.refreshIntervalMinutes,3);
 assert.deepEqual(native.structuredContent.values,defaults);
 assert.ok(!JSON.stringify(native).includes('jwt'));
 const update=await client.callTool({name:'settings.update',arguments:{set:{refreshIntervalMinutes:5}}});assert.equal(update.structuredContent.values.refreshIntervalMinutes,5);assert.equal(update.structuredContent.values.showBalance,true);
 assert.deepEqual(update.structuredContent.values,{...defaults,refreshIntervalMinutes:5});
 const rejected=await client.callTool({name:'settings.update',arguments:{set:{jwt:'synthetic'}}});assert.equal(rejected.isError,true);
 const revisionRejected=await client.callTool({name:'settings.update',arguments:{set:{revision:99}}});assert.equal(revisionRejected.isError,true);
 const usage=await client.callTool({name:'krill.usage',arguments:{}});assert.equal(usage.structuredContent.view.snapshot.creditBalance,null);assert.equal(requests,1);
 assert.equal(usage.structuredContent.preferencesRevision,1);assert.deepEqual(usage.structuredContent.preferences,update.structuredContent.values);
 await client.callTool({name:'krill.refresh',arguments:{}});assert.equal(requests,2);
 const read=await client.callTool({name:'krill.read',arguments:{}});assert.equal(requests,2);assert.ok(!JSON.stringify(read).includes('synthetic-only'));
 const resource=await client.readResource({uri:UI_URI});assert.equal(resource.contents[0].mimeType,'text/html;profile=mcp-app');assert.ok(resource.contents[0].text.includes('<script>'));assert.ok(!resource.contents[0].text.includes('localhost:'));
 assert.deepEqual(resource.contents[0]._meta.ui.csp,{connectDomains:[],resourceDomains:[]});
 }finally{service.dispose();await client.close();await server.close();rmSync(dir,{recursive:true,force:true});}
});
