// Alert history + outcome tracking. Every pushed alert is logged; open ones are resolved
// against later 15m candles: WIN (take-profit hit first), LOSS (stop hit first; if both in one bar we assume LOSS),
// TIME (time stop reached -> closed at market). Results in R multiples (1R = risk per trade).
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, dedupe, MACRO } from './engine.mjs';

const UA = { 'User-Agent': 'Mozilla/5.0 (SurgeRadar)' };
async function j(url) { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(r.status); return r.json(); }
async function candlesSince(a, since) {
  if (a.cls === 'crypto') {
    const d = await j(`https://www.okx.com/api/v5/market/candles?instId=${a.id}-USDT&bar=15m&limit=300`);
    return d.data.map(r => ({ t: +r[0], h: +r[2], l: +r[3], c: +r[4] })).reverse().filter(b => b.t >= since - 15 * 60000);
  }
  const m = MACRO.find(x => x.id === a.id);
  const d = await j(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(m.yahoo)}?interval=15m&range=5d`);
  const r = d.chart.result[0], q = r.indicators.quote[0];
  return r.timestamp.map((ts, i) => ({ t: ts * 1000, h: q.high[i], l: q.low[i], c: q.close[i] })).filter(b => b.c != null && b.t >= since - 15 * 60000);
}

export async function evaluate(rec) {
  const p = rec.plan, long = rec.dir === 'LONG';
  const bars = (await candlesSince(rec, rec.at)).filter(b => b.t + 15 * 60000 > rec.at); // bars that close after alert
  const end = new Date(p.timeStop).getTime();
  let mfe = 0, mae = 0;
  for (const b of bars) {
    if (b.t > end) break;
    const fav = long ? b.h - p.entry : p.entry - b.l, adv = long ? p.entry - b.l : b.h - p.entry;
    mfe = Math.max(mfe, fav / p.stopDist); mae = Math.max(mae, adv / p.stopDist);
    const hitSL = long ? b.l <= p.stop : b.h >= p.stop;
    const hitTP = long ? b.h >= p.takeProfit : b.l <= p.takeProfit;
    if (hitSL) return { result: 'LOSS', r: -1, closedAt: b.t, exit: p.stop, mfe, mae };
    if (hitTP) return { result: 'WIN', r: rec.plan.rr, closedAt: b.t, exit: p.takeProfit, mfe, mae };
  }
  if (Date.now() > end && bars.length) {
    const last = [...bars].reverse().find(b => b.t <= end) || bars.at(-1);
    const r = (long ? last.c - p.entry : p.entry - last.c) / p.stopDist;
    return { result: 'TIME', r: +r.toFixed(2), closedAt: end, exit: last.c, mfe, mae };
  }
  return { result: 'OPEN', r: null, mfe, mae };
}

const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

// Process one scan: dedupe alerts, append to history, re-evaluate open trades, write files. Returns fresh alerts.
export async function record(dir, scan) {
  fs.mkdirSync(dir, { recursive: true });
  const F = n => path.join(dir, n);
  const state = rd(F('state.json'), {}), hist = rd(F('history.json'), []);
  const openN = hist.filter(h => h.outcome.result === 'OPEN').length;
  const room = Math.max(0, (CONFIG.maxOpen ?? 99) - openN);
  const cand = scan.results.filter(r => r.status === 'ALERT').sort((x, y) => y.score - x.score).slice(0, room);
  const fresh = dedupe(cand, state);
  for (const a of fresh) hist.push({ uid: `${a.id}-${a.dir}-${a.at}`, id: a.id, name: a.name, cls: a.cls, dir: a.dir, score: a.score, at: a.at, factors: a.factors, stats: a.stats, plan: a.plan, outcome: { result: 'OPEN' } });
  for (const h of hist) if (h.outcome.result === 'OPEN') { try { h.outcome = await evaluate(h); } catch {} }
  fs.writeFileSync(F('state.json'), JSON.stringify(state));
  fs.writeFileSync(F('history.json'), JSON.stringify(hist, null, 1));
  fs.writeFileSync(F('history.csv'), toCSV(hist));
  fs.writeFileSync(F('summary.json'), JSON.stringify(summarize(hist), null, 1));
  const slim = { ...scan, results: scan.results.map(({ stats, ...r }) => ({ ...r, stats })) };
  fs.writeFileSync(F('latest.json'), JSON.stringify(slim));
  return fresh;
}

export function summarize(hist) {
  const closed = hist.filter(h => h.outcome.result !== 'OPEN');
  const grp = k => { const o = {}; for (const h of closed) { const g = o[h[k]] ||= { n: 0, wins: 0, R: 0 }; g.n++; g.R += h.outcome.r; if (h.outcome.result === 'WIN') g.wins++; } for (const g of Object.values(o)) { g.winRate = +(g.wins / g.n).toFixed(3); g.R = +g.R.toFixed(2); } return o; };
  const R = closed.reduce((s, h) => s + h.outcome.r, 0);
  return { generated: new Date().toISOString(), total: hist.length, open: hist.length - closed.length, closed: closed.length,
    wins: closed.filter(h => h.outcome.result === 'WIN').length, losses: closed.filter(h => h.outcome.result === 'LOSS').length, timeouts: closed.filter(h => h.outcome.result === 'TIME').length,
    winRate: closed.length ? +(closed.filter(h => h.outcome.result === 'WIN').length / closed.length).toFixed(3) : null,
    netR: +R.toFixed(2), avgR: closed.length ? +(R / closed.length).toFixed(3) : null, breakevenWinRate: +(1 / (1 + CONFIG.rewardRisk)).toFixed(3),
    byClass: grp('cls'), bySymbol: grp('id'), byDirection: grp('dir'), config: CONFIG };
}

export function toCSV(hist) {
  const cols = ['uid', 'alert_time_utc', 'symbol', 'class', 'direction', 'score', 'entry', 'stop', 'take_profit', 'stop_dist', 'risk_usd', 'size', 'unit', 'result', 'r_multiple', 'exit', 'closed_utc', 'max_favorable_R', 'max_adverse_R', 'rsi', 'rel_volume', 'bb_width_pct', 'funding', 'oi_chg_6h', 'factors'];
  const q = v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
  const rows = hist.map(h => [h.uid, new Date(h.at).toISOString(), h.id, h.cls, h.dir, h.score, h.plan.entry, h.plan.stop, h.plan.takeProfit, h.plan.stopDist, h.plan.risk$, h.plan.qty, h.plan.unit, h.outcome.result, h.outcome.r, h.outcome.exit, h.outcome.closedAt ? new Date(h.outcome.closedAt).toISOString() : '', h.outcome.mfe?.toFixed(2), h.outcome.mae?.toFixed(2), h.stats?.rsi?.toFixed(1), h.stats?.rvol?.toFixed(2), h.stats?.bbPct?.toFixed(2), h.stats?.funding, h.stats?.oiChg6h, h.factors.join(' | ')].map(q).join(','));
  return [cols.join(','), ...rows].join('\n') + '\n';
}

// Phone push via ntfy.sh (free app; subscribe to the topic). Topic comes from env NTFY_TOPIC.
export async function pushNtfy(topic, a, fmt) {
  if (!topic) return;
  const p = a.plan, close = new Date(p.timeStop).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', headers: { Title: `${a.id} ${a.dir} - score ${a.score}`, Priority: 'high', Tags: a.dir === 'LONG' ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend' },
    body: `Entry ${fmt(p.entry)} | Stop ${fmt(p.stop)} | TP ${fmt(p.takeProfit)}\nSize ${fmt(p.qty)} ${p.unit} (risk $${p.risk$.toFixed(2)}) ${p.note}\nClose by ${close} ET. Use a bracket/OCO order.\n${a.factors.slice(0, 3).join('; ')}` });
}
