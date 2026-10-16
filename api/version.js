import { RAW } from './_data.js';
export default function handler(req, res) { res.json({ commit: process.env.VERCEL_GIT_COMMIT_SHA || null, historySource: RAW }); }
