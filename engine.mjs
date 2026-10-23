// Surge Radar scanning engine — shared by the server (phone app) and the 10-minute CLI scanner.
// Data: CoinGecko (top-20 list), OKX (crypto candles, funding, open interest), Yahoo Finance (FX, gold, futures),
// ForexFactory weekly calendar (high-impact news). No API keys required.

export const CONFIG = {
  accountSize: 500,
  riskPct: 1.5,           // % risked per trade. 30-day test: 1.5% gave the best profit-to-drawdown (1%, 1.25%, 1.75%, 2% all worse)
  rewardRisk: 2.5,        // take-profit = 2.5 x stop distance
  alertScore: 47,         // minimum score to alert
  watchScore: 37,         // shown in app as "building"
  stopAtrMult: 1.5,       // base stop distance in 1h ATRs (30-day test: 1.5 beat 0.6 and 1.0)
  timeStopHours: 12,      // 30-day test: 12h beat 4h and 6h
  maxOpen: 10,            // never push a new trade while 10 signals are still open
  coreCount: 20,          // top-20 coins trade at the normal threshold
  smallCoinMinScore: 60,  // coins ranked 21-40 need a higher score (they were weaker in the 30-day test)
  cryptoCount: 40,        // top-N cryptocurrencies by market cap (stablecoins and wrapped tokens excluded)
  tradeClasses: ['crypto'], // forex/gold/futures lost money or could not be sized on $500 in the 30-day test -> watch only
  dedupHours: 4,          // same symbol+direction is not re-pushed within this window
};

const STABLES = new Set(['usdt','usdc','usds','usde','dai','usd1','fdusd','pyusd','usdg','tusd','usdd','rlusd','usdx','gusd','frax','lusd','usdtb','bfusd','usyc','buidl','susds','susde','usdf']);
const EXCLUDE = new Set(['wbtc','weth','steth','wsteth','weeth','cbbtc','wbt','leo','figr_heloc','xaut','paxg','btw','rain','cc','gram','bgb','okb']);

export const MACRO = [
  { id: 'EURUSD', name: 'EUR/USD', cls: 'forex', yahoo: 'EURUSD=X', ccy: ['EUR','USD'] },
  { id: 'XAUUSD', name: 'Gold (XAU/USD)', cls: 'metal', yahoo: 'GC=F', ccy: ['USD'] },
  { id: 'ES', name: 'S&P 500 E-mini', cls: 'futures', yahoo: 'ES=F', ccy: ['USD'], micro: { sym: 'MES', ptVal: 5 } },
  { id: 'NQ', name: 'Nasdaq-100 E-mini', cls: 'futures', yahoo: 'NQ=F', ccy: ['USD'], micro: { sym: 'MNQ', ptVal: 2 } },
  { id: 'YM', name: 'Dow E-mini', cls: 'futures', yahoo: 'YM=F', ccy: ['USD'], micro: { sym: 'MYM', ptVal: 0.5 } },
  { id: 'RTY', name: 'Russell 2000 E-mini', cls: 'futures', yahoo: 'RTY=F', ccy: ['USD'], micro: { sym: 'M2K', ptVal: 5 } },
  { id: 'CL', name: 'Crude Oil (WTI)', cls: 'futures', yahoo: 'CL=F', ccy: ['USD'], micro: { sym: 'MCL', ptVal: 100 } },
];

const UA = { 'User-Agent': 'Mozilla/5.0 (SurgeRadar)' };
async function getJSON(url, ms = 12000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { headers: UA, signal: c.signal }); if (!r.ok) throw new Error(r.status + ' ' + url); return await r.json(); }
  finally { clearTimeout(t); }
}

// ---------- universe ----------
import fs from 'node:fs';
const UNI_CACHE = new URL('./data/universe.json', import.meta.url).pathname;
export async function cryptoUniverse() {
  try { const u = await fetchUniverse(); try { fs.writeFileSync(UNI_CACHE, JSON.stringify(u)); } catch {} return u; }
  catch (e) { try { return JSON.parse(fs.readFileSync(UNI_CACHE, 'utf8')); } catch { throw e; } }
}
async function fetchUniverse() {
  const [cg, inst] = await Promise.all([
    getJSON('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=80'),
    getJSON('https://www.okx.com/api/v5/public/instruments?instType=SPOT'),
  ]);
  const okx = new Set(inst.data.filter(i => i.quoteCcy === 'USDT' && i.state === 'live').map(i => i.baseCcy));
  const out = [];
  for (const c of cg) {
    const s = c.symbol.toLowerCase();
    if (STABLES.has(s) || EXCLUDE.has(s)) continue;
    if (Math.abs((c.current_price || 0) - 1) < 0.02 && /usd/.test(s)) continue;
    const S = c.symbol.toUpperCase();
    if (!okx.has(S)) continue;
    out.push({ id: S, name: c.name, cls: 'crypto', okx: `${S}-USDT`, rank: c.market_cap_rank, core: out.length < CONFIG.coreCount });
    if (out.length === CONFIG.cryptoCount) break;
  }
  return out;
}

// ---------- candles ----------
async function okxCandles(instId, bar, n) {
  const j = await getJSON(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${Math.min(n, 300)}`);
  return j.data.map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] })).reverse();
}
async function yahooCandles(sym, interval, range) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`);
  const r = j.chart.result[0]; const q = r.indicators.quote[0];
  const out = [];
  r.timestamp.forEach((ts, i) => { if (q.close[i] != null && q.high[i] != null) out.push({ t: ts * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 }); });
  return out;
}
function resample(c15, k = 4) { // 15m -> 1h
  const out = [];
  for (const b of c15) {
    const hr = Math.floor(b.t / 3600000);
    const last = out[out.length - 1];
    if (last && last._hr === hr) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v; }
    else out.push({ _hr: hr, t: hr * 3600000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  }
  return out;
}

// ---------- indicators ----------
const sma = (a, n) => a.slice(-n).reduce((s, x) => s + x, 0) / Math.min(n, a.length);
function emaSeries(a, n) { const k = 2 / (n + 1); const o = [a[0]]; for (let i = 1; i < a.length; i++) o.push(a[i] * k + o[i - 1] * (1 - k)); return o; }
function atrSeries(c, n = 14) {
  const tr = c.map((b, i) => i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - c[i - 1].c), Math.abs(b.l - c[i - 1].c)));
  const o = [tr[0]]; for (let i = 1; i < tr.length; i++) o.push((o[i - 1] * (n - 1) + tr[i]) / n); return o;
}
function rsi(closes, n = 14) {
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; d > 0 ? g += d : l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function stdev(a) { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); }
function percentileRank(series, v) { const s = series.filter(Number.isFinite); return s.filter(x => x <= v).length / s.length; }

// ---------- news ----------
let calCache = { t: 0, data: [] };
export async function highImpactNews() {
  if (Date.now() - calCache.t < 30 * 60000) return calCache.data;
  try {
    const j = await getJSON('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
    calCache = { t: Date.now(), data: j.filter(e => e.impact === 'High').map(e => ({ title: e.title, ccy: e.country, time: new Date(e.date).getTime() })) };
  } catch { /* keep old */ }
  return calCache.data;
}

// ---------- crypto derivatives ----------
async function okxDerivs(base) {
  try {
    const [f, oi] = await Promise.all([
      getJSON(`https://www.okx.com/api/v5/public/funding-rate?instId=${base}-USDT-SWAP`),
      getJSON(`https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${base}&period=1H`),
    ]);
    const fr = +f.data[0].fundingRate;
    const rows = (oi.data || []).slice(0, 25).map(r => +r[1]); // newest first
    const oiChg = rows.length > 6 && rows[6] ? (rows[0] - rows[6]) / rows[6] : 0;
    return { funding: fr, oiChg6h: oiChg };
  } catch { return null; }
}

// ---------- session / market-hours ----------
function nyParts(ts = Date.now()) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(ts));
  const g = k => p.find(x => x.type === k).value;
  return { dow: g('weekday'), hour: +g('hour') % 24, min: +g('minute') };
}
function sessionCheck(a, ts) {
  if (a.cls === 'crypto') return { ok: true };
  const { dow, hour } = nyParts(ts);
  if (dow === 'Sat' || (dow === 'Sun' && hour < 18) || (dow === 'Fri' && hour >= 17)) return { ok: false, why: 'Market closed' };
  if (dow === 'Fri' && hour >= 12) return { ok: false, why: 'Friday afternoon — weekend-gap risk, no new trades' };
  if (hour >= 17 && hour < 19) return { ok: false, why: 'Low-liquidity rollover window (5–7 PM ET)' };
  return { ok: true };
}

// ---------- core analysis ----------
export async function analyze(a, news, opts = {}) {
  let c15 = opts.c15;
  if (!c15) { if (a.cls === 'crypto') c15 = await okxCandles(a.okx, '15m', 300); else c15 = await yahooCandles(a.yahoo, '15m', '5d'); }
  if (c15.length < 120) throw new Error('not enough data');
  const h1 = resample(c15);
  const closesH = h1.map(b => b.c), closes15 = c15.map(b => b.c);
  const px = closes15.at(-1);
  const atrH = atrSeries(h1).at(-1);
  const atr15 = atrSeries(c15);

  // 1) Volatility squeeze (TTM style): BB(20,2) inside KC(20,1.5 ATR) on 1h, plus BB width percentile
  const bbW = [];
  for (let i = 20; i <= closesH.length; i++) bbW.push((4 * stdev(closesH.slice(i - 20, i))) / sma(closesH.slice(0, i), 20));
  const bbWidthNow = bbW.at(-1);
  const bbPct = percentileRank(bbW, bbWidthNow);
  const sd = stdev(closesH.slice(-20)), mid = sma(closesH, 20);
  const squeezeOn = 2 * sd < 1.5 * atrH;
  // squeeze "firing": was on within last 3 hours and now expanding
  let wasOn = false;
  for (let k = 2; k <= 4; k++) { const sl = closesH.slice(0, -k + 1 || undefined); const s2 = stdev(sl.slice(-20)); const at = atrSeries(h1.slice(0, -k + 1 || undefined)).at(-1); if (2 * s2 < 1.5 * at) wasOn = true; }
  const recentMinW = Math.min(...bbW.slice(-5));
  const firing = wasOn && !squeezeOn && percentileRank(bbW, recentMinW) < 0.6 && bbWidthNow > bbW.at(-2);

  // 2) ATR compression: current 15m ATR vs its 5-day distribution
  const atrPct = percentileRank(atr15.slice(-400), atr15.at(-1));

  // 3) Relative volume: last 2 x 15m bars vs median of the same time-of-day bars on prior days (fallback: last 96 bars)
  let rvol = 1;
  const vols = c15.map(b => b.v);
  if (vols.some(v => v > 0)) {
    const recent = (vols.at(-1) + vols.at(-2)) / 2;
    const tod = []; const lastT = c15.at(-1).t;
    for (const b of c15) { const dd = (lastT - b.t) / 86400000; if (dd >= 0.98 && Math.abs(dd - Math.round(dd)) < 0.03) tod.push(b.v); }
    const base = tod.length >= 2 ? tod.sort((x, y) => x - y)[Math.floor(tod.length / 2)] : sma(vols.slice(-98, -2), 96);
    rvol = base > 0 ? recent / base : 1;
  }

  // 4) Range breakout: price vs prior 24h high/low (1h bars)
  const rng = h1.slice(-25, -1);
  const hi = Math.max(...rng.map(b => b.h)), lo = Math.min(...rng.map(b => b.l));
  const brkUp = px > hi, brkDn = px < lo;
  const nearUp = !brkUp && (hi - px) < 0.25 * atrH, nearDn = !brkDn && (px - lo) < 0.25 * atrH;

  // 5) Trend + momentum
  const e20 = emaSeries(closesH, 20).at(-1), e50 = emaSeries(closesH, 50).at(-1);
  const r = rsi(closesH);
  const m12 = emaSeries(closesH, 12), m26 = emaSeries(closesH, 26);
  const macd = m12.map((x, i) => x - m26[i]); const sig = emaSeries(macd, 9);
  const hist = macd.at(-1) - sig.at(-1), histPrev = macd.at(-2) - sig.at(-2);
  const vwap = (() => { const d = c15.slice(-96); const pv = d.reduce((s, b) => s + ((b.h + b.l + b.c) / 3) * (b.v || 1), 0); const vv = d.reduce((s, b) => s + (b.v || 1), 0); return pv / vv; })();

  let bull = 0, bear = 0;
  if (px > e20) bull++; else bear++;
  if (e20 > e50) bull++; else bear++;
  if (hist > 0 && hist > histPrev) bull++; if (hist < 0 && hist < histPrev) bear++;
  if (r > 55 && r < 75) bull++; if (r < 45 && r > 25) bear++;
  if (px > vwap) bull++; else bear++;
  if (brkUp || nearUp) bull++; if (brkDn || nearDn) bear++;

  // 6) Crypto derivatives
  let der = null;
  if (a.cls === 'crypto' && !opts.c15) der = await okxDerivs(a.id);

  // 7) News catalysts within next 4h
  const now = opts.now || Date.now();
  const upcoming = (news || []).filter(e => e.time > now - 15 * 60000 && e.time < now + 4 * 3600000 && (a.cls === 'crypto' ? e.ccy === 'USD' : a.ccy.includes(e.ccy)));
  const imminent = upcoming.filter(e => e.time > now - 15 * 60000 && e.time < now + 30 * 60000);

  // ---------- score ----------
  const factors = [];
  let s = 0;
  if (firing) { s += 22; factors.push('Squeeze just fired (energy releasing)'); }
  else if (squeezeOn && bbPct < 0.6) { s += 14; factors.push('Volatility squeeze active'); }
  if (bbPct <= 0.4) { s += 10; factors.push(`Range tight (bottom ${Math.max(1, Math.round(bbPct * 100))}% of 5 days)`); }
  else if (bbPct <= 0.6) { s += 6; factors.push(`Range moderately tight (${Math.round(bbPct * 100)}th percentile)`); }
  if (atrPct < 0.6 && !firing) { s += 6; factors.push('Volatility below average'); }
  if (rvol >= 3) { s += 20; factors.push(`Volume ${rvol.toFixed(1)}x normal`); }
  else if (rvol >= 2) { s += 14; factors.push(`Volume ${rvol.toFixed(1)}x normal`); }
  else if (rvol >= 1.5) { s += 7; factors.push(`Volume ${rvol.toFixed(1)}x normal`); }
  if (brkUp || brkDn) { s += 16; factors.push(`Broke 24h ${brkUp ? 'high' : 'low'}`); }
  else if (nearUp || nearDn) { s += 6; factors.push(`Pressing 24h ${nearUp ? 'high' : 'low'}`); }
  const align = Math.max(bull, bear);
  if (align >= 5) { s += 14; factors.push('Trend, momentum, VWAP aligned'); } else if (align === 4) s += 7;
  if (upcoming.length) { s += 10; factors.push(`High-impact news ≤4h: ${upcoming[0].title}`); }
  if (der) {
    if (Math.abs(der.funding) > 0.0005) { s += 8; factors.push(`Extreme funding ${(der.funding * 100).toFixed(3)}%`); }
    if (der.oiChg6h > 0.05) { s += 8; factors.push(`Open interest +${(der.oiChg6h * 100).toFixed(1)}% in 6h`); }
  }
  s = Math.min(100, s);

  let dir = bull > bear ? 'LONG' : bear > bull ? 'SHORT' : null;
  if (brkUp && dir === 'SHORT') dir = null; if (brkDn && dir === 'LONG') dir = null;
  // contrarian funding guard: don't go long into extreme positive funding, or short into extreme negative
  const blocks = [];
  if (der && dir === 'LONG' && der.funding > 0.001) blocks.push('Longs crowded (funding very high)');
  if (der && dir === 'SHORT' && der.funding < -0.001) blocks.push('Shorts crowded (funding very negative)');
  if (dir === 'LONG' && r > 78) blocks.push('RSI overbought — chasing');
  if (dir === 'SHORT' && r < 22) blocks.push('RSI oversold — chasing');
  if (imminent.length) blocks.push(`News in <30 min (${imminent[0].title}) — wait for the release`);
  // Candlestick patterns (30-day crypto test, both halves consistent):
  //  - with-direction pin bar on the last 15m candle: -0.46R/trade -> block
  //  - 1h inside-bar breakout in the signal direction: -0.13R/trade -> block
  //  - counter-direction rejection wick or doji on the last 15m candle: +0.24 to +0.37R/trade -> priority
  const cb = c15.at(-1), bodyOf = b => Math.abs(b.c - b.o), rngOf = b => (b.h - b.l) || 1e-12;
  const pinFor = (b, L) => { const lw = Math.min(b.o, b.c) - b.l, uw = b.h - Math.max(b.o, b.c); return L ? (lw >= 2 * bodyOf(b) && lw >= 0.6 * rngOf(b)) : (uw >= 2 * bodyOf(b) && uw >= 0.6 * rngOf(b)); };
  let priority = false;
  if (dir) {
    const L = dir === 'LONG';
    if (pinFor(cb, L)) blocks.push('Pin bar in signal direction (lost money in test)');
    const [m1, ib, bb] = h1.slice(-3);
    if (ib && ib.h <= m1.h && ib.l >= m1.l && (L ? bb.c > ib.h : bb.c < ib.l)) blocks.push('1h inside-bar breakout (lost money in test)');
    if (pinFor(cb, !L)) { priority = true; factors.push('Shakeout wick against the move (strong pattern)'); }
    else if (bodyOf(cb) < 0.1 * rngOf(cb)) { priority = true; factors.push('Doji pause before continuation (strong pattern)'); }
  }
  // 30-day test: crypto signals issued 16:00-20:00 UTC (12-4 PM ET during daylight time) lost money in both halves.
  { const hU = new Date(now).getUTCHours(); if (a.cls === 'crypto' && hU >= 16 && hU < 20) blocks.push('US midday window (lost money in test)'); }
  const sess = sessionCheck(a, now); if (!sess.ok) blocks.push(sess.why);
  if (!dir) blocks.push('No clear direction');
  if (dir && a.cls === 'crypto' && opts.btcTrend && ((dir === 'LONG') !== (opts.btcTrend > 0))) blocks.push(`Against Bitcoin trend (BTC ${opts.btcTrend > 0 ? 'up' : 'down'})`);
  if (a.cls === 'crypto' && a.core === false && s < CONFIG.smallCoinMinScore) blocks.push(`Smaller coin: needs score ${CONFIG.smallCoinMinScore}+`);
  if (!CONFIG.tradeClasses.includes(a.cls)) blocks.push('Watch only: this market lost money in the 30-day test');

  // ---------- levels ----------
  let plan = null;
  if (dir) {
    const swing = dir === 'LONG' ? Math.min(...c15.slice(-8).map(b => b.l)) : Math.max(...c15.slice(-8).map(b => b.h));
    let stopDist = CONFIG.stopAtrMult * atrH;
    const swingDist = Math.abs(px - swing) + 0.1 * atrH;
    if (swingDist > stopDist && swingDist < 1.6 * atrH) stopDist = swingDist; // sit beyond structure if reasonable
    stopDist = Math.max(stopDist, 0.6 * atrH);
    const tpDist = stopDist * CONFIG.rewardRisk;
    const exp4h = atrH * 4 * 0.85; // realistic 4h range when volatility expands
    const sl = dir === 'LONG' ? px - stopDist : px + stopDist;
    const tp = dir === 'LONG' ? px + tpDist : px - tpDist;
    plan = { entry: px, stop: sl, takeProfit: tp, stopDist, tpDist, rr: CONFIG.rewardRisk, ...sizing(a, px, stopDist), timeStop: new Date(now + CONFIG.timeStopHours * 3600000).toISOString() };
  }

  const status = s >= (opts.alertScore ?? CONFIG.alertScore) && blocks.length === 0 ? 'ALERT' : s >= CONFIG.watchScore ? 'WATCH' : 'QUIET';
  return { _raw: s, priority, id: a.id, name: a.name, cls: a.cls, price: px, score: s, dir, status, factors, blocks, plan,
    stats: { atr1h: atrH, rsi: r, rvol, bbPct, funding: der?.funding ?? null, oiChg6h: der?.oiChg6h ?? null }, at: now };
}

export function sizing(a, px, stopDist) {
  const risk$ = CONFIG.accountSize * CONFIG.riskPct / 100;
  if (a.cls === 'crypto') {
    const qty = risk$ / stopDist;
    return { risk$, qty, unit: a.id, notional: qty * px, note: qty * px > CONFIG.accountSize ? `Needs ~${(qty * px / CONFIG.accountSize).toFixed(1)}x leverage` : 'Spot OK' };
  }
  if (a.id === 'EURUSD') {
    const pips = stopDist / 0.0001; const lots = risk$ / (pips * 10);
    return { risk$, qty: Math.floor(lots * 100) / 100, unit: 'lots', pips, note: lots < 0.01 ? 'Below 0.01 lot — use 0.01 (risk ≈ $' + (pips * 0.1).toFixed(2) + ')' : `${pips.toFixed(1)} pip stop` };
  }
  if (a.id === 'XAUUSD') {
    const oz = risk$ / stopDist; const lots = oz / 100;
    return { risk$, qty: Math.max(0.01, Math.floor(lots * 100) / 100), unit: 'lots', note: lots < 0.01 ? `Min 0.01 lot risks ≈ $${stopDist.toFixed(2)} — over budget` : `$${stopDist.toFixed(2)} stop` };
  }
  if (a.cls === 'stock') {
    const sh = risk$ / stopDist;
    return { risk$, qty: +sh.toFixed(3), unit: 'shares', notional: sh * px, note: sh * px > CONFIG.accountSize ? `Needs ~${(sh * px / CONFIG.accountSize).toFixed(1)}x margin` : 'Fractional shares OK' };
  }
  const m = a.micro; const per = stopDist * m.ptVal;
  return { risk$, qty: per <= risk$ ? Math.floor(risk$ / per) : 0, unit: m.sym, note: per > risk$ ? `1 ${m.sym} risks $${per.toFixed(0)} — exceeds $${risk$.toFixed(0)} budget` : `${m.sym} micro` };
}

export async function scanAll() {
  const [crypto, news, btc] = await Promise.all([cryptoUniverse(), highImpactNews(), okxCandles('BTC-USDT', '15m', 300).catch(() => null)]);
  let btcTrend = 0;
  if (btc && btc.length > 210) { const cl = btc.map(b => b.c); const e = emaSeries(cl.slice(-201), 200).at(-1); btcTrend = cl.at(-1) > e ? 1 : -1; }
  const assets = [...crypto, ...MACRO];
  const results = [], errors = [];
  const queue = [...assets];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) { const a = queue.shift(); try { results.push(await analyze(a, news, { btcTrend })); } catch (e) { errors.push({ id: a.id, error: String(e.message || e) }); } }
  }));
  const order = { ALERT: 0, WATCH: 1, QUIET: 2 };
  results.sort((x, y) => order[x.status] - order[y.status] || y.score - x.score);
  return { at: Date.now(), config: CONFIG, results, errors, news: news.filter(e => e.time > Date.now() - 3600000).slice(0, 12) };
}

// Dedup: a signal is "new" if no push for the same id+dir within dedupHours, or score jumped ≥10.
export function dedupe(alerts, state) {
  const now = Date.now(), fresh = [];
  for (const a of alerts) {
    const k = `${a.id}:${a.dir}`; const prev = state[k];
    if (!prev || now - prev.at > CONFIG.dedupHours * 3600000 || a.score >= prev.score + 10) { fresh.push(a); state[k] = { at: now, score: a.score }; }
  }
  for (const k of Object.keys(state)) if (now - state[k].at > 24 * 3600000) delete state[k];
  return fresh;
}

export function fmt(x) {
  if (x == null || !isFinite(x)) return '—';
  const a = Math.abs(x);
  const d = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return x.toLocaleString('en-US', { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d });
}
