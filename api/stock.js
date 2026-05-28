// GET /api/stock — public endpoint, vrací aktuálně dostupný sklad
// (fyzický sklad z deníku minus aktivní rezervace).
// Žádná autorizace. CORS open (*).

import { kv } from '@vercel/kv';
import {
    STORE_KEY,
    CATEGORY_KEYS,
    computeStockFromBlob,
    loadActiveReservations,
    setCorsHeaders,
    handlePreflight,
    jsonError,
} from './_lib.js';

export default async function handler(req, res) {
    if (handlePreflight(req, res, '*')) return;
    setCorsHeaders(res, '*');

    if (req.method !== 'GET') {
        return jsonError(res, 405, 'Method not allowed');
    }

    try {
        const blob = await kv.get(STORE_KEY);
        const physical = computeStockFromBlob(blob);
        const { reservedByCategory } = await loadActiveReservations();

        const available = {};
        for (const k of CATEGORY_KEYS) {
            available[k] = Math.max(0, physical[k] - reservedByCategory[k]);
        }

        // 30s edge cache, 60s stale-while-revalidate.
        // Deník stejně syncuje s 3s debounce → 30s je v pohodě.
        res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');

        return res.status(200).json({
            available,
            physical,
            reserved: reservedByCategory,
            updatedAt: blob?.savedAt || null,
            prices: blob?.settings?.prices || null,
        });
    } catch (e) {
        console.error('stock error:', e);
        return jsonError(res, 500, 'Storage error', { message: e.message });
    }
}
