import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
for (const dir of ['src','scripts','test']) for (const file of readdirSync(dir)) {
  if (/\.(?:cjs|mjs|js)$/.test(file)) execFileSync(process.execPath,['--check',`${dir}/${file}`],{stdio:'inherit'});
}
console.log('Syntax checks passed.');
