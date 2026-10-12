import { raw } from './_data.js';
export default async function handler(req, res) {
  const f = { json: 'history.json', csv: 'history.csv', summary: 'summary.json' }[req.query.format || 'json'] || 'history.json';
  try { const t = await raw(f); res.setHeader('Content-Type', f.endsWith('csv') ? 'text/csv' : 'application/json'); if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="surge-radar-${f}"`); res.send(t); }
  catch (e) { res.status(502).json({ error: String(e) }); }
}
