// Sends one clearly-labelled TEST alert through the exact same push code real signals use.
import { fmt } from './engine.mjs';
import { pushNtfy } from './history.mjs';
if (!process.env.NTFY_TOPIC) { console.error('NTFY_TOPIC secret missing'); process.exit(1); }
const now = Date.now();
await pushNtfy(process.env.NTFY_TOPIC, { id: 'TEST BTC', dir: 'LONG', score: 80, factors: ['THIS IS A TEST - do not trade', 'Squeeze just fired', 'Volume 2.4x normal'],
  plan: { entry: 100000, stop: 99200, takeProfit: 102000, qty: 0.00625, unit: 'BTC', risk$: 5, note: 'Spot OK', timeStop: new Date(now + 6 * 3600e3).toISOString() } }, fmt);
console.log('test push sent OK');
