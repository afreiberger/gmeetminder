// SPDX-FileCopyrightText: 2026 Drew Freiberger
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Tiny zero-dependency test harness for GJS (`gjs -m`).
 *
 * Usage in a *.test.js file:
 *   import { describe, it, expect } from './harness.js';
 *   describe('thing', () => { it('does x', () => { expect(1).toBe(1); }); });
 *
 * The runner imports test files, then calls run(). Keeps modules under test
 * pure so they need no GNOME Shell.
 */

const suites = [];
let current = null;

export function describe(name, fn) {
    current = { name, tests: [] };
    suites.push(current);
    fn();
    current = null;
}

export function it(name, fn) {
    if (!current) throw new Error('it() must be called inside describe()');
    current.tests.push({ name, fn });
}

export function expect(actual) {
    const fail = (msg) => { throw new Error(msg); };
    return {
        toBe(expected) {
            if (actual !== expected) fail(`expected ${fmt(actual)} to be ${fmt(expected)}`);
        },
        toEqual(expected) {
            if (JSON.stringify(actual) !== JSON.stringify(expected))
                fail(`expected ${fmt(actual)} to equal ${fmt(expected)}`);
        },
        toBeNull() { if (actual !== null) fail(`expected ${fmt(actual)} to be null`); },
        toBeTruthy() { if (!actual) fail(`expected ${fmt(actual)} to be truthy`); },
        toBeFalsy() { if (actual) fail(`expected ${fmt(actual)} to be falsy`); },
        toContain(sub) {
            if (!String(actual).includes(sub)) fail(`expected ${fmt(actual)} to contain ${fmt(sub)}`);
        },
    };
}

function fmt(v) {
    try { return typeof v === 'string' ? `"${v}"` : JSON.stringify(v); }
    catch { return String(v); }
}

/** Run all registered suites. Returns true if all passed. */
export function run() {
    let pass = 0, failCount = 0;
    for (const suite of suites) {
        print(`\n${suite.name}`);
        for (const t of suite.tests) {
            try {
                t.fn();
                print(`  ✓ ${t.name}`);
                pass++;
            } catch (e) {
                print(`  ✗ ${t.name}\n      ${e.message}`);
                failCount++;
            }
        }
    }
    print(`\n${pass} passed, ${failCount} failed`);
    return failCount === 0;
}
