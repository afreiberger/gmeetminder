// SPDX-FileCopyrightText: 2026 Drew Freiberger
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Chrome launcher: build/run the command line that opens a URL in a chosen
 * profile, open instant Google Meet rooms, and enumerate Chrome profiles.
 *
 * PURE logic (buildArgv, parseProfiles) is free of `gi://` imports so it can be
 * unit-tested with plain gjs. The gi-backed side (listChromeProfiles, open,
 * createInstantMeeting) is isolated below and not exercised by unit tests.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Build the Chrome argv for opening a URL in a specific profile in a new window.
 * PURE — no gi imports. Unit-tested.
 * @param {{chromeCommand:string, chromeProfile:string, url:string}} o
 * @returns {string[]}  e.g. ['google-chrome','--profile-directory=Default','--new-window','https://meet.google.com/abc']
 */
export function buildArgv(o) {
    const { chromeCommand, chromeProfile, url } = o;
    const argv = [chromeCommand];
    if (chromeProfile)
        argv.push(`--profile-directory=${chromeProfile}`);
    argv.push('--new-window');
    argv.push(url);
    return argv;
}

/**
 * Parse a Chrome "Local State" JSON string into a profile list.
 * PURE — no gi imports. Unit-tested.
 * @param {string} localStateJson  contents of ~/.config/google-chrome/Local State
 * @returns {Array<{dir:string, name:string}>}  dir is the profile directory ("Default","Profile 1"), name the display name.
 *   Sorted: "Default" first, then by name. Returns [] on parse error.
 */
export function parseProfiles(localStateJson) {
    let data;
    try {
        data = JSON.parse(localStateJson);
    } catch {
        return [];
    }
    const cache = data?.profile?.info_cache;
    if (!cache || typeof cache !== 'object')
        return [];

    const profiles = Object.keys(cache).map(dir => {
        const name = cache[dir] && typeof cache[dir].name === 'string' && cache[dir].name
            ? cache[dir].name
            : dir;
        return { dir, name };
    });

    profiles.sort((a, b) => {
        if (a.dir === 'Default') return b.dir === 'Default' ? 0 : -1;
        if (b.dir === 'Default') return 1;
        return a.name.localeCompare(b.name);
    });

    return profiles;
}

/**
 * Read Chrome profiles from disk (~/.config/google-chrome/Local State). Uses Gio.
 * @returns {Array<{dir:string,name:string}>}  falls back to [{dir:'Default',name:'Default'}] if unreadable.
 */
export function listChromeProfiles() {
    const fallback = [{ dir: 'Default', name: 'Default' }];
    try {
        const path = GLib.build_filenamev([
            GLib.get_home_dir(),
            '.config',
            'google-chrome',
            'Local State',
        ]);
        const file = Gio.File.new_for_path(path);
        const [ok, contents] = file.load_contents(null);
        if (!ok)
            return fallback;
        const decoder = new TextDecoder('utf-8');
        const json = decoder.decode(contents);
        const profiles = parseProfiles(json);
        return profiles.length ? profiles : fallback;
    } catch (e) {
        console.log('[gmeetminder] listChromeProfiles failed:', e);
        return fallback;
    }
}

/**
 * Launch Chrome to a URL. Async, non-blocking (Gio.Subprocess). Never throws; logs on failure.
 * @param {{chromeCommand:string, chromeProfile:string, url:string}} o
 * @returns {boolean} true if spawn was initiated.
 */
export function open(o) {
    const { url } = o;
    if (typeof url !== 'string' || !url.startsWith('http')) {
        console.log('[gmeetminder] refusing to open non-http url:', url);
        return false;
    }
    try {
        const argv = buildArgv(o);
        const proc = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
        );
        // Reap the child so it doesn't linger as a zombie; ignore result.
        proc.wait_async(null, (p, res) => {
            try {
                p.wait_finish(res);
            } catch (e) {
                console.log('[gmeetminder] chrome process wait failed:', e);
            }
        });
        return true;
    } catch (e) {
        console.log('[gmeetminder] failed to launch chrome:', e);
        return false;
    }
}

/**
 * Open a brand-new Google Meet room (https://meet.new) in the chosen profile.
 * @param {{chromeCommand:string, chromeProfile:string}} o
 * @returns {boolean}
 */
export function createInstantMeeting(o) {
    return open({
        chromeCommand: o.chromeCommand,
        chromeProfile: o.chromeProfile,
        url: 'https://meet.new',
    });
}
