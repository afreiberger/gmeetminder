// SPDX-FileCopyrightText: 2026 Drew Freiberger
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Typed, self-documenting wrapper over the extension's Gio.Settings.
 *
 * Construct with the Gio.Settings you get from Extension.getSettings() (shell
 * side) or ExtensionPreferences.getSettings() (prefs side). Keeps GSettings key
 * strings in one place so no other module hard-codes them.
 */

import GObject from 'gi://GObject';

/** @typedef {import('./types.js').MeetingEvent} MeetingEvent */

/**
 * @typedef {Object} Bookmark
 * @property {string} name
 * @property {string} url
 */

export class Settings {
    /** @param {import('gi://Gio').Settings} gioSettings */
    constructor(gioSettings) {
        this._s = gioSettings;
    }

    /** Underlying Gio.Settings, for binding widgets in prefs. */
    get gio() {
        return this._s;
    }

    get joinMode() { return this._s.get_string('join-mode'); }          // 'auto-open' | 'notify'
    get leadTimeSeconds() { return this._s.get_int('lead-time-seconds'); }
    get chromeCommand() { return this._s.get_string('chrome-command'); }
    get chromeProfile() { return this._s.get_string('chrome-profile'); }
    get detectServices() { return this._s.get_boolean('detect-services'); }

    /** @returns {string[]} EDS source UIDs; empty array = all. */
    get enabledCalendars() { return this._s.get_strv('enabled-calendars'); }
    set enabledCalendars(uids) { this._s.set_strv('enabled-calendars', uids); }

    /** @returns {{requireMeetLink:boolean,skipDeclined:boolean,skipAllDay:boolean,requireAccepted:boolean}} */
    get filters() {
        return {
            requireMeetLink: this._s.get_boolean('filter-require-meet-link'),
            skipDeclined: this._s.get_boolean('filter-skip-declined'),
            skipAllDay: this._s.get_boolean('filter-skip-all-day'),
            requireAccepted: this._s.get_boolean('filter-require-accepted'),
        };
    }

    /** @returns {Bookmark[]} */
    get bookmarks() {
        return this._s.get_strv('bookmarks').map(s => {
            try { return JSON.parse(s); } catch { return null; }
        }).filter(b => b && b.url);
    }

    /** @param {Bookmark[]} list */
    set bookmarks(list) {
        this._s.set_strv('bookmarks', list.map(b => JSON.stringify({ name: b.name ?? '', url: b.url })));
    }

    /** @returns {number} unix ms */
    get lastRefresh() { return Number(this._s.get_int64('last-refresh')); }
    set lastRefresh(ms) { this._s.set_int64('last-refresh', ms); }

    /**
     * Subscribe to a key change.
     * @param {string} key GSettings key name.
     * @param {() => void} cb
     * @returns {number} handler id, disconnect with Settings#disconnect.
     */
    connect(key, cb) {
        return this._s.connect(`changed::${key}`, () => cb());
    }

    /** @param {number} id */
    disconnect(id) {
        this._s.disconnect(id);
    }
}
