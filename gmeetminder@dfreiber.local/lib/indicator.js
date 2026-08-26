/**
 * Top-bar panel button + dropdown menu for gmeetminder.
 *
 * Renders the next-meeting countdown in the panel and, in the dropdown, a
 * MeetingBar-style agenda: a "Today" header, one row per today's event
 * (declined = struck-through/dim, in-progress = highlighted, rows with a
 * joinUrl are activatable), then Join-next / Create-meeting actions, an
 * optional Bookmarks section, and Preferences.
 *
 * Public API is consumed by extension.js — keep signatures stable.
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

/** @typedef {import('./types.js').MeetingEvent} MeetingEvent */

const PANEL_ICON = 'x-office-calendar-symbolic';

/** Subtle leading glyph per conferencing service. Kept as text so we don't
 *  depend on themed icons being present. */
const SERVICE_GLYPH = {
    meet: '📹',
    zoom: '🎦',
    teams: '👥',
    other: '🔗',
};

/** Escape text for Pango markup. */
function _escape(text) {
    return GLib.markup_escape_text(text ?? '', -1);
}

/** Format a Unix-ms timestamp as local "HH:MM". */
function _formatTime(unixMs) {
    const dt = GLib.DateTime.new_from_unix_local(Math.floor(unixMs / 1000));
    if (!dt)
        return '--:--';
    return dt.format('%H:%M');
}

/** Format today's date like "Fri, 26 Aug". */
function _formatToday() {
    const dt = GLib.DateTime.new_now_local();
    return dt ? dt.format('%a, %d %b') : '';
}

/**
 * One agenda row: leading service glyph + "HH:MM" + title.
 * Activatable only when the event has a joinUrl.
 */
const EventMenuItem = GObject.registerClass(
class EventMenuItem extends PopupMenu.PopupBaseMenuItem {
    /**
     * @param {MeetingEvent} event
     * @param {{ current:boolean, onActivate:(e:MeetingEvent)=>void }} opts
     */
    _init(event, opts) {
        const hasJoin = !!event.joinUrl;
        super._init({
            reactive: hasJoin,
            can_focus: hasJoin,
            style_class: 'gmeetminder-event',
        });

        const declined = event.rsvp === 'declined';
        if (event.allDay)
            this.add_style_class_name('gmeetminder-allday');
        if (declined)
            this.add_style_class_name('gmeetminder-declined');
        if (opts.current)
            this.add_style_class_name('gmeetminder-current');
        if (!hasJoin)
            this.add_style_class_name('gmeetminder-nojoin');

        const glyph = new St.Label({
            text: SERVICE_GLYPH[event.service] ?? '·',
            style_class: 'gmeetminder-glyph',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(glyph);

        const time = new St.Label({
            text: event.allDay ? 'all day' : _formatTime(event.start),
            style_class: 'gmeetminder-time',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(time);

        const title = event.title && event.title.length ? event.title : '(no title)';
        const label = new St.Label({
            style_class: 'gmeetminder-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        // Use markup so declined events can be shown struck-through (St CSS has
        // no text-decoration); highlight the in-progress event in bold.
        let markup = _escape(title);
        if (declined)
            markup = `<s>${markup}</s>`;
        if (opts.current)
            markup = `<b>${markup}</b>`;
        label.clutter_text.set_markup(markup);
        this.add_child(label);

        if (hasJoin) {
            this.connect('activate', () => opts.onActivate(event));
        }
    }
});

export const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    /**
     * @param {{
     *   onJoin:(e:MeetingEvent)=>void,
     *   onJoinNext:()=>void,
     *   onCreateMeeting:()=>void,
     *   onOpenBookmark:(b:{name:string,url:string})=>void,
     *   onOpenPrefs:()=>void,
     * }} callbacks
     */
    _init(callbacks) {
        super._init(0.0, 'gmeetminder');

        this._callbacks = callbacks ?? {};
        /** @type {MeetingEvent[]} */
        this._events = [];
        this._currentEventId = null;
        this._noAccount = false;

        // ---- Panel button: neutral icon + countdown label ----
        const box = new St.BoxLayout({ style_class: 'gmeetminder-panel-box' });
        this._panelIcon = new St.Icon({
            icon_name: PANEL_ICON,
            style_class: 'system-status-icon gmeetminder-panel-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelLabel = new St.Label({
            text: '',
            style_class: 'gmeetminder-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this._panelIcon);
        box.add_child(this._panelLabel);
        this.add_child(box);
        // Start in the neutral (no upcoming meeting) state.
        this.setCountdown('');

        // ---- Dropdown structure ----
        // Event agenda (rebuilt by setEvents / setNoAccount).
        this._eventSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._eventSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Join next meeting (with optional shortcut hint on the right).
        this._joinNextItem = new PopupMenu.PopupMenuItem(_('Join next meeting'));
        this._joinNextAccel = new St.Label({
            text: '',
            style_class: 'gmeetminder-accel',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._joinNextAccel.visible = false;
        this._joinNextItem.add_child(this._joinNextAccel);
        this._joinNextItem.connect('activate', () => this._callbacks.onJoinNext?.());
        this.menu.addMenuItem(this._joinNextItem);

        // Create instant meeting.
        this._createItem = new PopupMenu.PopupMenuItem(_('Create meeting'));
        this._createItem.connect('activate', () => this._callbacks.onCreateMeeting?.());
        this.menu.addMenuItem(this._createItem);

        // Bookmarks (rebuilt by setBookmarks; hidden when empty).
        this._bookmarkSection = new PopupMenu.PopupMenuSection();
        this._bookmarkSection.actor.visible = false;
        this.menu.addMenuItem(this._bookmarkSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Preferences.
        this._prefsItem = new PopupMenu.PopupMenuItem(_('Preferences'));
        this._prefsItem.connect('activate', () => this._callbacks.onOpenPrefs?.());
        this.menu.addMenuItem(this._prefsItem);

        this._renderEvents();
    }

    /**
     * Update the panel label text. Pass '' / null for the neutral "no upcoming
     * meeting" state (calendar glyph only).
     * @param {string} label
     */
    setCountdown(label) {
        const text = typeof label === 'string' ? label : '';
        if (text.length) {
            this._panelLabel.text = text;
            this._panelLabel.visible = true;
        } else {
            this._panelLabel.text = '';
            this._panelLabel.visible = false;
        }
    }

    /**
     * Rebuild the event list.
     * @param {MeetingEvent[]} events
     * @param {string|null} currentEventId id of the in-progress event to highlight
     */
    setEvents(events, currentEventId) {
        this._events = Array.isArray(events) ? events : [];
        this._currentEventId = currentEventId ?? null;
        this._renderEvents();
    }

    /**
     * Show a hint instead of events when no Google account is configured.
     * @param {boolean} missing
     */
    setNoAccount(missing) {
        this._noAccount = !!missing;
        this._renderEvents();
    }

    /** @param {Array<{name:string,url:string}>} bookmarks */
    setBookmarks(bookmarks) {
        const list = Array.isArray(bookmarks) ? bookmarks : [];
        this._bookmarkSection.removeAll();

        if (!list.length) {
            this._bookmarkSection.actor.visible = false;
            return;
        }

        this._bookmarkSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._bookmarkSection.addMenuItem(this._makeHeader(_('Bookmarks')));
        for (const bm of list) {
            const item = new PopupMenu.PopupMenuItem(bm.name || bm.url || '');
            item.connect('activate', () => this._callbacks.onOpenBookmark?.(bm));
            this._bookmarkSection.addMenuItem(item);
        }
        this._bookmarkSection.actor.visible = true;
    }

    /**
     * Set the shortcut hint shown next to "Join next meeting".
     * @param {string} accel e.g. 'Super+Shift+J'
     */
    setJoinNextAccel(accel) {
        const text = typeof accel === 'string' ? accel : '';
        this._joinNextAccel.text = text;
        this._joinNextAccel.visible = text.length > 0;
    }

    /** A dim, non-reactive section header row. */
    _makeHeader(text) {
        const header = new PopupMenu.PopupMenuItem(text, {
            reactive: false,
            can_focus: false,
            style_class: 'gmeetminder-header',
        });
        return header;
    }

    /** A dim, non-reactive informational row. */
    _makeHint(text) {
        const hint = new PopupMenu.PopupMenuItem(text, {
            reactive: false,
            can_focus: false,
            style_class: 'gmeetminder-hint',
        });
        hint.label.clutter_text.line_wrap = true;
        return hint;
    }

    /** Rebuild the agenda section from cached state. */
    _renderEvents() {
        this._eventSection.removeAll();

        if (this._noAccount) {
            this._eventSection.addMenuItem(
                this._makeHint(_('Connect a Google account in Settings → Online Accounts')));
            return;
        }

        this._eventSection.addMenuItem(
            this._makeHeader(`${_('Today')} (${_formatToday()})`));

        if (!this._events.length) {
            this._eventSection.addMenuItem(this._makeHint(_('No meetings today')));
            return;
        }

        for (const event of this._events) {
            const current = event.id != null && event.id === this._currentEventId;
            const item = new EventMenuItem(event, {
                current,
                onActivate: e => this._callbacks.onJoin?.(e),
            });
            this._eventSection.addMenuItem(item);
        }
    }
});
