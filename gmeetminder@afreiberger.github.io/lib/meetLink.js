// SPDX-FileCopyrightText: 2026 Drew Freiberger
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Meet-link extraction + service classification.
 *
 * PURE JavaScript — no `gi://` imports — so it can be unit-tested with plain
 * `gjs`. Given an event's raw text fields it finds a join URL and classifies
 * the conferencing service.
 *
 * Priority (see design spec "Meet-link extraction"):
 *   1. X-GOOGLE-CONFERENCE property (cleanest) -> Meet.
 *   2. https://meet.google.com/<code> across location, description, url.
 *   3. If detectServices: Zoom, Teams, then a generic meeting-URL fallback.
 */

import { Service } from './types.js';

/** Google Meet URL. Host is matched case-insensitively; code is lowercase+hyphens. */
const MEET_RE = /https:\/\/meet\.google\.com\/[a-z0-9-]+/i;

/** Zoom join URL, optionally carrying a ?pwd=... (or other) query up to whitespace. */
const ZOOM_RE = /https:\/\/[\w.-]*zoom\.us\/j\/\d+(?:\?[^\s<>"']*)?/i;

/** Microsoft Teams meetup-join URL. */
const TEAMS_RE = /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s<>"']+/i;

/** Any https URL (global, for scanning a field for a generic fallback). */
const ANY_HTTPS_RE = /https:\/\/[^\s<>"']+/gi;

/** Substrings that make a generic https URL "look like" a meeting link. */
const GENERIC_KEYWORDS = [
    'webex', 'whereby', 'meet', 'join', 'zoom', 'teams', 'bluejeans', 'chime',
];

/** Coerce a possibly-undefined field into a string. */
function str(v) {
    return typeof v === 'string' ? v : '';
}

/**
 * Strip wrapping angle brackets and trailing punctuation that Google descriptions
 * often glue onto links (e.g. `<https://…>`, `https://…).`).
 * @param {string} url
 * @returns {string}
 */
function cleanUrl(url) {
    let u = String(url).trim();
    // Leading angle bracket / quote (rare — regexes above already exclude them).
    while (u.length && (u[0] === '<' || u[0] === '"' || u[0] === "'"))
        u = u.slice(1);
    // Trailing punctuation, closing bracket, or quote.
    u = u.replace(/[>.,)\]'"]+$/, '');
    return u;
}

/**
 * Find the first generic meeting-looking https URL in a single field.
 * @param {string} text
 * @returns {string|null}
 */
function findGeneric(text) {
    const matches = text.match(ANY_HTTPS_RE);
    if (!matches)
        return null;
    for (const m of matches) {
        const cleaned = cleanUrl(m);
        const lower = cleaned.toLowerCase();
        if (GENERIC_KEYWORDS.some(k => lower.includes(k)))
            return cleaned;
    }
    return null;
}

/**
 * Extract a join URL and classify the conferencing service from an event's raw text.
 * @param {import('./types.js').RawEventText} raw  {location, description, url, xGoogleConference}
 * @param {{detectServices:boolean}} opts
 * @returns {{url: string|null, service: ('meet'|'zoom'|'teams'|'other'|null)}}
 */
export function extract(raw, opts) {
    raw = raw || {};
    const detect = !!(opts && opts.detectServices);
    const fields = [str(raw.location), str(raw.description), str(raw.url)];

    // 1. X-GOOGLE-CONFERENCE wins outright when it's a non-empty https URL.
    const xgc = str(raw.xGoogleConference).trim();
    if (xgc && /^https:\/\//i.test(xgc))
        return { url: cleanUrl(xgc), service: Service.MEET };

    // 2. Google Meet URL, searching fields in priority order (location > description > url).
    for (const f of fields) {
        const m = f.match(MEET_RE);
        if (m)
            return { url: cleanUrl(m[0]), service: Service.MEET };
    }

    // 3. Other services (only when enabled). Field order is the outer loop;
    //    within a field check Zoom, then Teams, then generic. First hit wins.
    if (detect) {
        for (const f of fields) {
            const zm = f.match(ZOOM_RE);
            if (zm)
                return { url: cleanUrl(zm[0]), service: Service.ZOOM };
            const tm = f.match(TEAMS_RE);
            if (tm)
                return { url: cleanUrl(tm[0]), service: Service.TEAMS };
            const g = findGeneric(f);
            if (g)
                return { url: g, service: Service.OTHER };
        }
    }

    // 4. Nothing found.
    return { url: null, service: null };
}

/**
 * Enrich a MeetingEvent in place: sets event.joinUrl and event.service from event.raw.
 * Returns the same event for chaining.
 * @param {import('./types.js').MeetingEvent} event
 * @param {{detectServices:boolean}} opts
 * @returns {import('./types.js').MeetingEvent}
 */
export function enrich(event, opts) {
    const { url, service } = extract(event.raw, opts);
    event.joinUrl = url;
    event.service = service;
    return event;
}
