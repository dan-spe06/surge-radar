// 10-minute scanner used by the scheduled task. Prints JSON: { newAlerts, summary }.
import { scanAll, dedupe, fmt } from './engine.mjs';
import fs from 'node:fs';
const STATE = new URL('./alert-state.json', import.meta.url).pathname;
const state0 = 0; const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const scan = await scanAll();
const alerts = scan.results.filter(r => r.status === 'ALERT');
const PEND = new URL('./pending-alerts.json', import.meta.url).pathname;
const queued = fs.existsSync(PEND) ? JSON.parse(fs.readFileSync(PEND, 'utf8')) : []; fs.writeFileSync(PEND, '[]');
const fresh = [...queued.filter(q => Date.now() - q.at < 30 * 60000), ...dedupe(alerts, state)];
fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
fs.writeFileSync(new URL('./last-scan.json', import.meta.url).pathname, JSON.stringify(scan));
const lines = fresh.map(a => {
  const p = a.plan;
  return `${a.id} ${a.dir} (score ${a.score}) | Entry ${fmt(p.entry)} | Stop ${fmt(p.stop)} | Take-profit ${fmt(p.takeProfit)} | Size ${fmt(p.qty)} ${p.unit} (risk $${p.risk$.toFixed(2)}; ${p.note}) | Close by ${new Date(p.timeStop).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })} ET | Why: ${a.factors.join('; ')}`;
});
console.log(JSON.stringify({
  scannedAt: new Date(scan.at).toISOString(), scanned: scan.results.length, errors: scan.errors,
  newAlerts: lines, repeatsSuppressed: alerts.length - fresh.length,
  watching: scan.results.filter(r => r.status === 'WATCH').map(r => `${r.id} ${r.dir || ''} ${r.score}${r.blocks.length ? ' [' + r.blocks[0] + ']' : ''}`),
}, null, 1));
