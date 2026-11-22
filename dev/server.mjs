// DEV ONLY — local preview runner for the CET StudyHack reading lab + reference
// estimator. Serves web/ and routes /functions/v1/app to the REAL application
// handler (functions/handler.mjs) with a credential-free fake Cloud upstream
// that answers train / explain / grade / recommend (transfer comes from the
// real vetted bank). Exercises actual routing, validation, SSE projection and
// prompt building; only the QCA transport is simulated. Never deployed: the
// production Function uses the real cloud-agents client.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppHandler } from '../functions/handler.mjs';
import { __resetResourceCache } from '../functions/resources.mjs';
import { createFakeCloud } from './fake-cloud.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'web');
const PORT = Number(process.env.PORT || 4318);

const handler = createAppHandler({ cloud: createFakeCloud(), mode: 'local-fixture' });

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
      req.on('close', () => controller.abort());
      const response = await handler(await toWebRequest(req, controller.signal));
      await sendWebResponse(res, response);
      return;
    }
    let rel = normalize(pathname).replace(/^([/\\])+/, '');
    if (rel === '' || rel === '.') rel = 'index.html';
    const filePath = join(ROOT, rel);
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (err) {
    if (err?.code === 'ENOENT') { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); }
    else { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Server error'); }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  __resetResourceCache();
  console.log(`CET StudyHack lab local preview: http://127.0.0.1:${PORT}/`);
});