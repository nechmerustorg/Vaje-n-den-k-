// Vercel Serverless Function — /api/data
// Záloha + obnovení dat pro Vaječný Deník.
// Storage: Vercel KV (Upstash Redis pod kapotou).

import { kv } from '@vercel/kv';

const STORE_KEY = 'eggdiary:data';

export default async function handler(req, res) {
    // Jednoduchá autorizace přes query param key.
    // Tajný klíč nastavený v Vercel env variables jako ACCESS_KEY.
    const provided = req.query.key;
    const expected = process.env.ACCESS_KEY;

    if (!expected) {
        return res.status(500).json({ error: 'Server není nakonfigurován (chybí ACCESS_KEY env)' });
    }
    if (!provided || provided !== expected) {
        return res.status(401).json({ error: 'Neplatný přístupový klíč' });
    }

    try {
        if (req.method === 'GET') {
            const data = await kv.get(STORE_KEY);
            return res.status(200).json({ data: data || null });
        }

        if (req.method === 'POST') {
            const body = req.body;
            if (!body || typeof body !== 'object') {
                return res.status(400).json({ error: 'Neplatné tělo požadavku' });
            }
            await kv.set(STORE_KEY, body);
            return res.status(200).json({ ok: true, savedAt: new Date().toISOString() });
        }

        return res.status(405).json({ error: 'Method not allowed' });
    } catch (e) {
        console.error('KV error:', e);
        return res.status(500).json({ error: 'Storage error', message: e.message });
    }
}
