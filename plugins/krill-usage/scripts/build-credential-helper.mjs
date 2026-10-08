import { stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const BUILD_MESSAGE = 'Secure Windows JWT entry requires installed .NET Framework 4.8 or later, its csc.exe compiler, and WPF assemblies. Install or repair .NET Framework through Microsoft/Windows, then rebuild. No compiler or runtime is downloaded by this build.';
async function isFile(file) { try { return (await stat(file)).isFile(); } catch { return false; } }

export async function compileCredentialHelper({ output, sources = ['native/CredentialPrompt.cs'], main = 'KrillUsage.CredentialProgram', target = 'winexe' }) {
  if (process.platform !== 'win32') return false;
  const windows = process.env.SystemRoot;
  if (!windows || !path.isAbsolute(windows)) throw new Error(BUILD_MESSAGE);
  let installed = false;
  try {
    const registry = execFileSync(path.join(windows, 'System32', 'reg.exe'), [
      'query', 'HKLM\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full', '/v', 'Release', '/reg:64'
    ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const release = /Release\s+REG_DWORD\s+(0x[0-9a-f]+)/iu.exec(registry);
    installed = release !== null && Number.parseInt(release[1], 16) >= 528040;
  } catch {}
  if (!installed) throw new Error(BUILD_MESSAGE);
  for (const framework of ['Framework64', 'Framework']) {
    const folder = path.join(windows, 'Microsoft.NET', framework, 'v4.0.30319');
    const compiler = path.join(folder, 'csc.exe');
    const references = [];
    for (const name of ['System.dll', 'System.Core.dll', 'System.Xaml.dll', 'PresentationFramework.dll', 'PresentationCore.dll', 'WindowsBase.dll']) {
      const candidates = [path.join(folder, name), path.join(folder, 'WPF', name)];
      const found = await Promise.all(candidates.map(isFile));
      if (found.some(Boolean)) references.push(candidates[found.indexOf(true)]);
    }
    if (!(await isFile(compiler)) || references.length !== 6) continue;
    try {
      execFileSync(compiler, ['/nologo', '/noconfig', '/optimize+', '/debug-', '/platform:anycpu', `/target:${target}`,
        `/main:${main}`, `/out:${path.resolve(output)}`, ...references.map(file => `/reference:${file}`), ...sources.map(file => path.resolve(file))],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      // Compiler diagnostics describe only checked-in source, never a credential.
      const diagnostic = [error.stdout, error.stderr].filter(Boolean).map(bytes => bytes.toString()).join('\n');
      throw new Error('The bundled credential window failed to compile. Check native/CredentialPrompt.cs and installed .NET Framework/WPF build prerequisites.\n' + diagnostic);
    }
    return true;
  }
  throw new Error(BUILD_MESSAGE);
}
