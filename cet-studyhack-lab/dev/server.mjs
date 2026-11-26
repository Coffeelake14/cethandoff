// Local manual runs serve real learning materials and close cloud-dependent
// actions without a deployment. Only automated tests opt into fixture output.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppHandler } from '../functions/handler.mjs';
import { AI_ACTIONS } from '../functions/gate.mjs';

const ROOT = fileURLToPath(new URL('../web', import.meta.url));
const PORT = Number(process.env.PORT || 4318);
const fixtures = process.argv.includes('--test-fixtures');
const fixtureFeatures = Object.fromEntries(AI_ACTIONS.map(action => [action, true]));
const options = {};
if (fixtures) {
  const { createFakeCloud } = await import('./fake-cloud.mjs');
  process.env.CET_SCAN_MODEL = 'fixture-model';
  options.cloud = createFakeCloud();
  options.gate = {
    features: fixtureFeatures,
    requiresVisitor: false,
    authorize: async () => ({ ok: true }),
    admit: async () => ({ ok: true, async settle() {} }),
  };
}
const handler = createAppHandler(options);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

async function toWebRequest(req, signal) {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(',') : String(v));
  let body = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = Buffer.concat(chunks);
  }
  return new Request(`http://${host}${req.url}`, { method: req.method, headers, body, signal });
}

async function sendWebResponse(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(response.status, headers);
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
    } catch { /* client gone */ }
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${PORT}`).pathname);
    if (pathname.startsWith('/functions/v1/app')) {
      const controller = new AbortController();
      res.once('close', () => { if (!res.writableEnded) controller.abort(); });
      const response = await handler(await toWebRequest(req, controller.signal));
      await sendWebResponse(res, response);
      return;
    }
    const filePath = resolve(ROOT, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!filePath.startsWith(ROOT + sep)) { res.writeHead(403); res.end('Forbidden'); return; }
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (err) {
    if (err?.code === 'ENOENT') { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); }
    else { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Server error'); }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  console.log(`StudyHack ${fixtures ? 'automated fixtures' : 'local'}: http://127.0.0.1:${address.port}/`);
});