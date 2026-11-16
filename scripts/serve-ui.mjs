import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const files = { '/': 'panel.html', '/panel.css': 'panel.css', '/panel.mjs': 'panel.mjs', '/quota.mjs': 'quota.mjs', '/json.mjs': 'json.mjs', '/presentation.mjs': 'presentation.mjs', '/provider-marks.mjs': 'provider-marks.mjs' };
createServer(async (request, response) => {
  const file = files[request.url];
  if (!file) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript');
  response.end(await readFile(new URL(`../src/${file}`, import.meta.url)));
}).listen(4179, '127.0.0.1');
