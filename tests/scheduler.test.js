/**
 * Unit tests for lib/scheduler.js.
 *
 * The scheduler is PURE: it takes an injected clock + timer primitives. Here we
 * supply a manual fake scheduler — an array of {fireAt, cb} we advance by hand —
 * so timing is fully deterministic and no real time (or gi://) is involved.
 */

import { describe, it, expect } from './harness.js';
import { Scheduler } from '../gmeetminder@dfreiber.local/lib/scheduler.js';
import { makeEvent } from '../gmeetminder@dfreiber.local/lib/types.js';

/**
 * Manual fake clock + timers. `advance(ms)` moves `now` forward, firing any
 * one-shot and repeating timers whose fireAt is reached, in chronological order.
 */
function makeFakeClock(startMs = 1_000_000) {
    let now = startMs;
    let seq = 1;
    const timers = new Map(); // id -> { fireAt, cb, period|null }

    const deps = {
        now: () => now,
        setTimer: (delayMs, cb) => {
            const id = seq++;
            timers.set(id, { fireAt: now + delayMs, cb, period: null });
            return id;
        },
        clearTimer: (id) => { timers.delete(id); },
        setInterval: (periodMs, cb) => {
            const id = seq++;
            timers.set(id, { fireAt: now + periodMs, cb, period: periodMs });
            return id;
        },
        clearInterval: (id) => { timers.delete(id); },
    };

    function advance(ms) {
        const target = now + ms;
        for (;;) {
            let dueId = null;
            let dueAt = Infinity;
            for (const [id, t] of timers) {
                if (t.fireAt <= target && t.fireAt < dueAt) {
                    dueAt = t.fireAt;
                    dueId = id;
                }
            }
            if (dueId === null)
                break;
            const t = timers.get(dueId);
            now = t.fireAt;
            if (t.period !== null)
                t.fireAt = now + t.period;
            else
                timers.delete(dueId);
            t.cb();
        }
        now = target;
    }

    return { deps, advance, timerCount: () => timers.size };
}

const ALL_OFF = { requireMeetLink: false, skipDeclined: false, skipAllDay: false, requireAccepted: false };

/** Build a scheduler wired to a fresh fake clock, capturing triggers + ticks. */
function harness(startMs = 1_000_000) {
    const clock = makeFakeClock(startMs);
    const sched = new Scheduler(clock.deps);
    const triggers = [];
    const ticks = [];
    sched.onTrigger = (event, reason) => triggers.push({ id: event.id, reason });
    sched.onTick = (info) => ticks.push(info);
    return { clock, sched, triggers, ticks };
}

function settings(leadTimeSeconds, filters = {}) {
    return { leadTimeSeconds, filters: { ...ALL_OFF, ...filters } };
}

describe('formatCountdown', () => {
    const s = new Scheduler(makeFakeClock().deps);

    it('null -> empty string', () => { expect(s.formatCountdown(null)).toBe(''); });
    it('zero -> now', () => { expect(s.formatCountdown(0)).toBe('now'); });
    it('negative -> now', () => { expect(s.formatCountdown(-5)).toBe('now'); });
    it('45s -> in 45s', () => { expect(s.formatCountdown(45)).toBe('in 45s'); });
    it('59s -> in 59s', () => { expect(s.formatCountdown(59)).toBe('in 59s'); });
    it('60s -> in 1m', () => { expect(s.formatCountdown(60)).toBe('in 1m'); });
    it('11m (660s) -> in 11m', () => { expect(s.formatCountdown(660)).toBe('in 11m'); });
    it('65m (3900s) -> in 1h 5m', () => { expect(s.formatCountdown(3900)).toBe('in 1h 5m'); });
    it('exactly 1h (3600s) -> in 1h 0m', () => { expect(s.formatCountdown(3600)).toBe('in 1h 0m'); });
});

describe('lead trigger timing + de-dupe', () => {
    it('fires lead exactly at start-lead, once, and never again', () => {
        const { clock, sched, triggers } = harness(100_000);
        const ev = makeEvent({ id: 'e1', start: 400_000, end: 700_000 });
        sched.update([ev], settings(60)); // trigger at 400000 - 60000 = 340000

        clock.advance(239_999); // now = 339999, just before
        expect(triggers.length).toBe(0);

        clock.advance(1); // now = 340000, fire
        expect(triggers.length).toBe(1);
        expect(triggers[0].id).toBe('e1');
        expect(triggers[0].reason).toBe('lead');

        clock.advance(1_000_000); // well past; no re-fire
        expect(triggers.length).toBe(1);
    });

    it('does not re-schedule/re-fire the same id across update() calls', () => {
        const { clock, sched, triggers } = harness(100_000);
        const ev = makeEvent({ id: 'e1', start: 400_000, end: 700_000 });
        sched.update([ev], settings(60));
        clock.advance(240_000); // fire at 340000
        expect(triggers.length).toBe(1);

        sched.update([ev], settings(60)); // same event reloaded
        clock.advance(1_000_000);
        expect(triggers.length).toBe(1); // still once
    });
});

describe('eligibility filters gate triggers', () => {
    const base = { start: 400_000, end: 700_000 };

    it('skipDeclined: declined event does not trigger', () => {
        const { clock, sched, triggers } = harness(100_000);
        const ev = makeEvent({ id: 'd', rsvp: 'declined', ...base });
        sched.update([ev], settings(60, { skipDeclined: true }));
        clock.advance(1_000_000);
        expect(triggers.length).toBe(0);
    });

    it('skipAllDay: all-day event does not trigger', () => {
        const { clock, sched, triggers } = harness(100_000);
        const ev = makeEvent({ id: 'a', allDay: true, ...base });
        sched.update([ev], settings(60, { skipAllDay: true }));
        clock.advance(1_000_000);
        expect(triggers.length).toBe(0);
    });

    it('requireMeetLink: null joinUrl excluded, real joinUrl included', () => {
        const noLink = harness(100_000);
        noLink.sched.update(
            [makeEvent({ id: 'nolink', joinUrl: null, ...base })],
            settings(60, { requireMeetLink: true }));
        noLink.clock.advance(1_000_000);
        expect(noLink.triggers.length).toBe(0);

        const withLink = harness(100_000);
        withLink.sched.update(
            [makeEvent({ id: 'link', joinUrl: 'https://meet.google.com/abc', ...base })],
            settings(60, { requireMeetLink: true }));
        withLink.clock.advance(1_000_000);
        expect(withLink.triggers.length).toBe(1);
        expect(withLink.triggers[0].id).toBe('link');
    });

    it('requireAccepted: only accepted triggers', () => {
        const needsAction = harness(100_000);
        needsAction.sched.update(
            [makeEvent({ id: 'na', rsvp: 'needs-action', ...base })],
            settings(60, { requireAccepted: true }));
        needsAction.clock.advance(1_000_000);
        expect(needsAction.triggers.length).toBe(0);

        const accepted = harness(100_000);
        accepted.sched.update(
            [makeEvent({ id: 'ok', rsvp: 'accepted', ...base })],
            settings(60, { requireAccepted: true }));
        accepted.clock.advance(1_000_000);
        expect(accepted.triggers.length).toBe(1);
        expect(accepted.triggers[0].reason).toBe('lead');
    });
});

describe('in-progress handling', () => {
    it('fires in-progress once immediately on update', () => {
        const { sched, triggers } = harness(500_000);
        const ev = makeEvent({ id: 'run', start: 400_000, end: 700_000 }); // now in [start,end)
        sched.update([ev], settings(60));
        expect(triggers.length).toBe(1);
        expect(triggers[0].reason).toBe('in-progress');

        sched.update([ev], settings(60)); // reload -> no re-fire
        expect(triggers.length).toBe(1);
    });

    it('an in-progress event does not also schedule a lead trigger', () => {
        const { clock, sched, triggers } = harness(500_000);
        const ev = makeEvent({ id: 'run', start: 400_000, end: 700_000 });
        sched.update([ev], settings(60));
        clock.advance(1_000_000);
        expect(triggers.length).toBe(1); // only the in-progress one
    });
});

describe('removing an event cancels its pending trigger', () => {
    it('cancels a scheduled lead trigger when the event is removed', () => {
        const { clock, sched, triggers } = harness(100_000);
        const ev = makeEvent({ id: 'e1', start: 400_000, end: 700_000 });
        sched.update([ev], settings(60));   // schedules trigger at 340000
        sched.update([], settings(60));     // remove before it fires
        clock.advance(1_000_000);
        expect(triggers.length).toBe(0);
    });
});

describe('nextEvent display rules', () => {
    it('picks soonest non-ended displayable event', () => {
        const { sched } = harness(100_000);
        const soon = makeEvent({ id: 'soon', start: 200_000, end: 300_000 });
        const later = makeEvent({ id: 'later', start: 500_000, end: 600_000 });
        const ended = makeEvent({ id: 'ended', start: 10_000, end: 50_000 });
        sched.update([later, ended, soon], settings(60));
        expect(sched.nextEvent().id).toBe('soon');
    });

    it('prefers an in-progress meeting over a not-yet-started one', () => {
        const { sched } = harness(250_000);
        const running = makeEvent({ id: 'running', start: 200_000, end: 400_000 }); // in progress
        const upcoming = makeEvent({ id: 'upcoming', start: 300_000, end: 500_000 });
        sched.update([upcoming, running], settings(60));
        expect(sched.nextEvent().id).toBe('running');
    });

    it('ignores declined and all-day per display rules', () => {
        const { sched } = harness(100_000);
        const declined = makeEvent({ id: 'declined', rsvp: 'declined', start: 150_000, end: 200_000 });
        const allDay = makeEvent({ id: 'allday', allDay: true, start: 160_000, end: 900_000 });
        const real = makeEvent({ id: 'real', start: 300_000, end: 400_000 });
        sched.update([declined, allDay, real], settings(60, { skipDeclined: true, skipAllDay: true }));
        expect(sched.nextEvent().id).toBe('real');
    });

    it('display ignores requireMeetLink/requireAccepted (shows link-less, un-RSVPd)', () => {
        const { sched } = harness(100_000);
        const noLink = makeEvent({ id: 'nolink', joinUrl: null, rsvp: 'needs-action', start: 200_000, end: 300_000 });
        sched.update([noLink], settings(60, { requireMeetLink: true, requireAccepted: true }));
        // Not eligible to trigger, but still displayed.
        expect(sched.nextEvent().id).toBe('nolink');
    });

    it('returns null when there are no displayable, non-ended events', () => {
        const { sched } = harness(100_000);
        const ended = makeEvent({ id: 'ended', start: 10_000, end: 50_000 });
        sched.update([ended], settings(60));
        expect(sched.nextEvent()).toBeNull();
    });
});

describe('tick loop', () => {
    it('emits an immediate tick on start with the correct countdown label', () => {
        const { sched, ticks } = harness(100_000);
        const ev = makeEvent({ id: 'e1', start: 100_000 + 660_000, end: 900_000 }); // 11m out
        sched.update([ev], settings(60));
        sched.start();
        expect(ticks.length).toBe(1);
        expect(ticks[0].event.id).toBe('e1');
        expect(ticks[0].secondsUntilStart).toBe(660);
        expect(ticks[0].label).toBe('in 11m');
    });

    it('ticks once per second and reports null when no event', () => {
        const { clock, sched, ticks } = harness(100_000);
        sched.update([], settings(60));
        sched.start(); // immediate tick #1
        clock.advance(3000); // three interval ticks
        expect(ticks.length).toBe(4);
        expect(ticks[3].event).toBeNull();
        expect(ticks[3].label).toBe('');
    });

    it('start() is idempotent', () => {
        const { clock, sched, ticks } = harness(100_000);
        sched.update([], settings(60));
        sched.start();
        sched.start(); // no second interval
        clock.advance(1000);
        // 1 immediate tick + 1 interval tick = 2 (not 3)
        expect(ticks.length).toBe(2);
    });

    it('destroy() stops the tick loop and cancels pending timers', () => {
        const { clock, sched, ticks, triggers } = harness(100_000);
        const ev = makeEvent({ id: 'e1', start: 400_000, end: 700_000 });
        sched.update([ev], settings(60));
        sched.start();
        sched.destroy();
        expect(clock.timerCount()).toBe(0);
        const ticksAfter = ticks.length;
        clock.advance(1_000_000);
        expect(ticks.length).toBe(ticksAfter); // no more ticks
        expect(triggers.length).toBe(0);       // pending lead cancelled
    });
});
