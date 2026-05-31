// Tests for the authoritative cloud-blob merge.
// Run: node --test test/merge.test.mjs
//
// The invariant we lock in: a client push can NEVER destroy a section
// (records / settings) that is newer in the cloud. An older or
// "no opinion" (null-timestamp) section is always rejected in favour of
// what the cloud already holds. This is the safety net that makes any
// client-side sync bug non-destructive.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeData } from '../api/_merge.mjs';

const NOW = '2026-05-31T12:00:00.000Z';
const GOOD_SETTINGS = {
    prices: { slepM: 4.5, slepV: 5.5, zelM: 6, zelV: 6.5, krep: 3 },
    initialStock: { slepM: 10, slepV: 20, zelM: 5, zelV: 0, krep: 2 },
};
const DEFAULT_SETTINGS = {
    prices: { slepM: 4.5, slepV: 5.5, zelM: 6, zelV: 6.5, krep: 3 },
    initialStock: { slepM: 0, slepV: 0, zelM: 0, zelV: 0, krep: 0 },
};

test('first write (empty cloud) accepts incoming and stamps timestamps', () => {
    const incoming = { records: [{ date: '2026-05-31' }], settings: GOOD_SETTINGS, recordsSavedAt: 'T1', settingsSavedAt: 'T1' };
    const merged = mergeData(null, incoming, NOW);
    assert.deepEqual(merged.records, incoming.records);
    assert.deepEqual(merged.settings, GOOD_SETTINGS);
    assert.equal(merged.recordsSavedAt, 'T1');
    assert.equal(merged.settingsSavedAt, 'T1');
});

test('newer settings win', () => {
    const existing = { records: [], settings: DEFAULT_SETTINGS, recordsSavedAt: 'T1', settingsSavedAt: 'T1', savedAt: 'T1' };
    const incoming = { records: [], settings: GOOD_SETTINGS, recordsSavedAt: 'T1', settingsSavedAt: 'T2' };
    const merged = mergeData(existing, incoming, NOW);
    assert.deepEqual(merged.settings, GOOD_SETTINGS);
    assert.equal(merged.settingsSavedAt, 'T2');
});

test('older settings are rejected (cloud keeps newer)', () => {
    const existing = { records: [], settings: GOOD_SETTINGS, recordsSavedAt: 'T2', settingsSavedAt: 'T2', savedAt: 'T2' };
    const incoming = { records: [], settings: DEFAULT_SETTINGS, recordsSavedAt: 'T1', settingsSavedAt: 'T1' };
    const merged = mergeData(existing, incoming, NOW);
    assert.deepEqual(merged.settings, GOOD_SETTINGS, 'good settings must survive an older push');
    assert.equal(merged.settingsSavedAt, 'T2');
});

test('null-timestamp settings can NEVER overwrite existing settings (the wipe bug)', () => {
    // Fresh/stale device: form shows defaults, user only entered the cloud key.
    // It pushes default settings with no "modified" timestamp.
    const existing = { records: [{ date: '2026-05-30' }], settings: GOOD_SETTINGS, recordsSavedAt: 'T2', settingsSavedAt: 'T2', savedAt: 'T2' };
    const incoming = { records: [], settings: DEFAULT_SETTINGS, recordsSavedAt: null, settingsSavedAt: null };
    const merged = mergeData(existing, incoming, NOW);
    assert.deepEqual(merged.settings, GOOD_SETTINGS, 'settings must not be wiped by a no-opinion push');
    assert.deepEqual(merged.records, existing.records, 'records must not be wiped by a no-opinion push');
});

test('clearing records (newer empty array) wins', () => {
    const existing = { records: [{ date: '2026-01-01' }, { date: '2026-01-02' }], settings: GOOD_SETTINGS, recordsSavedAt: 'T1', settingsSavedAt: 'T1', savedAt: 'T1' };
    const incoming = { records: [], settings: GOOD_SETTINGS, recordsSavedAt: 'T2', settingsSavedAt: null };
    const merged = mergeData(existing, incoming, NOW);
    assert.deepEqual(merged.records, [], 'an explicit, newer clear must propagate');
    assert.equal(merged.recordsSavedAt, 'T2');
});

test('THE scenario: clearing records keeps the good settings intact', () => {
    // User clears all records (recordsSavedAt bumped) but did not touch settings
    // (settingsSavedAt = null). Settings must survive.
    const existing = { records: [{ date: '2026-01-01' }], settings: GOOD_SETTINGS, recordsSavedAt: 'T1', settingsSavedAt: 'T1', savedAt: 'T1' };
    const incoming = { records: [], settings: GOOD_SETTINGS, recordsSavedAt: 'T2', settingsSavedAt: null };
    const merged = mergeData(existing, incoming, NOW);
    assert.deepEqual(merged.records, []);
    assert.deepEqual(merged.settings, GOOD_SETTINGS);
    assert.equal(merged.settingsSavedAt, 'T1', 'settings timestamp preserved');
});

test('back-compat: existing blob with only top-level savedAt is treated as both section timestamps', () => {
    const existing = { records: [{ date: '2026-05-30' }], settings: GOOD_SETTINGS, savedAt: 'T5' }; // legacy, no section ts
    const incoming = { records: [], settings: DEFAULT_SETTINGS, recordsSavedAt: 'T4', settingsSavedAt: 'T4' };
    const merged = mergeData(existing, incoming, NOW);
    // incoming T4 < legacy T5 -> legacy wins for both sections
    assert.deepEqual(merged.records, existing.records);
    assert.deepEqual(merged.settings, GOOD_SETTINGS);
});

test('a section the client did not send is left untouched', () => {
    const existing = { records: [{ date: '2026-05-30' }], settings: GOOD_SETTINGS, recordsSavedAt: 'T2', settingsSavedAt: 'T2', savedAt: 'T2' };
    const incoming = { records: [{ date: '2026-05-31' }], recordsSavedAt: 'T3' }; // no settings key at all
    const merged = mergeData(existing, incoming, NOW);
    assert.deepEqual(merged.records, incoming.records);
    assert.deepEqual(merged.settings, GOOD_SETTINGS, 'omitted section must be preserved');
});

test('top-level savedAt reflects the newest section', () => {
    const existing = { records: [], settings: DEFAULT_SETTINGS, recordsSavedAt: 'T1', settingsSavedAt: 'T1', savedAt: 'T1' };
    const incoming = { records: [{ date: '2026-05-31' }], settings: GOOD_SETTINGS, recordsSavedAt: 'T9', settingsSavedAt: 'T3' };
    const merged = mergeData(existing, incoming, NOW);
    assert.equal(merged.savedAt, 'T9');
});
