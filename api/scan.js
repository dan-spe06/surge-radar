import { scanAll } from '../engine.mjs';
export default async function handler(req, res) { try { const s = await scanAll(); res.setHeader('Cache-Control', 's-maxage=60'); res.json(s); } catch (e) { res.status(500).json({ error: String(e) }); } }
