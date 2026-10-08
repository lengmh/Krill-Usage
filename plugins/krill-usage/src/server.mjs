import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './register.mjs';
import { UsageService } from './service.mjs';
import { createPreferences } from './preferences.mjs';
import { createCredentialStore, defaultStateDir } from './credentials.cjs';

async function main() {
  const preferences = createPreferences(defaultStateDir());
  const service = new UsageService({credentials:createCredentialStore(), preferences});
  const html = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'app.html'),'utf8');
  const server = createServer({service,preferences,html});
  const shutdown = async () => { service.dispose(); await server.close(); };
  process.once('SIGINT',()=>void shutdown()); process.once('SIGTERM',()=>void shutdown());
  process.stdin.once('end',()=>void shutdown());
  await server.connect(new StdioServerTransport());
}
main().catch(()=>{ process.stderr.write('Krill Usage could not start. Check the local installation and settings.\n'); process.exitCode=1; });
