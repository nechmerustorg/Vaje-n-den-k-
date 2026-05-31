// Reproduces the user's exact reported failure as an end-to-end protocol test:
// "I saved initial stock + prices, deleted the old records, then logged in via
//  the cloud backup — and my saved settings got wiped again."
//
// We drive the REAL server merge with the exact payloads the client sends, so a
// regression in the merge contract fails here. The invariant: a fresh/stale
// device coming in via the cloud can never destroy the saved settings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeData } from '../api/_merge.js';

// In-memory stand-in for Vercel KV + /api/data POST.
function makeCloud() {
    let blob = null;
    return {
        get: () => blob,
        // Mirrors api/data.js POST: merge incoming over existing, store, return merged.
        post: (incoming, now) => { blob = mergeData(blob, incoming, now); return blob; },
    };
}

const GOOD = {
    prices: { slepM: 5, slepV: 6, zelM: 7, zelV: 8, krep: 3 },
    initialStock: { slepM: 12, slepV: 30, zelM: 4, zelV: 0, krep: 6 },
};
const DEFAULTS = {
    prices: { slepM: 4.5, slepV: 5.5, zelM: 6, zelV: 6.5, krep: 3 },
    initialStock: { slepM: 0, slepV: 0, zelM: 0, zelV: 0, krep: 0 },
};

test('reported scenario: clearing history + logging in elsewhere keeps settings & stays empty', () => {
    const cloud = makeCloud();

    // 1) Main device saves initial stock + prices (a real settings change at T1)
    //    and still has a couple of old records.
    cloud.post({
        records: [{ date: '2026-05-25' }, { date: '2026-05-26' }],
        settings: GOOD,
        recordsSavedAt: '2026-05-31T08:00:00.000Z',
        settingsSavedAt: '2026-05-31T08:00:00.000Z',
    }, '2026-05-31T08:00:00.000Z');

    // 2) Main device clears all records (records bumped to T2, settings untouched -> null).
    cloud.post({
        records: [],
        settings: GOOD,
        recordsSavedAt: '2026-05-31T09:00:00.000Z',
        settingsSavedAt: null,
    }, '2026-05-31T09:00:00.000Z');

    let blob = cloud.get();
    assert.deepEqual(blob.records, [], 'history is cleared');
    assert.deepEqual(blob.settings, GOOD, 'settings survive the clear');

    // 3) "Login via cloud" on a fresh device: empty records + DEFAULT settings,
    //    NO modification timestamps (the device never changed anything itself).
    //    This is exactly the push that used to wipe everything.
    const merged = cloud.post({
        records: [],
        settings: DEFAULTS,
        recordsSavedAt: null,
        settingsSavedAt: null,
    }, '2026-05-31T10:00:00.000Z');

    assert.deepEqual(merged.settings, GOOD, 'settings MUST NOT be wiped by the fresh-device login');
    assert.deepEqual(merged.records, [], 'history MUST stay empty (deleted records do not resurrect)');

    // 4) The fresh device adopts the merged truth -> it now shows the good settings.
    assert.deepEqual(merged.settings.initialStock, GOOD.initialStock);
});

test('genuine settings change from a device still wins (we did not over-lock)', () => {
    const cloud = makeCloud();
    cloud.post({ records: [], settings: DEFAULTS, recordsSavedAt: 'T1', settingsSavedAt: 'T1' }, 'T1');
    // User really edits the stock/prices -> bumps settingsSavedAt to T2.
    const merged = cloud.post({ records: [], settings: GOOD, recordsSavedAt: 'T1', settingsSavedAt: 'T2' }, 'T2');
    assert.deepEqual(merged.settings, GOOD, 'a real, newer settings change must apply');
});
