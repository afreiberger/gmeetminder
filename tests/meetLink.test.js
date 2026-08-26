// SPDX-FileCopyrightText: 2026 Drew Freiberger
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Unit tests for lib/meetLink.js — PURE extraction/classification.
 * Run via the runner (`gjs -m tests/runner.js`) or in isolation.
 */

import { describe, it, expect } from './harness.js';
import { makeEvent, Service } from '../gmeetminder@afreiberger.github.io/lib/types.js';
import { extract, enrich } from '../gmeetminder@afreiberger.github.io/lib/meetLink.js';

const DETECT = { detectServices: true };
const NO_DETECT = { detectServices: false };

describe('extract — X-GOOGLE-CONFERENCE', () => {
    it('wins even when a different link is in the description', () => {
        const raw = {
            location: '',
            description: 'Backup: https://meet.google.com/aaa-bbbb-ccc',
            url: '',
            xGoogleConference: 'https://meet.google.com/xgc-conf-url',
        };
        const r = extract(raw, DETECT);
        expect(r.url).toBe('https://meet.google.com/xgc-conf-url');
        expect(r.service).toBe(Service.MEET);
    });

    it('is ignored when empty (falls through to other fields)', () => {
        const raw = {
            location: 'https://meet.google.com/loc-atio-nnn',
            description: '',
            url: '',
            xGoogleConference: '',
        };
        const r = extract(raw, DETECT);
        expect(r.url).toBe('https://meet.google.com/loc-atio-nnn');
        expect(r.service).toBe(Service.MEET);
    });

    it('is ignored when not an https URL', () => {
        const raw = {
            location: '',
            description: 'https://meet.google.com/desc-ript-ion',
            url: '',
            xGoogleConference: 'conference-data-only',
        };
        const r = extract(raw, DETECT);
        expect(r.url).toBe('https://meet.google.com/desc-ript-ion');
        expect(r.service).toBe(Service.MEET);
    });
});

describe('extract — Google Meet across fields', () => {
    it('finds a Meet URL in location', () => {
        const raw = { location: 'https://meet.google.com/abc-defg-hij', description: '', url: '', xGoogleConference: '' };
        const r = extract(raw, NO_DETECT);
        expect(r.url).toBe('https://meet.google.com/abc-defg-hij');
        expect(r.service).toBe(Service.MEET);
    });

    it('finds a Meet URL in the description', () => {
        const raw = { location: '', description: 'Join here: https://meet.google.com/desc-link-one today', url: '', xGoogleConference: '' };
        const r = extract(raw, NO_DETECT);
        expect(r.url).toBe('https://meet.google.com/desc-link-one');
        expect(r.service).toBe(Service.MEET);
    });

    it('finds a Meet URL inside an HTML <a href> in the description', () => {
        const raw = {
            location: '',
            description: '<p>Video call: <a href="https://meet.google.com/href-link-two">meet</a></p>',
            url: '',
            xGoogleConference: '',
        };
        const r = extract(raw, NO_DETECT);
        expect(r.url).toBe('https://meet.google.com/href-link-two');
        expect(r.service).toBe(Service.MEET);
    });

    it('finds a Meet URL in the url field', () => {
        const raw = { location: '', description: '', url: 'https://meet.google.com/url-field-abc', xGoogleConference: '' };
        const r = extract(raw, NO_DETECT);
        expect(r.url).toBe('https://meet.google.com/url-field-abc');
        expect(r.service).toBe(Service.MEET);
    });

    it('honors field priority: location beats description', () => {
        const raw = {
            location: 'https://meet.google.com/loc-wins-aaa',
            description: 'https://meet.google.com/desc-lose-bbb',
            url: '',
            xGoogleConference: '',
        };
        const r = extract(raw, DETECT);
        expect(r.url).toBe('https://meet.google.com/loc-wins-aaa');
    });

    it('honors field priority: description beats url', () => {
        const raw = {
            location: '',
            description: 'https://meet.google.com/desc-wins-ccc',
            url: 'https://meet.google.com/url-lose-ddd',
            xGoogleConference: '',
        };
        const r = extract(raw, DETECT);
        expect(r.url).toBe('https://meet.google.com/desc-wins-ccc');
    });
});

describe('extract — Zoom', () => {
    it('detects a Zoom URL with a pwd query when detectServices=true', () => {
        const raw = {
            location: 'https://zoom.us/j/1234567890?pwd=aBcDeFgHiJ',
            description: '',
            url: '',
            xGoogleConference: '',
        };
        const r = extract(raw, DETECT);
        expect(r.url).toBe('https://zoom.us/j/1234567890?pwd=aBcDeFgHiJ');
        expect(r.service).toBe(Service.ZOOM);
    });

    it('detects a subdomain Zoom URL', () => {
        const raw = { location: '', description: 'https://redhat.zoom.us/j/98765', url: '', xGoogleConference: '' };
        const r = extract(raw, DETECT);
        expect(r.url).toBe('https://redhat.zoom.us/j/98765');
        expect(r.service).toBe(Service.ZOOM);
    });

    it('does NOT detect Zoom when detectServices=false', () => {
        const raw = { location: 'https://zoom.us/j/1234567890?pwd=xyz', description: '', url: '', xGoogleConference: '' };
        const r = extract(raw, NO_DETECT);
        expect(r.url).toBeNull();
        expect(r.service).toBeNull();
    });
});

describe('extract — Teams', () => {
    it('detects a Teams meetup-join URL when detectServices=true', () => {
        const raw = {
            location: '',
            description: 'Click https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=%7b%7d to join',
            url: '',
            xGoogleConference: '',
        };
        const r = extract(raw, DETECT);
        expect(r.url).toBe('https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=%7b%7d');
        expect(r.service).toBe(Service.TEAMS);
    });

    it('does NOT detect Teams when detectServices=false', () => {
        const raw = { location: 'https://teams.microsoft.com/l/meetup-join/19%3ax', description: '', url: '', xGoogleConference: '' };
        const r = extract(raw, NO_DETECT);
        expect(r.service).toBeNull();
    });
});

describe('extract — generic "other" fallback', () => {
    it('detects a Webex link as other when detectServices=true', () => {
        const raw = { location: '', description: 'Join: https://company.webex.com/meet/room123', url: '', xGoogleConference: '' };
        const r = extract(raw, DETECT);
        expect(r.url).toBe('https://company.webex.com/meet/room123');
        expect(r.service).toBe(Service.OTHER);
    });

    it('detects a Whereby link as other', () => {
        const raw = { location: 'https://whereby.com/my-room', description: '', url: '', xGoogleConference: '' };
        const r = extract(raw, DETECT);
        expect(r.service).toBe(Service.OTHER);
        expect(r.url).toBe('https://whereby.com/my-room');
    });

    it('ignores a non-meeting https URL', () => {
        const raw = { location: '', description: 'Agenda at https://example.com/docs/agenda', url: '', xGoogleConference: '' };
        const r = extract(raw, DETECT);
        expect(r.url).toBeNull();
        expect(r.service).toBeNull();
    });

    it('does NOT fall back to other when detectServices=false', () => {
        const raw = { location: 'https://company.webex.com/meet/room123', description: '', url: '', xGoogleConference: '' };
        const r = extract(raw, NO_DETECT);
        expect(r.service).toBeNull();
    });
});

describe('extract — service precedence within a field', () => {
    it('prefers Meet over Zoom regardless of order (Meet handled first, globally)', () => {
        const raw = {
            location: 'Zoom https://zoom.us/j/111 and Meet https://meet.google.com/win-over-zoom',
            description: '',
            url: '',
            xGoogleConference: '',
        };
        const r = extract(raw, DETECT);
        expect(r.service).toBe(Service.MEET);
        expect(r.url).toBe('https://meet.google.com/win-over-zoom');
    });

    it('prefers Zoom over Teams within the same field', () => {
        const raw = {
            location: 'https://teams.microsoft.com/l/meetup-join/xx https://zoom.us/j/222',
            description: '',
            url: '',
            xGoogleConference: '',
        };
        const r = extract(raw, DETECT);
        expect(r.service).toBe(Service.ZOOM);
    });
});

describe('extract — trailing punctuation and angle brackets', () => {
    it('strips wrapping angle brackets from a Meet URL', () => {
        const raw = { location: '<https://meet.google.com/angle-brack-ets>', description: '', url: '', xGoogleConference: '' };
        const r = extract(raw, DETECT);
        expect(r.url).toBe('https://meet.google.com/angle-brack-ets');
    });

    it('strips a trailing period from a generic URL', () => {
        const raw = { location: '', description: 'See https://company.webex.com/join/room9.', url: '', xGoogleConference: '' };
        const r = extract(raw, DETECT);
        expect(r.url).toBe('https://company.webex.com/join/room9');
    });

    it('strips a trailing paren from a Zoom URL', () => {
        const raw = { location: '(https://zoom.us/j/333?pwd=secret)', description: '', url: '', xGoogleConference: '' };
        const r = extract(raw, DETECT);
        expect(r.url).toBe('https://zoom.us/j/333?pwd=secret');
        expect(r.service).toBe(Service.ZOOM);
    });
});

describe('extract — robustness', () => {
    it('returns nulls for undefined raw', () => {
        const r = extract(undefined, DETECT);
        expect(r.url).toBeNull();
        expect(r.service).toBeNull();
    });

    it('treats undefined fields as empty', () => {
        const r = extract({ description: 'https://meet.google.com/only-desc-set' }, DETECT);
        expect(r.url).toBe('https://meet.google.com/only-desc-set');
        expect(r.service).toBe(Service.MEET);
    });

    it('returns nulls when nothing matches', () => {
        const raw = { location: 'Room 4B', description: 'Bring your laptop', url: '', xGoogleConference: '' };
        const r = extract(raw, DETECT);
        expect(r.url).toBeNull();
        expect(r.service).toBeNull();
    });
});

describe('enrich', () => {
    it('mutates the event and returns it (Meet link found)', () => {
        const event = makeEvent({
            id: 'e1',
            raw: { location: 'https://meet.google.com/enrich-test-01', description: '', url: '', xGoogleConference: '' },
        });
        const returned = enrich(event, DETECT);
        expect(returned).toBe(event);
        expect(event.joinUrl).toBe('https://meet.google.com/enrich-test-01');
        expect(event.service).toBe(Service.MEET);
    });

    it('sets joinUrl=null and service=null when no link is present', () => {
        const event = makeEvent({ id: 'e2', raw: { location: 'Cafeteria', description: '', url: '', xGoogleConference: '' } });
        enrich(event, DETECT);
        expect(event.joinUrl).toBeNull();
        expect(event.service).toBeNull();
    });

    it('respects detectServices=false (Zoom left unenriched)', () => {
        const event = makeEvent({ id: 'e3', raw: { location: 'https://zoom.us/j/444', description: '', url: '', xGoogleConference: '' } });
        enrich(event, NO_DETECT);
        expect(event.joinUrl).toBeNull();
        expect(event.service).toBeNull();
    });
});
