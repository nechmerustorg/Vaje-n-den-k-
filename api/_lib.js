// Sdílené utility pro public API (stock, reserve, reservations).
// Importováno serverless funkcemi v /api.

import { kv } from '@vercel/kv';

export const STORE_KEY = 'eggdiary:data';
export const RESERVATIONS_SET_KEY = 'eggdiary:reservations';
export const RESERVATION_TTL_SECONDS = 4 * 60 * 60; // 4 hodiny
export const CATEGORY_KEYS = ['slepM', 'slepV', 'zelM', 'zelV', 'krep'];

const DEFAULT_STOCK = { slepM: 0, slepV: 0, zelM: 0, zelV: 0, krep: 0 };

export function emptyStock() {
    return { ...DEFAULT_STOCK };
}

// Spočítá fyzický sklad z blob dat deníku.
// Logika kopíruje calculateBalances() z index.html, ale jen pro poslední stav.
export function computeStockFromBlob(blob) {
    if (!blob || typeof blob !== 'object') return emptyStock();
    const settings = blob.settings || {};
    const initial = { ...DEFAULT_STOCK, ...(settings.initialStock || {}) };
    const records = Array.isArray(blob.records) ? blob.records : [];
    const balance = { ...initial };
    for (const r of records) {
        for (const k of CATEGORY_KEYS) {
            balance[k] += (Number(r[k]) || 0) - (Number(r[`sold_${k}`]) || 0);
        }
    }
    // Klamp na nezáporné — záporné stavy by web neměl ukazovat.
    for (const k of CATEGORY_KEYS) {
        if (balance[k] < 0) balance[k] = 0;
    }
    return balance;
}

// Sečte aktivní rezervace per kategorie.
// Lazy cleanup: rezervace s expirovaným TTL už neexistují v KV (auto-removed),
// ale jejich id zůstává v setu — proto filtrujeme nulové výsledky a vracíme valid ids.
export async function loadActiveReservations() {
    const ids = (await kv.smembers(RESERVATIONS_SET_KEY)) || [];
    if (ids.length === 0) {
        return { reservations: [], reservedByCategory: emptyStock() };
    }
    const keys = ids.map(id => `reservation:${id}`);
    const values = await kv.mget(...keys);
    const reservations = [];
    const reservedByCategory = emptyStock();
    const staleIds = [];
    for (let i = 0; i < ids.length; i++) {
        const r = values[i];
        if (!r) {
            staleIds.push(ids[i]);
            continue;
        }
        reservations.push(r);
        for (const k of CATEGORY_KEYS) {
            reservedByCategory[k] += Number(r.items?.[k]) || 0;
        }
    }
    // Best-effort cleanup. Neblokujeme response.
    if (staleIds.length > 0) {
        kv.srem(RESERVATIONS_SET_KEY, ...staleIds).catch(() => {});
    }
    return { reservations, reservedByCategory };
}

export function setCorsHeaders(res, allowedOrigin) {
    // Stock je čistě read-only veřejný endpoint → "*" je v pohodě.
    // Reserve dostane konkrétní origin.
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
}

export function handlePreflight(req, res, allowedOrigin) {
    if (req.method === 'OPTIONS') {
        setCorsHeaders(res, allowedOrigin);
        res.status(204).end();
        return true;
    }
    return false;
}

// Krátký, lidsky čitelný id (10 znaků, A-Z+0-9 bez záměnitelných 0/O/1/I).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generateId(len = 10) {
    let out = '';
    for (let i = 0; i < len; i++) {
        out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    return out;
}

export function jsonError(res, status, message, extra = {}) {
    return res.status(status).json({ error: message, ...extra });
}
