// Authoritative, dependency-free merge for the cloud data blob.
// Imported by /api/data. Kept pure (no KV, no Date) so it is unit-testable.
//
// CommonJS on purpose: Vercel transpiles the API functions to CommonJS, and a
// `.mjs` (forced-ESM) module can't be require()'d from there (ERR_REQUIRE_ESM).
// A plain CJS `.js` is require-able on Vercel AND importable from the .mjs tests
// via Node's CJS named-export interop.
//
// The cloud is the source of truth, sliced into independent sections that each
// carry their own "last modified" timestamp:
//   - records  -> recordsSavedAt
//   - settings -> settingsSavedAt
//
// Rule: for each section, the side with the NEWER timestamp wins. A client that
// sends a section with no timestamp (null/"") has "no opinion" and can never
// overwrite what the cloud already holds. This makes a stale or buggy client
// push non-destructive — the class of bug that kept wiping the saved settings.

const SECTIONS = [
    { data: 'records', ts: 'recordsSavedAt' },
    { data: 'settings', ts: 'settingsSavedAt' },
];

function has(obj, key) {
    return obj != null && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] != null;
}

// A section's timestamp, falling back to the legacy top-level savedAt for old blobs.
function sectionTs(blob, section) {
    if (!blob) return null;
    return blob[section.ts] || blob.savedAt || null;
}

function newest(a, b) {
    if (!a) return b || null;
    if (!b) return a || null;
    return a > b ? a : b;
}

// First write: accept incoming wholesale, guaranteeing both section timestamps.
function normalize(incoming, now) {
    const out = { ...incoming };
    out.recordsSavedAt = incoming.recordsSavedAt || incoming.savedAt || now;
    out.settingsSavedAt = incoming.settingsSavedAt || incoming.savedAt || now;
    out.savedAt = newest(out.recordsSavedAt, out.settingsSavedAt) || now;
    return out;
}

function mergeData(existing, incoming, now) {
    if (!incoming || typeof incoming !== 'object') {
        throw new Error('incoming must be an object');
    }
    if (!existing || typeof existing !== 'object') {
        return normalize(incoming, now);
    }

    const merged = { ...existing };

    for (const section of SECTIONS) {
        const inHas = has(incoming, section.data);
        const exHas = has(existing, section.data);
        const inTs = sectionTs(incoming, section);
        const exTs = sectionTs(existing, section);

        let takeIncoming;
        if (!inHas) {
            takeIncoming = false;              // client did not send this section
        } else if (!exHas) {
            takeIncoming = true;               // cloud had nothing here yet
        } else if (inTs && exTs) {
            takeIncoming = inTs > exTs;         // both dated -> newer wins
        } else if (inTs && !exTs) {
            takeIncoming = true;               // client has an opinion, cloud doesn't
        } else {
            takeIncoming = false;              // client has no timestamp -> protect the cloud
        }

        if (takeIncoming) {
            merged[section.data] = incoming[section.data];
            merged[section.ts] = inTs;
        } else {
            merged[section.data] = existing[section.data];
            merged[section.ts] = exTs;
        }
    }

    merged.savedAt = newest(merged.recordsSavedAt, merged.settingsSavedAt) || existing.savedAt || now;
    return merged;
}

module.exports = { mergeData };
