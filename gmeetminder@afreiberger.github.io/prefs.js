// SPDX-FileCopyrightText: 2026 Drew Freiberger
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * gmeetminder — libadwaita preferences window.
 *
 * Runs in a plain Gtk4/libadwaita process (not the shell), so this file may
 * only import Adw/Gtk/Gio/GLib and the extension's pure-ish lib modules. All
 * rows are bound to the extension's GSettings (schema
 * org.gnome.shell.extensions.gmeetminder). Simple bool/int/string keys use
 * Gio.Settings.bind(); enum / list-valued keys (join-mode, chrome-profile,
 * enabled-calendars, bookmarks, join-next-shortcut) are wired manually.
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// join-mode enum: nick <-> combo index. Order matters and must match the model.
const JOIN_MODES = [
    { nick: 'auto-open', label: 'Open Chrome automatically' },
    { nick: 'notify', label: 'Show a notification with a Join button' },
];

export default class GmeetminderPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Track resources that must be torn down when the window closes.
        this._calendarSource = null;

        const page = new Adw.PreferencesPage({
            title: 'gmeetminder',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        this._buildJoiningGroup(page, settings);
        this._buildChromeGroup(page, settings);
        this._buildFiltersGroup(page, settings);
        this._buildCalendarsGroup(page, settings);
        this._buildBookmarksGroup(page, settings);
        this._buildShortcutGroup(page, settings);

        // Defensive teardown of any live resources (e.g. CalendarSource/EDS).
        window.connect('close-request', () => {
            try {
                if (this._calendarSource &&
                    typeof this._calendarSource.destroy === 'function')
                    this._calendarSource.destroy();
            } catch (e) {
                console.log('[gmeetminder] prefs: error destroying CalendarSource:', e);
            }
            this._calendarSource = null;
            return false; // allow the close to proceed
        });
    }

    // ---------------------------------------------------------------- Joining
    _buildJoiningGroup(page, settings) {
        const group = new Adw.PreferencesGroup({ title: 'Joining' });
        page.add(group);

        // join-mode enum <-> ComboRow (manual: map nick <-> index).
        const model = new Gtk.StringList();
        for (const m of JOIN_MODES)
            model.append(m.label);

        const combo = new Adw.ComboRow({
            title: 'When a meeting is about to start',
            subtitle: 'Choose what gmeetminder does automatically',
            model,
        });

        const current = settings.get_string('join-mode');
        const idx = JOIN_MODES.findIndex(m => m.nick === current);
        combo.selected = idx >= 0 ? idx : 0;

        let syncing = false;
        combo.connect('notify::selected', () => {
            if (syncing)
                return;
            const sel = combo.selected;
            const nick = JOIN_MODES[sel]?.nick ?? JOIN_MODES[0].nick;
            if (settings.get_string('join-mode') !== nick)
                settings.set_string('join-mode', nick);
        });
        // Reflect external changes back into the combo.
        settings.connect('changed::join-mode', () => {
            const nick = settings.get_string('join-mode');
            const i = JOIN_MODES.findIndex(m => m.nick === nick);
            if (i >= 0 && i !== combo.selected) {
                syncing = true;
                combo.selected = i;
                syncing = false;
            }
        });
        group.add(combo);

        // lead-time-seconds int -> SpinRow (auto bind via Adjustment).
        const leadAdjustment = new Gtk.Adjustment({
            lower: 0,
            upper: 3600,
            step_increment: 5,
            page_increment: 30,
            value: settings.get_int('lead-time-seconds'),
        });
        const leadRow = new Adw.SpinRow({
            title: 'Lead time (seconds)',
            subtitle: 'How long before the start to open or notify',
            adjustment: leadAdjustment,
        });
        settings.bind('lead-time-seconds', leadRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(leadRow);
    }

    // ----------------------------------------------------------------- Chrome
    _buildChromeGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Chrome',
            description: 'How meetings are opened in Google Chrome',
        });
        page.add(group);

        // chrome-command string -> EntryRow (auto bind).
        const cmdRow = new Adw.EntryRow({ title: 'Command' });
        settings.bind('chrome-command', cmdRow, 'text',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(cmdRow);

        // chrome-profile: ComboRow of profiles; stored value = profile dir.
        // Populated defensively (import failures must not break prefs). Manual.
        this._loadChromeProfiles(group, settings);
    }

    async _loadChromeProfiles(group, settings) {
        let profiles = [{ dir: 'Default', name: 'Default' }];
        try {
            const launcher = await import('./lib/launcher.js');
            if (typeof launcher.listChromeProfiles === 'function') {
                const found = launcher.listChromeProfiles();
                if (Array.isArray(found) && found.length)
                    profiles = found;
            }
        } catch (e) {
            console.log('[gmeetminder] prefs: launcher import failed:', e);
        }

        const stored = settings.get_string('chrome-profile');
        // If the stored profile isn't in the discovered list, keep it as an
        // extra option so the user's choice is never silently lost.
        if (stored && !profiles.some(p => p.dir === stored))
            profiles = [...profiles, { dir: stored, name: stored }];

        const model = new Gtk.StringList();
        for (const p of profiles)
            model.append(`${p.name} (${p.dir})`);

        const combo = new Adw.ComboRow({
            title: 'Profile',
            subtitle: 'Chrome profile used to open meetings',
            model,
        });

        const idx = profiles.findIndex(p => p.dir === stored);
        combo.selected = idx >= 0 ? idx : 0;

        let syncing = false;
        combo.connect('notify::selected', () => {
            if (syncing)
                return;
            const p = profiles[combo.selected];
            if (p && settings.get_string('chrome-profile') !== p.dir)
                settings.set_string('chrome-profile', p.dir);
        });
        settings.connect('changed::chrome-profile', () => {
            const val = settings.get_string('chrome-profile');
            const i = profiles.findIndex(p => p.dir === val);
            if (i >= 0 && i !== combo.selected) {
                syncing = true;
                combo.selected = i;
                syncing = false;
            }
        });

        group.add(combo);
    }

    // ---------------------------------------------------------------- Filters
    _buildFiltersGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Which meetings auto-open',
            description: 'Filters applied before a meeting is opened automatically',
        });
        page.add(group);

        const bools = [
            ['filter-require-meet-link', 'Require a video link', null],
            ['filter-skip-declined', 'Skip meetings I’ve declined', null],
            ['filter-skip-all-day', 'Skip all-day events', null],
            ['filter-require-accepted', 'Only meetings I’ve accepted', null],
            ['detect-services', 'Detect Zoom/Teams links too', null],
        ];
        for (const [key, title, subtitle] of bools) {
            const row = new Adw.SwitchRow({ title });
            if (subtitle)
                row.subtitle = subtitle;
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        }
    }

    // -------------------------------------------------------------- Calendars
    _buildCalendarsGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Calendars',
            description: 'Calendars whose events can trigger auto-open',
        });
        page.add(group);

        // Explanatory note. empty enabled-calendars == all calendars enabled.
        const note = new Adw.ActionRow({
            title: 'All calendars are included by default.',
            subtitle: 'Turn individual calendars off to exclude them.',
        });
        note.add_css_class('dim-label');
        group.add(note);

        this._loadCalendars(group, settings);
    }

    async _loadCalendars(group, settings) {
        // enabled-calendars semantics: EMPTY array means "all enabled".
        // On the first explicit toggle we materialize the full set of
        // currently-enabled UIDs, then apply the change — converting the
        // implicit "empty means all" into an explicit list.
        let calendars = [];
        try {
            const mod = await import('./lib/calendarSource.js');
            const CalendarSource = mod.CalendarSource ?? mod.default;
            if (!CalendarSource)
                throw new Error('CalendarSource export not found');
            const source = new CalendarSource();
            this._calendarSource = source;
            if (typeof source.init === 'function')
                await source.init();
            if (typeof source.listCalendars === 'function') {
                const list = source.listCalendars();
                calendars = Array.isArray(list) ? list : (await list) ?? [];
            }
        } catch (e) {
            console.log('[gmeetminder] prefs: CalendarSource unavailable:', e);
            calendars = [];
        }

        if (!calendars || calendars.length === 0) {
            const empty = new Adw.ActionRow({
                title: 'No Google account found',
                subtitle: 'Add one in Settings → Online Accounts.',
            });
            empty.sensitive = false;
            empty.add_css_class('dim-label');
            group.add(empty);
            return;
        }

        const isEnabled = (uid) => {
            const enabled = settings.get_strv('enabled-calendars');
            return enabled.length === 0 || enabled.includes(uid);
        };

        // Materialize the currently-enabled set as explicit UIDs (used the
        // first time the array is still empty, i.e. "all").
        const materialize = () => {
            const current = settings.get_strv('enabled-calendars');
            if (current.length > 0)
                return current.slice();
            return calendars
                .map(c => c.uid)
                .filter(uid => typeof uid === 'string' && uid.length);
        };

        for (const cal of calendars) {
            const uid = cal.uid;
            const row = new Adw.SwitchRow({
                title: cal.displayName ?? uid ?? 'Calendar',
                subtitle: cal.backendName ?? '',
                active: isEnabled(uid),
            });
            row.connect('notify::active', () => {
                let list = materialize();
                if (row.active) {
                    if (!list.includes(uid))
                        list.push(uid);
                } else {
                    list = list.filter(u => u !== uid);
                }
                settings.set_strv('enabled-calendars', list);
            });
            group.add(row);
        }
    }

    // -------------------------------------------------------------- Bookmarks
    _buildBookmarksGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Bookmarks',
            description: 'Saved meeting links',
        });
        page.add(group);

        // Container we can refresh: we keep created rows so we can remove them.
        this._bookmarkRows = [];

        const readBookmarks = () => {
            return settings.get_strv('bookmarks').map(s => {
                try {
                    const o = JSON.parse(s);
                    if (o && typeof o.url === 'string')
                        return { name: o.name ?? '', url: o.url };
                } catch (_e) { /* skip malformed */ }
                return null;
            }).filter(b => b);
        };

        const writeBookmarks = (list) => {
            settings.set_strv('bookmarks',
                list.map(b => JSON.stringify({ name: b.name ?? '', url: b.url })));
        };

        const refresh = () => {
            for (const row of this._bookmarkRows)
                group.remove(row);
            this._bookmarkRows = [];

            const list = readBookmarks();
            for (let i = 0; i < list.length; i++) {
                const b = list[i];
                const row = new Adw.ActionRow({
                    title: b.name || b.url,
                    subtitle: b.url,
                });
                const removeBtn = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Remove',
                });
                removeBtn.add_css_class('flat');
                const removeIndex = i;
                removeBtn.connect('clicked', () => {
                    const cur = readBookmarks();
                    cur.splice(removeIndex, 1);
                    writeBookmarks(cur);
                    refresh();
                });
                row.add_suffix(removeBtn);
                // Insert the bookmark rows before the "add" expander.
                group.add(row);
                this._bookmarkRows.push(row);
            }
        };

        // Add-bookmark expander with Name + URL entries and an Add button.
        const expander = new Adw.ExpanderRow({
            title: 'Add bookmark',
            subtitle: 'A name and an https:// link',
        });

        const nameEntry = new Adw.EntryRow({ title: 'Name' });
        const urlEntry = new Adw.EntryRow({ title: 'URL (https://…)' });

        const addRow = new Adw.ActionRow();
        const addBtn = new Gtk.Button({
            label: 'Add',
            valign: Gtk.Align.CENTER,
        });
        addBtn.add_css_class('suggested-action');
        const doAdd = () => {
            const name = (nameEntry.text ?? '').trim();
            const url = (urlEntry.text ?? '').trim();
            if (!url || !url.startsWith('http'))
                return; // ignore empty / non-http
            const cur = readBookmarks();
            cur.push({ name, url });
            writeBookmarks(cur);
            nameEntry.text = '';
            urlEntry.text = '';
            refresh();
        };
        addBtn.connect('clicked', doAdd);
        urlEntry.connect('entry-activated', doAdd);
        addRow.add_suffix(addBtn);

        expander.add_row(nameEntry);
        expander.add_row(urlEntry);
        expander.add_row(addRow);
        group.add(expander);

        // Keep the add-expander last; refresh appends bookmark rows after the
        // header/description but they visually stack — acceptable for prefs.
        refresh();
    }

    // --------------------------------------------------------------- Shortcut
    _buildShortcutGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Shortcut',
            description: 'Global keyboard shortcut to join the next meeting',
        });
        page.add(group);

        const readAccel = () => {
            const arr = settings.get_strv('join-next-shortcut');
            return arr.length ? arr[0] : '';
        };

        const currentRow = new Adw.ActionRow({
            title: 'Join next meeting',
        });
        const updateSubtitle = () => {
            const accel = readAccel();
            let label = 'Not set';
            if (accel) {
                try {
                    const [ok, key, mods] = Gtk.accelerator_parse(accel);
                    if (ok && key !== 0)
                        label = Gtk.accelerator_get_label(key, mods);
                    else
                        label = accel;
                } catch (_e) {
                    label = accel;
                }
            }
            currentRow.subtitle = `Current: ${label}`;
        };
        updateSubtitle();
        group.add(currentRow);

        // Editable accelerator entry, validated with Gtk.accelerator_parse.
        const entry = new Adw.EntryRow({
            title: 'Accelerator',
            text: readAccel(),
        });
        entry.set_show_apply_button(true);

        const apply = () => {
            const text = (entry.text ?? '').trim();
            if (!text) {
                settings.set_strv('join-next-shortcut', []);
                updateSubtitle();
                entry.remove_css_class('error');
                return;
            }
            let ok = false;
            let key = 0;
            let mods = 0;
            try {
                [ok, key, mods] = Gtk.accelerator_parse(text);
            } catch (_e) {
                ok = false;
            }
            if (ok && key !== 0 && Gtk.accelerator_valid(key, mods)) {
                settings.set_strv('join-next-shortcut', [text]);
                entry.remove_css_class('error');
                updateSubtitle();
            } else {
                // Signal invalid input and restore last good value.
                entry.add_css_class('error');
                entry.text = readAccel();
            }
        };
        entry.connect('apply', apply);
        // Help text describing the expected format.
        const help = new Adw.ActionRow({
            title: 'Format example: <Super><Shift>j',
            subtitle: 'Use <Ctrl>, <Alt>, <Shift>, <Super> modifiers, then a key.',
        });
        help.add_css_class('dim-label');
        help.sensitive = false;

        group.add(entry);
        group.add(help);

        settings.connect('changed::join-next-shortcut', () => {
            const val = readAccel();
            if ((entry.text ?? '') !== val)
                entry.text = val;
            updateSubtitle();
        });
    }
}
