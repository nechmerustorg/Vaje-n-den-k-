// GET /api/test-whatsapp?key=ACCESS_KEY — diagnostika WhatsApp notifikací.
// Vrací stav env vars + výsledek testovacího volání CallMeBota.
// Owner-only (ACCESS_KEY).

import { setCorsHeaders, handlePreflight, jsonError } from './_lib.js';

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

    const rawPhone = process.env.OWNER_WHATSAPP_PHONE || '';
    const apikey = process.env.CALLMEBOT_APIKEY || '';
    const phoneDigits = rawPhone.replace(/\D/g, '');

    const env = {
        OWNER_WHATSAPP_PHONE: {
            present: rawPhone.length > 0,
            rawLength: rawPhone.length,
            digitsLength: phoneDigits.length,
            startsWithPlus: rawPhone.startsWith('+'),
            firstThreeDigits: phoneDigits.slice(0, 3),
            lastTwoDigits: phoneDigits.slice(-2),
        },
        CALLMEBOT_APIKEY: {
            present: apikey.length > 0,
            length: apikey.length,
            isNumeric: /^\d+$/.test(apikey),
        },
    };

    if (!rawPhone || !apikey) {
        return res.status(200).json({
            ok: false,
            reason: 'env-missing',
            env,
            hint: 'Nastav OWNER_WHATSAPP_PHONE (formát 420XXXXXXXXX bez +) a CALLMEBOT_APIKEY (7-místné číslo) v Vercel Project Settings → Environment Variables a spusť Redeploy.',
        });
    }

    const testText = `🧪 Test WhatsApp notifikace z Vaječného deníku — ${new Date().toLocaleString('cs-CZ')}`;
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phoneDigits)}&text=${encodeURIComponent(testText)}&apikey=${encodeURIComponent(apikey)}`;

    try {
        const start = Date.now();
        const r = await fetch(url, { method: 'GET' });
        const elapsed = Date.now() - start;
        const bodyText = await r.text();
        return res.status(200).json({
            ok: r.ok,
            env,
            callmebot: {
                url: url.replace(apikey, '***'),
                status: r.status,
                ok: r.ok,
                elapsedMs: elapsed,
                bodySnippet: bodyText.slice(0, 600),
            },
            hint: r.ok
                ? 'Volání proběhlo. Pokud zpráva nedorazila na mobil, zkontroluj, že OWNER_WHATSAPP_PHONE je přesně to číslo, ze kterého jsi posílal aktivační zprávu CallMeBotovi.'
                : 'CallMeBot vrátil chybu — viz bodySnippet. Časté: špatný apikey, špatný formát čísla, telefon neaktivovaný (znovu pošli „I allow callmebot to send me messages" na +34 644 51 95 23).',
        });
    } catch (e) {
        return res.status(200).json({
            ok: false,
            env,
            error: e.message,
            hint: 'Síťová chyba při volání CallMeBota.',
        });
    }
}
