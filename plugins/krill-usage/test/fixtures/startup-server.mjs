import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../../src/register.mjs';
import { startupFixture } from './startup-service.mjs';

const fixture = startupFixture();
const server = createServer({ ...fixture, html: '<!doctype html><title>Synthetic startup fixture</title>' });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await server.close();
  process.stderr.write(JSON.stringify({ vaultReads: fixture.calls.vaultReads, requests: fixture.calls.requests.length }) + '\n');
  fixture.close();
}
process.stdin.once('end', () => void shutdown());
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
await server.connect(new StdioServerTransport());
