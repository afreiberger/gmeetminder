#!/usr/bin/env gjs
// SPDX-FileCopyrightText: 2026 Drew Freiberger
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * eds_probe.js — standalone smoke test for lib/calendarSource.js.
 *
 * NOT part of the unit runner. Run on a real GNOME session with a Google account
 * configured in Settings → Online Accounts:
 *
 *     gjs -m tests/eds_probe.js
 *
 * It builds a CalendarSource, initializes it, prints the calendar catalog, and
 * prints a REDACTED summary of today's events (title, start, allDay, rsvp, and
 * which raw field carries a meeting-link candidate). It never prints private
 * descriptions/locations — only booleans/lengths — so it is safe to paste into a
 * bug report. In a headless environment it will simply print zero calendars.
 *
 * NOTE ON EXIT: on systems with EDS configured, standalone `gjs` may print a
 * "Segmentation fault" AFTER the final "done." line. This is a known
 * libedataserver teardown artifact when the whole gjs interpreter exits with a
 * live SourceRegistry D-Bus worker (it reproduces with a two-line registry-only
 * script). It happens only at process exit, after all work has completed and all
 * output has printed, and does NOT occur inside gnome-shell (a long-lived process
 * where disable() merely drops references). Treat any crash BEFORE "done." as a
 * real failure; a crash after it is benign.
 */

import GLib from 'gi://GLib';

// Resolve this script's directory so the import works regardless of CWD.
const thisFile = GLib.filename_from_uri(import.meta.url)[0];
const thisDir = GLib.path_get_dirname(thisFile);
const sourceUri = GLib.filename_to_uri(
    GLib.build_filenamev([thisDir, '..', 'gmeetminder@afreiberger.github.io', 'lib', 'calendarSource.js']), null);

function fmtTime(ms) {
    if (!ms)
        return '(none)';
    try {
        const dt = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
        return dt.format('%Y-%m-%d %H:%M');
    } catch (_e) {
        return `${ms}`;
    }
}

/** Which raw field would a link come from? (Presence only — no contents.) */
function linkField(raw) {
    raw = raw || {};
    if (raw.xGoogleConference)
        return 'X-GOOGLE-CONFERENCE';
    const meet = /https:\/\/meet\.google\.com\//i;
    if (meet.test(raw.location || ''))
        return 'location';
    if (meet.test(raw.description || ''))
        return 'description';
    if (meet.test(raw.url || ''))
        return 'url';
    // Non-Meet hint: any https anywhere.
    if (/https:\/\//i.test(raw.location || '') || /https:\/\//i.test(raw.description || '') || /https:\/\//i.test(raw.url || ''))
        return 'other-url(present)';
    return 'none';
}

async function main() {
    const mod = await import(sourceUri);
    const { CalendarSource } = mod;

    const src = new CalendarSource();
    print('--- init() ---');
    await src.init();

    print('\n--- listCalendars() ---');
    const cals = src.listCalendars();
    print(`hasGoogleAccount() = ${src.hasGoogleAccount()}`);
    print(`calendars: ${cals.length}`);
    for (const c of cals)
        print(`  uid=${c.uid} google=${c.isGoogle} backend=${c.backendName || '?'} name="${c.displayName}"`);

    print('\n--- getTodayEvents({ enabledCalendars: [] }) ---');
    const events = await src.getTodayEvents({ enabledCalendars: [] });
    print(`events today: ${events.length}`);
    for (const e of events) {
        print([
            `  "${e.title || '(no title)'}"`,
            `start=${fmtTime(e.start)}`,
            `end=${fmtTime(e.end)}`,
            `allDay=${e.allDay}`,
            `rsvp=${e.rsvp}`,
            `link-from=${linkField(e.raw)}`,
            `service=${e.service === null ? 'null' : e.service}`, // left null by design; meetLink enriches
        ].join('  '));
    }

    // Exercise change-watch registration/teardown (no-op safe headless).
    const hid = src.connectChanged(() => print('  [changed]'));
    src.disconnectChanged(hid);

    print('\n--- destroy() ---');
    src.destroy();
    print('done.');
}

const loop = new GLib.MainLoop(null, false);
main()
    .catch(e => {
        printerr(`PROBE ERROR: ${e}\n${e && e.stack ? e.stack : ''}`);
    })
    .finally(() => loop.quit());
loop.run();
