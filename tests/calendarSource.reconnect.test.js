// SPDX-FileCopyrightText: 2026 Andy Nelson
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Unit tests for CalendarSource.reconnectFailed().
 *
 * CalendarSource depends on gi://GLib and gi://Gio (available in plain GJS)
 * at module level; the heavier EDS/ECal/ICalGLib typelibs are deferred to
 * init() and are NOT loaded here. We import the class, borrow its
 * reconnectFailed() prototype method, and exercise it against a minimal fake
 * internal state — no GNOME Shell session required.
 *
 * Async Promise microtasks are drained between steps via flush(), which runs
 * the GLib main context until no pending sources remain.
 */

import GLib from 'gi://GLib';
import { describe, it, expect } from './harness.js';
import { CalendarSource } from '../gmeetminder@afreiberger.github.io/lib/calendarSource.js';

/** Drain pending Promise microtasks by iterating the GLib main context. */
function flush() {
    const ctx = GLib.MainContext.default();
    for (let i = 0; i < 10; i++) ctx.iteration(false);
}

/**
 * Build a minimal fake subject with CalendarSource.prototype.reconnectFailed
 * bound to it. callerOpts overrides any default property.
 */
function makeSubject(callerOpts = {}) {
    const notifyCalls = [];
    const connectCalls = [];
    const subject = {
        _destroyed: false,
        _ECal: {},
        _entries: new Map(),
        _connectClient(source) {
            connectCalls.push(source);
            return Promise.resolve({ _fakeClient: true });
        },
        _notifyChanged() { notifyCalls.push(1); },
        ...callerOpts,
    };
    subject.reconnectFailed = CalendarSource.prototype.reconnectFailed.bind(subject);
    return { subject, notifyCalls, connectCalls };
}

function makeEntry(uid, overrides = {}) {
    return { uid, backendName: 'caldav', source: { uid }, client: null, _reconnecting: false, ...overrides };
}

// ---------------------------------------------------------------------------
// Guard conditions (synchronous)
// ---------------------------------------------------------------------------

describe('reconnectFailed — guard conditions', () => {
    it('does nothing when _destroyed is true', () => {
        const entry = makeEntry('a');
        const { subject } = makeSubject({
            _destroyed: true,
            _entries: new Map([['a', entry]]),
        });
        subject.reconnectFailed();
        expect(entry._reconnecting).toBe(false);
    });

    it('does nothing when _ECal is falsy', () => {
        const entry = makeEntry('a');
        const { subject } = makeSubject({
            _ECal: null,
            _entries: new Map([['a', entry]]),
        });
        subject.reconnectFailed();
        expect(entry._reconnecting).toBe(false);
    });

    it('skips entries that already have a client', () => {
        const entry = makeEntry('a', { client: { _fakeClient: true } });
        const { subject, connectCalls } = makeSubject({
            _entries: new Map([['a', entry]]),
        });
        subject.reconnectFailed();
        expect(connectCalls.length).toBe(0);
    });

    it('skips entries already reconnecting (_reconnecting guard)', () => {
        const entry = makeEntry('a', { _reconnecting: true });
        const { subject, connectCalls } = makeSubject({
            _entries: new Map([['a', entry]]),
        });
        subject.reconnectFailed();
        expect(connectCalls.length).toBe(0);
    });

    it('sets _reconnecting synchronously before the async connect call', () => {
        let flagDuringConnect = null;
        const entry = makeEntry('a');
        const { subject } = makeSubject({
            _entries: new Map([['a', entry]]),
            _connectClient(_source) {
                flagDuringConnect = entry._reconnecting;
                return new Promise(() => {}); // never resolves
            },
        });
        subject.reconnectFailed();
        expect(flagDuringConnect).toBe(true);
    });

    it('does not attempt a second connect if called again while reconnecting', () => {
        const entry = makeEntry('a');
        const connectCalls = [];
        const { subject } = makeSubject({
            _entries: new Map([['a', entry]]),
            _connectClient(source) {
                connectCalls.push(source);
                return new Promise(() => {}); // never resolves
            },
        });
        subject.reconnectFailed();
        subject.reconnectFailed(); // second call while _reconnecting=true
        expect(connectCalls.length).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Async success / failure (microtasks drained via flush())
// ---------------------------------------------------------------------------

describe('reconnectFailed — async success', () => {
    it('sets entry.client and calls _notifyChanged() on successful connect', () => {
        const entry = makeEntry('a');
        const fakeClient = { _fakeClient: true };
        const { subject, notifyCalls } = makeSubject({
            _entries: new Map([['a', entry]]),
            _connectClient: () => Promise.resolve(fakeClient),
        });
        subject.reconnectFailed();
        flush();
        expect(entry.client).toBe(fakeClient);
        expect(notifyCalls.length).toBe(1);
    });

    it('clears _reconnecting after a successful connect', () => {
        const entry = makeEntry('a');
        const { subject } = makeSubject({
            _entries: new Map([['a', entry]]),
            _connectClient: () => Promise.resolve({ _fakeClient: true }),
        });
        subject.reconnectFailed();
        flush();
        expect(entry._reconnecting).toBe(false);
    });

    it('does not set client or notify if _destroyed before connect resolves', () => {
        const entry = makeEntry('a');
        const { subject, notifyCalls } = makeSubject({
            _entries: new Map([['a', entry]]),
            _connectClient() {
                subject._destroyed = true; // simulate disable() mid-flight
                return Promise.resolve({ _fakeClient: true });
            },
        });
        subject.reconnectFailed();
        flush();
        expect(entry.client).toBe(null);
        expect(notifyCalls.length).toBe(0);
    });

    it('does not set client or notify if connect resolves with a falsy value', () => {
        const entry = makeEntry('a');
        const { subject, notifyCalls } = makeSubject({
            _entries: new Map([['a', entry]]),
            _connectClient: () => Promise.resolve(null),
        });
        subject.reconnectFailed();
        flush();
        expect(entry.client).toBe(null);
        expect(notifyCalls.length).toBe(0);
    });
});

describe('reconnectFailed — async failure', () => {
    it('clears _reconnecting after a failed connect', () => {
        const entry = makeEntry('a');
        const { subject } = makeSubject({
            _entries: new Map([['a', entry]]),
            _connectClient: () => Promise.reject(new Error('timeout')),
        });
        subject.reconnectFailed();
        flush();
        expect(entry._reconnecting).toBe(false);
    });

    it('leaves entry.client null and does not notify after a failed connect', () => {
        const entry = makeEntry('a');
        const { subject, notifyCalls } = makeSubject({
            _entries: new Map([['a', entry]]),
            _connectClient: () => Promise.reject(new Error('cancelled')),
        });
        subject.reconnectFailed();
        flush();
        expect(entry.client).toBe(null);
        expect(notifyCalls.length).toBe(0);
    });
});
