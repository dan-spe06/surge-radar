export const RAW = 'https://raw.githubusercontent.com/dan-spe06/surge-radar/data/data'; // history lives on the 'data' branch so Vercel never redeploys for it // e.g. https://raw.githubusercontent.com/<user>/surge-radar/main/data
export async function raw(name) { const r = await fetch(`${RAW}/${name}?t=${Date.now()}`); if (!r.ok) throw new Error('history unavailable'); return r.text(); }
