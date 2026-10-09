import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createSettings } from '@openai/mcp-extensions/server';
import { z } from 'zod/v4';
import { preferenceSchema } from './preferences.mjs';
export const UI_URI = 'ui://krill-usage/dashboard-v1';
export function createServer({service, preferences, html}) {
  const server = new McpServer({name:'krill-usage', title:'Krill Usage', version:'0.1.4'});
  const readonly = {readOnlyHint:true, destructiveHint:false, openWorldHint:false};
  const localRead = {...readonly, openWorldHint:false};
  const result = (view, page) => {
    const {revision, values} = preferences.readSnapshot();
    return {content:[], structuredContent:{...(page ? {page}:{}), view, preferences:values, preferencesRevision:revision}};
  };
  const ui = (type) => ({ui:{resourceUri:UI_URI}, 'openai/ui':{entrypoints:[{type}]}});
  const fields = {
    refreshIntervalMinutes:{schema:preferenceSchema.shape.refreshIntervalMinutes,title:'刷新间隔（分钟）'},
    showBalance:{schema:preferenceSchema.shape.showBalance,title:'显示账户余额'},
    lowQuotaWarningPercent:{schema:preferenceSchema.shape.lowQuotaWarningPercent,title:'低额度警告阈值（%）'},
    lowQuotaCriticalPercent:{schema:preferenceSchema.shape.lowQuotaCriticalPercent,title:'严重低额度阈值（%）'}
  };
  createSettings(server).register({fields,
    layout:[{kind:'group',title:'显示与刷新',items:Object.keys(fields).map(property=>({kind:'property',property}))},
      {kind:'group',title:'账户',items:[{kind:'tool',tool:'krill.settings',title:'账户设置说明',description:'凭据只在本地系统凭据库中保存。'}]}],
    read:()=>preferences.read(), update:(set)=>preferences.update(set)
  });
  for (const [name,type,page,description] of [
    ['krill.usage','global','usage','Open Krill Usage and query subscription quota from the configured local account.'],
    ['krill.panel','thread','usage','Open Krill Usage beside this conversation.'],
    ['krill.settings','settings','settings','Open non-secret preferences and local credential setup instructions.']
  ]) server.registerTool(name,{title:'Krill Usage',description,inputSchema:z.object({}).strict(),annotations:page==='settings'?localRead:readonly,_meta:ui(type)},
    async()=>result(page==='settings'?await service.read():await service.refresh(),page));
  server.registerTool('krill.refresh',{title:'刷新额度',inputSchema:z.object({}).strict(),annotations:readonly,
    _meta:{ui:{visibility:['app']}}},async()=>result(await service.refresh()));
  server.registerTool('krill.read',{title:'读取面板状态',inputSchema:z.object({}).strict(),annotations:localRead,
    _meta:{ui:{visibility:['app']}}},async()=>result(await service.read()));
  server.registerTool('krill.updateSettings',{title:'保存显示设置',inputSchema:z.object({set:preferenceSchema.partial()}).strict(),
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['app']}}},async({set})=>{
      preferences.update(set); return result(await service.read());
    });
  server.registerResource('krill-usage-ui',UI_URI,{title:'Krill Usage',mimeType:'text/html;profile=mcp-app'},async()=>({contents:[{
    uri:UI_URI,mimeType:'text/html;profile=mcp-app',text:html,
    _meta:{ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}},
      'openai/ui':{preferredDisplayMode:'inline',availableDisplayModes:['inline','fullscreen']}}
  }]}));
  return server;
}
