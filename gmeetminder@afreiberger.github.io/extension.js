// SPDX-FileCopyrightText: 2026 Drew Freiberger
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * gmeetminder — GNOME Shell extension entry point.
 *
 * Wires the modules together:
 *   CalendarSource (EDS)  → MeetingEvent[]
 *   meetLink.enrich       → joinUrl/service
 *   Scheduler             → countdown ticks + start-lead triggers
 *   Indicator             → panel button + dropdown
 *   launcher / notifier   → open Chrome or notify
 *
 * Keeps its own logic thin: modules do the work, this file coordinates
 * lifecycle, settings reactions, and the global "join next" keybinding.
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Settings } from './lib/settings.js';
import { CalendarSource } from './lib/calendarSource.js';
import { enrich } from './lib/meetLink.js';
import { Scheduler } from './lib/scheduler.js';
import { Indicator } from './lib/indicator.js';
import * as launcher from './lib/launcher.js';
import * as notifier from './lib/notifier.js';

const KEY_JOIN_NEXT = 'join-next-shortcut';
const REFRESH_DEBOUNCE_MS = 1500;
const SAFETY_REPOLL_MS = 5 * 60 * 1000;

export default class GmeetminderExtension extends Extension {
    enable() {
        this._settings = new Settings(this.getSettings());
        this._events = [];
        this._refreshTimer = 0;
        this._repollTimer = 0;
        this._settingsHandlers = [];

        // Panel indicator with all user actions routed back here.
        this._indicator = new Indicator({
            onJoin: (event) => this._openEvent(event),
            onJoinNext: () => this._joinNext(),
            onCreateMeeting: () => this._createMeeting(),
            onOpenBookmark: (bm) => this._openUrl(bm?.url),
            onOpenPrefs: () => this.openPreferences(),
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // Scheduler with GLib-backed, injectable timers.
        this._scheduler = new Scheduler({
            now: () => Date.now(),
            setTimer: (delayMs, cb) =>
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, delayMs), () => {
                    cb();
                    return GLib.SOURCE_REMOVE;
                }),
            clearTimer: (id) => { if (id) GLib.source_remove(id); },
            setInterval: (periodMs, cb) =>
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, periodMs), () => {
                    cb();
                    return GLib.SOURCE_CONTINUE;
                }),
            clearInterval: (id) => { if (id) GLib.source_remove(id); },
        });
        this._scheduler.onTick = (info) => this._onTick(info);
        this._scheduler.onTrigger = (event, reason) => this._onTrigger(event, reason);
        this._scheduler.start();

        // Calendar source (EDS). init() is async and must never throw.
        this._source = new CalendarSource();
        this._changedHandler = 0;
        this._source.init()
            .then(() => {
                this._changedHandler = this._source.connectChanged(() => this._scheduleRefresh());
                this._refresh();
            })
            .catch((e) => {
                console.log('[gmeetminder] CalendarSource.init failed:', e?.message ?? e);
                this._indicator.setNoAccount(true);
            });

        // React to settings changes that affect filtering/UI/keybinding.
        for (const key of [
            'lead-time-seconds', 'filter-require-meet-link', 'filter-skip-declined',
            'filter-skip-all-day', 'filter-require-accepted', 'detect-services',
            'enabled-calendars', 'bookmarks', 'join-mode',
        ]) {
            this._settingsHandlers.push(this._settings.connect(key, () => this._refresh()));
        }
        this._settingsHandlers.push(this._settings.connect(KEY_JOIN_NEXT, () => this._rebindShortcut()));

        this._bindShortcut();

        // Safety re-poll in case an EDS change signal is missed.
        this._repollTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAFETY_REPOLL_MS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        this._unbindShortcut();

        if (this._refreshTimer) { GLib.source_remove(this._refreshTimer); this._refreshTimer = 0; }
        if (this._repollTimer) { GLib.source_remove(this._repollTimer); this._repollTimer = 0; }

        for (const id of this._settingsHandlers ?? [])
            this._settings?.disconnect(id);
        this._settingsHandlers = [];

        if (this._source) {
            if (this._changedHandler) this._source.disconnectChanged(this._changedHandler);
            this._source.destroy();
            this._source = null;
        }
        if (this._scheduler) { this._scheduler.destroy(); this._scheduler = null; }
        if (this._indicator) { this._indicator.destroy(); this._indicator = null; }

        this._settings = null;
        this._events = [];
    }

    // ---- refresh pipeline ------------------------------------------------

    _scheduleRefresh() {
        if (this._refreshTimer) GLib.source_remove(this._refreshTimer);
        this._refreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DEBOUNCE_MS, () => {
            this._refreshTimer = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _refresh() {
        if (!this._source || !this._settings) return;
        const detectServices = this._settings.detectServices;
        this._source.getTodayEvents({ enabledCalendars: this._settings.enabledCalendars })
            .then((events) => {
                events = events ?? [];
                for (const e of events) enrich(e, { detectServices });
                events.sort((a, b) => a.start - b.start);
                this._events = events;

                // Show the "connect an account" hint only when EDS exposes no
                // calendars at all. Do NOT gate on hasGoogleAccount(): corporate
                // Workspace calendars often appear via the caldav backend (not
                // GOA "google"), yet still carry Meet links we can use.
                const noCalendars = (this._source.listCalendars()?.length ?? 0) === 0;
                this._indicator.setNoAccount(noCalendars);
                this._indicator.setBookmarks(this._settings.bookmarks);

                this._scheduler.update(events, {
                    leadTimeSeconds: this._settings.leadTimeSeconds,
                    filters: this._settings.filters,
                });
                const next = this._scheduler.nextEvent();
                this._indicator.setEvents(events, this._currentEventId(next));
                this._settings.lastRefresh = Date.now();
            })
            .catch((e) => console.log('[gmeetminder] refresh failed:', e?.message ?? e));
    }

    _currentEventId(next) {
        const now = Date.now();
        if (next && next.start <= now && now < next.end) return next.id;
        return null;
    }

    // ---- scheduler callbacks ---------------------------------------------

    _onTick(info) {
        if (!this._indicator) return;
        const label = info?.event ? `${this._short(info.event.title)} ${info.label}`.trim() : '';
        this._indicator.setCountdown(label);
    }

    _onTrigger(event, reason) {
        if (!event) return;
        // In-progress meetings (present at load/login) always notify — never surprise-launch.
        if (reason === 'in-progress') {
            notifier.notifyInProgress(event, { onJoin: () => this._openEvent(event) });
            return;
        }
        if (this._settings.joinMode === 'auto-open' && event.joinUrl) {
            this._openEvent(event);
        } else {
            notifier.notifyJoin(event, { onJoin: () => this._openEvent(event) });
        }
    }

    // ---- actions ---------------------------------------------------------

    _openEvent(event) {
        if (!event?.joinUrl) {
            console.log('[gmeetminder] no join URL for event:', event?.title);
            return;
        }
        this._openUrl(event.joinUrl);
    }

    _openUrl(url) {
        if (!url || !this._settings) return;
        launcher.open({
            chromeCommand: this._settings.chromeCommand,
            chromeProfile: this._settings.chromeProfile,
            url,
        });
    }

    _createMeeting() {
        if (!this._settings) return;
        launcher.createInstantMeeting({
            chromeCommand: this._settings.chromeCommand,
            chromeProfile: this._settings.chromeProfile,
        });
    }

    _joinNext() {
        // Prefer the soonest upcoming event that actually has a join URL.
        const now = Date.now();
        const joinable = this._events
            .filter((e) => e.joinUrl && e.end > now)
            .sort((a, b) => a.start - b.start);
        const target = joinable[0] ?? this._scheduler?.nextEvent();
        if (target?.joinUrl) this._openEvent(target);
        else console.log('[gmeetminder] join-next: no joinable meeting');
    }

    // ---- keybinding ------------------------------------------------------

    _bindShortcut() {
        Main.wm.addKeybinding(
            KEY_JOIN_NEXT,
            this._settings.gio,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._joinNext()
        );
    }

    _unbindShortcut() {
        try { Main.wm.removeKeybinding(KEY_JOIN_NEXT); } catch (_) {}
    }

    _rebindShortcut() {
        this._unbindShortcut();
        this._bindShortcut();
    }

    // ---- helpers ---------------------------------------------------------

    _short(title, max = 25) {
        title = title || 'Meeting';
        return title.length > max ? `${title.slice(0, max - 1)}…` : title;
    }
}
