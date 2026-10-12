export const RAW = process.env.GITHUB_RAW; // e.g. https://raw.githubusercontent.com/<user>/surge-radar/main/data
export async function raw(name) { const r = await fetch(`${RAW}/${name}?t=${Date.now()}`); if (!r.ok) throw new Error('history unavailable'); return r.text(); }
