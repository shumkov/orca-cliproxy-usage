import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const output = new URL('.orca/package/', root);
// Only this script's generated runtime package is replaced.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const path of ['orca-plugin.json', 'src', 'README.md', 'LICENSE', 'docs', 'assets']) {
  await cp(new URL(path, root), new URL(path, output), { recursive: true, filter: source => !source.includes('__pycache__') });
}
console.log(fileURLToPath(output));
