// GET /api/reservations — owner only (ACCESS_KEY), list aktivních rezervací.
// Pro budoucí UI v deníku (záložka „Rezervace").

import {
    loadActiveReservations,
    setCorsHeaders,
    handlePreflight,
    jsonError,
} from '../_lib.js';

export default async function handler(req, res) {
    const webOrigin = process.env.WEB_ORIGIN || '*';
    if (handlePreflight(req, res, webOrigin)) return;
    setCorsHeaders(res, webOrigin);

    if (req.method !== 'GET') {
        return jsonError(res, 405, 'Method not allowed');
    }

    const expected = process.env.ACCESS_KEY;
    const provided = req.query.key || req.headers['x-access-key'];
    if (!expected || provided !== expected) {
        return jsonError(res, 401, 'Neplatný přístupový klíč');
    }

    try {
        const { reservations, reservedByCategory } = await loadActiveReservations();
        return res.status(200).json({
            count: reservations.length,
            reservedByCategory,
            reservations: reservations.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        });
    } catch (e) {
        console.error('reservations list error:', e);
        return jsonError(res, 500, 'Storage error', { message: e.message });
    }
}
