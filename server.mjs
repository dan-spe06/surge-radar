// Local/preview server. Mirrors the Vercel API: /api/scan, /api/history?format=json|csv|summary, /api/report.
// If GITHUB_RAW is set, history is read from the GitHub repo (the always-on scanner); otherwise from ./local-data.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { scanAll } from './engine.mjs';
import { record } from './history.mjs';
const PUB = new URL('./public/', import.meta.url).pathname;
const LOCAL = new URL('./local-data/', import.meta.url).pathname;
const RAW = process.env.GITHUB_RAW || (fs.existsSync('.github-raw') ? fs.readFileSync('.github-raw', 'utf8').trim() : '');
let cache = null, busy = null;
async function getScan(force) {
  if (!force && cache && Date.now() - cache.at < 60000) return cache;
  if (!busy) busy = scanAll().then(s => (cache = s)).finally(() => (busy = null));
  return busy;
}
async function data(name) {
  if (RAW) { const r = await fetch(`${RAW}/${name}?t=${Date.now()}`); if (r.ok) return r.text(); }
  const f = path.join(LOCAL, name); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : (name.endsWith('csv') ? '' : name === 'history.json' ? '[]' : '{}');
}
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.css': 'text/css' };
http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const u = new URL(req.url, 'http://x'), p = u.pathname.replace(/^.*?(\/api\/)/, '/api/');
  try {
    if (p === '/api/scan') { const s = await getScan(u.searchParams.has('force')); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(s)); }
    if (p === '/api/history') {
      const f = { json: 'history.json', csv: 'history.csv', summary: 'summary.json' }[u.searchParams.get('format') || 'json'] || 'history.json';
      const h = { 'Content-Type': f.endsWith('csv') ? 'text/csv' : 'application/json' };
      if (u.searchParams.has('download')) h['Content-Disposition'] = `attachment; filename="surge-radar-${f}"`;
      res.writeHead(200, h); return res.end(await data(f));
    }
    if (p === '/api/report') { const [s, c] = await Promise.all([data('summary.json'), data('history.csv')]); res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(`SURGE RADAR PERFORMANCE REPORT\nGenerated ${new Date().toISOString()}\n\n== SUMMARY ==\n${s}\n\n== ALERT LOG (CSV) ==\n${c}`); }
  } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ error: String(e) })); }
  let f = path.join(PUB, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}).listen(8000, () => console.log('Surge Radar on :8000', RAW ? '(history from GitHub)' : '(local history)'));

// Without the GitHub scanner, keep a local history every 10 minutes so the preview still logs results.
async function bg() { if (RAW) return; try { await record(LOCAL, await getScan(true)); } catch (e) { console.error('bg', e.message); } }
bg(); setInterval(bg, 10 * 60000);
