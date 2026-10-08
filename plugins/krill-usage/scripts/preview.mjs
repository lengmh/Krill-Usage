/** Build a self-contained, synthetic UI harness; excluded from plugin packaging. */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const compiled = await build({ entryPoints: [path.join(root, 'test/fixtures/preview-bridge.mjs')], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', legalComments: 'none' });
const css = await fs.readFile(path.join(root, 'src/app.css'), 'utf8');
const script = compiled.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Krill Usage · Synthetic component preview</title><style>${css}</style></head><body><div id="app" data-manual-mount></div><script type="module">${script}</script></body></html>`;
await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
await fs.writeFile(path.join(root, 'artifacts/preview.html'), html);
console.log(path.join(root, 'artifacts/preview.html'));
