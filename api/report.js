import { raw } from './_data.js';
export default async function handler(req, res) {
  try { const [s, c] = await Promise.all([raw('summary.json'), raw('history.csv')]);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.send(`SURGE RADAR PERFORMANCE REPORT\nGenerated ${new Date().toISOString()}\n\n== SUMMARY ==\n${s}\n\n== ALERT LOG (CSV) ==\n${c}`); }
  catch (e) { res.status(502).send(String(e)); }
}
