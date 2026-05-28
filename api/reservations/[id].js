// GET /api/reservations/<id> — public, vrátí stav rezervace
//   (pro stránku potvrzení s pickup kódem). Vrací 404 po expiraci TTL.
// DELETE /api/reservations/<id> — owner only, vyžaduje ACCESS_KEY,
//   smaže rezervaci (zruší / potvrdí prodej, owner sám zapíše prodej do deníku).

import { kv } from '@vercel/kv';
import {
    RESERVATIONS_SET_KEY,
    setCorsHeaders,
    handlePreflight,
    jsonError,
} from '../_lib.js';

export default async function handler(req, res) {
    const webOrigin = process.env.WEB_ORIGIN || '*';
    if (handlePreflight(req, res, webOrigin)) return;
    setCorsHeaders(res, webOrigin);

    const id = String(req.query.id || '').toUpperCase();
    if (!/^[A-Z0-9]{4,16}$/.test(id)) {
        return jsonError(res, 400, 'Neplatné id');
    }

    try {
        if (req.method === 'GET') {
            const r = await kv.get(`reservation:${id}`);
            if (!r) {
                return jsonError(res, 404, 'Rezervace neexistuje nebo už vypršela');
            }
            // Klient nepotřebuje vidět IP/customer note v plné podobě —
            // ale je to soukromý kód, takže ok vracet.
            return res.status(200).json(r);
        }

        if (req.method === 'DELETE') {
            const expected = process.env.ACCESS_KEY;
            const provided = req.query.key || req.headers['x-access-key'];
            if (!expected || provided !== expected) {
                return jsonError(res, 401, 'Neplatný přístupový klíč');
            }
            await kv.del(`reservation:${id}`);
            await kv.srem(RESERVATIONS_SET_KEY, id);
            return res.status(200).json({ ok: true, id });
        }

        return jsonError(res, 405, 'Method not allowed');
    } catch (e) {
        console.error('reservation [id] error:', e);
        return jsonError(res, 500, 'Storage error', { message: e.message });
    }
}
