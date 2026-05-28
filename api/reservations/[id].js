// GET /api/reservations/<id> — public, vrátí stav rezervace
//   (pro stránku potvrzení s pickup kódem). Vrací 404 po expiraci TTL.
// PATCH /api/reservations/<id> — owner only, vyžaduje ACCESS_KEY.
//   Body: { ready?: bool, ownerNote?: string|null }.
//   Reset TTL na 24h (chovatel aktivně pracuje s rezervací).
// DELETE /api/reservations/<id> — owner only, vyžaduje ACCESS_KEY,
//   smaže rezervaci (zruší / potvrdí prodej, owner sám zapíše prodej do deníku).

import { kv } from '@vercel/kv';
import {
    RESERVATIONS_SET_KEY,
    RESERVATION_TTL_SECONDS,
    setCorsHeaders,
    handlePreflight,
    jsonError,
} from '../_lib.js';

function checkOwnerAuth(req) {
    const expected = process.env.ACCESS_KEY;
    const provided = req.query.key || req.headers['x-access-key'];
    return Boolean(expected && provided === expected);
}

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
            return res.status(200).json(r);
        }

        if (req.method === 'PATCH') {
            if (!checkOwnerAuth(req)) {
                return jsonError(res, 401, 'Neplatný přístupový klíč');
            }
            let body = req.body;
            if (typeof body === 'string') {
                try { body = JSON.parse(body); } catch { body = null; }
            }
            if (!body || typeof body !== 'object') {
                return jsonError(res, 400, 'Neplatné tělo požadavku');
            }
            const existing = await kv.get(`reservation:${id}`);
            if (!existing) {
                return jsonError(res, 404, 'Rezervace neexistuje nebo už vypršela');
            }

            const updated = { ...existing };
            if (Object.prototype.hasOwnProperty.call(body, 'ready')) {
                updated.readyAt = body.ready ? new Date().toISOString() : null;
            }
            if (Object.prototype.hasOwnProperty.call(body, 'ownerNote')) {
                const note = body.ownerNote;
                if (note === null || note === '') {
                    updated.ownerNote = null;
                } else if (typeof note === 'string') {
                    updated.ownerNote = note.trim().slice(0, 500);
                }
            }

            // Reset TTL + posun expiresAt na +24h od teď.
            const now = Date.now();
            updated.expiresAt = new Date(now + RESERVATION_TTL_SECONDS * 1000).toISOString();
            updated.updatedAt = new Date(now).toISOString();

            await kv.set(`reservation:${id}`, updated, { ex: RESERVATION_TTL_SECONDS });
            return res.status(200).json(updated);
        }

        if (req.method === 'DELETE') {
            if (!checkOwnerAuth(req)) {
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
