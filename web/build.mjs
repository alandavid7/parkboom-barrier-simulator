// Bundles web/main.ts and everything it imports into one self-contained HTML file: dist/park-boom-simulator.html
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const out = await build({
  entryPoints: ['web/main.ts'], bundle: true, format: 'iife', target: 'es2022', minify: true, write: false,
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = (await readFile('web/index.html', 'utf8')).replace('/*__BUNDLE__*/', () => js);
await mkdir('dist', { recursive: true });
await writeFile('dist/park-boom-simulator.html', html);
console.log(`dist/park-boom-simulator.html  ${(html.length / 1024).toFixed(1)} KB`);
