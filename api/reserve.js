// POST /api/reserve — public endpoint, vytvoří rezervaci s TTL 4h.
// Body: { items: { slepM?, slepV?, zelM?, zelV?, krep? }, customer: { name, phone?, email?, note? } }
// Vrací: { id, expiresAt, pickupCode, items, total? }
//
// Validace: aspoň jedna položka >0, qty <= aktuálně dostupný sklad,
// kontakt má alespoň jedno z phone/email + name.
// Rate-limit: 5 rezervací / IP / hodina (KV counter).

import { kv } from '@vercel/kv';
import {
    STORE_KEY,
    RESERVATIONS_SET_KEY,
    RESERVATION_TTL_SECONDS,
    CATEGORY_KEYS,
    computeStockFromBlob,
    loadActiveReservations,
    setCorsHeaders,
    handlePreflight,
    jsonError,
    generateId,
} from './_lib.js';

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 60 * 60; // 1 hodina

function getClientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string') return xff.split(',')[0].trim();
    return req.socket?.remoteAddress || 'unknown';
}

function emailValid(s) {
    return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function phoneValid(s) {
    if (typeof s !== 'string') return false;
    const digits = s.replace(/\D/g, '');
    return digits.length >= 9 && digits.length <= 15;
}

function sanitize(s, max = 200) {
    if (typeof s !== 'string') return '';
    return s.trim().slice(0, max);
}

export default async function handler(req, res) {
    const webOrigin = process.env.WEB_ORIGIN || '*';
    if (handlePreflight(req, res, webOrigin)) return;
    setCorsHeaders(res, webOrigin);

    if (req.method !== 'POST') {
        return jsonError(res, 405, 'Method not allowed');
    }

    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = null; }
    }
    if (!body || typeof body !== 'object') {
        return jsonError(res, 400, 'Neplatné tělo požadavku');
    }

    // --- Validace položek ---
    // Klíče jsou volitelné (viz hlavička souboru) — chybějící hodnotu bereme jako 0.
    const requestedItems = {};
    let totalQty = 0;
    for (const k of CATEGORY_KEYS) {
        const raw = body.items?.[k];
        if (raw === undefined || raw === null || raw === '') continue;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) {
            return jsonError(res, 400, `Neplatné množství pro ${k}`);
        }
        const qty = Math.floor(n);
        if (qty > 0) {
            requestedItems[k] = qty;
            totalQty += qty;
        }
    }
    if (totalQty === 0) {
        return jsonError(res, 400, 'Vyber alespoň jedno vejce');
    }
    if (totalQty > 500) {
        return jsonError(res, 400, 'Maximum 500 ks na jednu rezervaci');
    }

    // --- Validace zákazníka ---
    const name = sanitize(body.customer?.name, 100);
    const phone = sanitize(body.customer?.phone, 30);
    const email = sanitize(body.customer?.email, 200);
    const note = sanitize(body.customer?.note, 500);

    if (name.length < 2) {
        return jsonError(res, 400, 'Zadej prosím jméno (min 2 znaky)');
    }
    const hasPhone = phone && phoneValid(phone);
    const hasEmail = email && emailValid(email);
    if (!hasPhone && !hasEmail) {
        return jsonError(res, 400, 'Zadej telefon nebo e-mail');
    }
    if (phone && !hasPhone) {
        return jsonError(res, 400, 'Neplatné telefonní číslo');
    }
    if (email && !hasEmail) {
        return jsonError(res, 400, 'Neplatný e-mail');
    }

    // --- Rate limit ---
    const ip = getClientIp(req);
    const rlKey = `rl:reserve:${ip}`;
    try {
        const count = await kv.incr(rlKey);
        if (count === 1) {
            await kv.expire(rlKey, RATE_LIMIT_WINDOW);
        }
        if (count > RATE_LIMIT_MAX) {
            res.setHeader('Retry-After', String(RATE_LIMIT_WINDOW));
            return jsonError(res, 429, 'Příliš mnoho rezervací, zkus to za hodinu');
        }
    } catch (e) {
        console.warn('rate-limit error (continuing):', e.message);
    }

    // --- Atomicita: load → validate → write ---
    // Bez transakcí: race window několik desítek ms. Pro malou farmu OK.
    try {
        const blob = await kv.get(STORE_KEY);
        const physical = computeStockFromBlob(blob);
        const { reservedByCategory } = await loadActiveReservations();

        const insufficient = {};
        let hasShortage = false;
        for (const [k, qty] of Object.entries(requestedItems)) {
            const available = Math.max(0, physical[k] - reservedByCategory[k]);
            if (qty > available) {
                insufficient[k] = { requested: qty, available };
                hasShortage = true;
            }
        }
        if (hasShortage) {
            return res.status(409).json({
                error: 'Nedostatek vajec',
                insufficient,
            });
        }

        // --- Vytvoření rezervace ---
        const id = generateId(10);
        const now = new Date();
        const expiresAt = new Date(now.getTime() + RESERVATION_TTL_SECONDS * 1000);
        const pickupCode = id.slice(0, 4);

        const prices = blob?.settings?.prices || {};
        let totalKc = 0;
        for (const [k, qty] of Object.entries(requestedItems)) {
            totalKc += qty * (Number(prices[k]) || 0);
        }

        const reservation = {
            id,
            pickupCode,
            items: requestedItems,
            customer: { name, phone: phone || null, email: email || null, note: note || null },
            createdAt: now.toISOString(),
            expiresAt: expiresAt.toISOString(),
            totalKc: totalKc > 0 ? totalKc : null,
            status: 'active',
        };

        // KV write — set s TTL + zaregistrovat do setu pro listing.
        await kv.set(`reservation:${id}`, reservation, { ex: RESERVATION_TTL_SECONDS });
        await kv.sadd(RESERVATIONS_SET_KEY, id);

        // Email notifikace (volitelné, jen pokud je RESEND_API_KEY).
        if (process.env.RESEND_API_KEY) {
            sendNotifications(reservation).catch(e => console.warn('email send failed:', e.message));
        }

        // WhatsApp notifikace chovateli přes CallMeBot (volitelné).
        if (process.env.CALLMEBOT_APIKEY && process.env.OWNER_WHATSAPP_PHONE) {
            sendWhatsAppNotification(reservation).catch(e => console.warn('whatsapp send failed:', e.message));
        }

        return res.status(201).json({
            id,
            pickupCode,
            items: requestedItems,
            expiresAt: reservation.expiresAt,
            totalKc: reservation.totalKc,
        });
    } catch (e) {
        console.error('reserve error:', e);
        return jsonError(res, 500, 'Chyba při zápisu rezervace', { message: e.message });
    }
}

async function sendNotifications(reservation) {
    const apiKey = process.env.RESEND_API_KEY;
    const ownerEmail = process.env.OWNER_NOTIFICATION_EMAIL;
    if (!apiKey) return;

    const fromAddr = process.env.RESEND_FROM || 'rezervace@cerstvesneseno.cz';
    const subject = `Rezervace vajec — kód ${reservation.pickupCode}`;
    const expires = new Date(reservation.expiresAt).toLocaleString('cs-CZ');
    const itemsLines = Object.entries(reservation.items)
        .map(([k, q]) => `• ${labelFor(k)}: ${q} ks`)
        .join('\n');

    const text = `Ahoj ${reservation.customer.name},

děkujeme za rezervaci v Čerstvě sneseno.

Tvoje položky:
${itemsLines}
${reservation.totalKc ? `\nCena celkem: ${reservation.totalKc} Kč (platba hotově při vyzvednutí)` : ''}

Pickup kód: ${reservation.pickupCode}
Rezervace platí do: ${expires}

Adresa vyzvednutí:
Chválov 5, Nechvalice 264 01
Telefon: 732 581 231

Pokud nestihneš dorazit, dej nám prosím vědět telefonicky.

Čerstvě sneseno
(slepice už se těší)`;

    const recipients = [];
    if (reservation.customer.email) recipients.push(reservation.customer.email);
    if (ownerEmail) recipients.push(ownerEmail);
    if (recipients.length === 0) return;

    await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: fromAddr,
            to: recipients,
            subject,
            text,
        }),
    });
}

function labelFor(k) {
    return {
        slepM: 'Slepičí vejce — malé',
        slepV: 'Slepičí vejce — velké',
        zelM: 'Slepičí zelené vejce — malé',
        zelV: 'Slepičí zelené vejce — velké',
        krep: 'Křepelčí vejce',
    }[k] || k;
}

async function sendWhatsAppNotification(reservation) {
    const phone = String(process.env.OWNER_WHATSAPP_PHONE || '').replace(/\D/g, '');
    const apikey = process.env.CALLMEBOT_APIKEY;
    if (!phone || !apikey) return;

    const items = Object.entries(reservation.items)
        .map(([k, q]) => `${q} ks ${labelFor(k)}`)
        .join(', ');
    const contact = reservation.customer.phone || reservation.customer.email || '—';
    const text = [
        '🥚 Nová rezervace',
        reservation.customer.name,
        items,
        `Kód: ${reservation.pickupCode}`,
        `Kontakt: ${contact}`,
        reservation.totalKc ? `Cena: ${reservation.totalKc} Kč` : null,
    ].filter(Boolean).join('\n');

    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(apikey)}`;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error(`CallMeBot ${res.status}`);
}
