// Probe the PowerShell input helper directly.
//
// The helper is a string inside system-pointer.ts, so this extracts it from the
// built output and drives it over stdin the same way the app does. Added because
// the keyboard, bounds and focus commands are C# inside a raw string: a mistake
// there is invisible until the helper fails at runtime.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'packages/desktop/dist/main/system-pointer.js');
const source = await readFile(dist, 'utf8');

// tsc emits `String.raw \`` with a space before the backtick, so match loosely.
const match = /String\.raw\s*`/.exec(source);
if (!match) throw new Error('helper source not found in ' + dist);
const bodyStart = match.index + match[0].length;
// The first backtick after the opening one closes the raw string. The C# inside
// must not contain a backtick; this probe is what proves it does not.
const end = source.indexOf('`', bodyStart);
if (end < 0) throw new Error('unterminated helper source in ' + dist);
const script = source.slice(bodyStart, end);

const scriptPath = path.join(root, 'packages/desktop/dist/main/.helper-probe.ps1');
await writeFile(scriptPath, script, 'utf8');

const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => {
  out += d.toString();
  process.stdout.write(d);
});
child.stderr.on('data', (d) => process.stderr.write(d));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(2500);
if (!out.includes('READY')) {
  console.log('\nNO READY - helper did not start.');
  child.kill();
  process.exit(1);
}

// Grab needs a pid argument; 0 is fine, it only excludes that pid's windows.
child.stdin.write('G 0\n');
await wait(900);
const hwnd = (/^W (\d+)/m.exec(out) || [])[1] ?? null;
console.log('\n--- grabbed hwnd:', hwnd ?? (/NOWINDOW/.test(out) ? 'NOWINDOW' : 'no answer'));

if (hwnd) {
  child.stdin.write(`B ${hwnd}\n`);
  await wait(700);
  child.stdin.write(`F ${hwnd}\n`);
  await wait(300);
}
console.log('--- bounds answer present:', /BOUNDS \d+ \d+ -?\d+/.test(out));

// Typing goes into whatever has focus, so this probe deliberately does not send
// an X command: it would type into the user's foreground window. Pressing an
// arrow key is equally real. Only the key path is exercised, and only once the
// helper has been asked to focus the grabbed window above.
child.stdin.write('Y Escape\n');
await wait(300);

child.stdin.write('Q\n');
await wait(300);
child.kill();
