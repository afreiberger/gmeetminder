/**
 * Unit tests for lib/launcher.js — PURE functions only (buildArgv, parseProfiles).
 * open/listChromeProfiles/createInstantMeeting touch gio/disk and are not tested here.
 */

import { describe, it, expect } from './harness.js';
import { buildArgv, parseProfiles } from '../gmeetminder@dfreiber.local/lib/launcher.js';

describe('buildArgv', () => {
    it('builds argv with a normal profile', () => {
        const argv = buildArgv({
            chromeCommand: 'google-chrome',
            chromeProfile: 'Default',
            url: 'https://meet.google.com/abc',
        });
        expect(argv).toEqual([
            'google-chrome',
            '--profile-directory=Default',
            '--new-window',
            'https://meet.google.com/abc',
        ]);
    });

    it('handles a "Profile 1" directory without shell-quoting', () => {
        const argv = buildArgv({
            chromeCommand: 'google-chrome',
            chromeProfile: 'Profile 1',
            url: 'https://meet.new',
        });
        expect(argv).toEqual([
            'google-chrome',
            '--profile-directory=Profile 1',
            '--new-window',
            'https://meet.new',
        ]);
    });

    it('omits --profile-directory when profile is empty', () => {
        const argv = buildArgv({
            chromeCommand: 'google-chrome',
            chromeProfile: '',
            url: 'https://meet.google.com/xyz',
        });
        expect(argv).toEqual([
            'google-chrome',
            '--new-window',
            'https://meet.google.com/xyz',
        ]);
    });

    it('omits --profile-directory when profile is undefined', () => {
        const argv = buildArgv({
            chromeCommand: 'google-chrome',
            chromeProfile: undefined,
            url: 'https://meet.google.com/xyz',
        });
        expect(argv.some(a => a.startsWith('--profile-directory'))).toBe(false);
    });

    it('always includes --new-window and puts url last', () => {
        const argv = buildArgv({
            chromeCommand: 'google-chrome',
            chromeProfile: 'Default',
            url: 'https://meet.google.com/last',
        });
        expect(argv).toContain('--new-window');
        expect(argv[argv.length - 1]).toBe('https://meet.google.com/last');
    });

    it('respects a custom chrome command', () => {
        const argv = buildArgv({
            chromeCommand: '/opt/chrome/chrome',
            chromeProfile: '',
            url: 'https://example.com',
        });
        expect(argv[0]).toBe('/opt/chrome/chrome');
    });
});

describe('parseProfiles', () => {
    const localState = JSON.stringify({
        profile: {
            info_cache: {
                'Profile 1': { name: 'Work' },
                'Default': { name: 'Person 1' },
            },
        },
    });

    it('lists two profiles with Default first', () => {
        const profiles = parseProfiles(localState);
        expect(profiles).toEqual([
            { dir: 'Default', name: 'Person 1' },
            { dir: 'Profile 1', name: 'Work' },
        ]);
    });

    it('sorts non-Default profiles alphabetically by name', () => {
        const json = JSON.stringify({
            profile: {
                info_cache: {
                    'Profile 2': { name: 'Zeta' },
                    'Profile 1': { name: 'Alpha' },
                    'Default': { name: 'Middle' },
                },
            },
        });
        const profiles = parseProfiles(json);
        expect(profiles).toEqual([
            { dir: 'Default', name: 'Middle' },
            { dir: 'Profile 1', name: 'Alpha' },
            { dir: 'Profile 2', name: 'Zeta' },
        ]);
    });

    it('falls back name to dir when name missing', () => {
        const json = JSON.stringify({
            profile: { info_cache: { 'Profile 3': {} } },
        });
        const profiles = parseProfiles(json);
        expect(profiles).toEqual([{ dir: 'Profile 3', name: 'Profile 3' }]);
    });

    it('returns [] for empty string', () => {
        expect(parseProfiles('')).toEqual([]);
    });

    it('returns [] for malformed JSON', () => {
        expect(parseProfiles('{not valid json')).toEqual([]);
    });

    it('returns [] when info_cache is missing', () => {
        expect(parseProfiles(JSON.stringify({ profile: {} }))).toEqual([]);
    });
});
