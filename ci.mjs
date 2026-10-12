// GitHub Actions entrypoint: scan -> log history/outcomes -> push new alerts to phone via ntfy.
import { scanAll, fmt } from './engine.mjs';
import { record, pushNtfy } from './history.mjs';
const scan = await scanAll();
const fresh = await record('data', scan);
for (const a of fresh) { try { await pushNtfy(process.env.NTFY_TOPIC, a, fmt); } catch (e) { console.error('push failed', e.message); } }
console.log(`scanned ${scan.results.length}, errors ${scan.errors.length}, new alerts ${fresh.map(a => a.id + ' ' + a.dir).join(', ') || 'none'}`);
