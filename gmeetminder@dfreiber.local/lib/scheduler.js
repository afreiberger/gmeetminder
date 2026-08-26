/**
 * Scheduler: drives the panel countdown tick and fires one-shot "trigger" events
 * for upcoming (and already-in-progress) meetings.
 *
 * PURE + testable: the clock and timer primitives are INJECTED via the constructor,
 * so unit tests run with a fake clock and need no real time and no `gi://` imports.
 * At runtime the extension injects GLib-based timers.
 *
 * Two responsibilities:
 *   1. A once-per-second "tick" that reports a live countdown to the next event.
 *   2. A one-shot "trigger" per ELIGIBLE meeting at `start - leadTime`, exactly once
 *      per event id, plus an "in-progress" trigger for meetings already running when
 *      events are (re)loaded.
 */

/** Filters default to "off"; an absent filter means its check is skipped. */
const DEFAULT_FILTERS = Object.freeze({
    requireMeetLink: false,
    skipDeclined: false,
    skipAllDay: false,
    requireAccepted: false,
});

const DEFAULT_LEAD_SECONDS = 60;
const TICK_PERIOD_MS = 1000;

export class Scheduler {
    /**
     * @param {{
     *   now: () => number,                                   // current unix ms
     *   setTimer: (delayMs:number, cb:()=>void) => any,      // one-shot timer, returns id
     *   clearTimer: (id:any) => void,
     *   setInterval: (periodMs:number, cb:()=>void) => any,  // repeating, returns id
     *   clearInterval: (id:any) => void
     * }} deps
     */
    constructor(deps) {
        this._deps = deps;

        /** @type {import('./types.js').MeetingEvent[]} */
        this._events = [];
        this._filters = { ...DEFAULT_FILTERS };
        this._leadMs = DEFAULT_LEAD_SECONDS * 1000;

        /** ids that have ALREADY fired (lead or in-progress); never re-scheduled. @type {Set<string>} */
        this._firedIds = new Set();
        /** id -> one-shot timer id for scheduled-but-not-yet-fired lead triggers. @type {Map<string, any>} */
        this._pendingTimers = new Map();

        this._intervalId = null;
    }

    /** Panel tick callback. info: {event: MeetingEvent|null, secondsUntilStart: number|null, label: string} */
    onTick = (_info) => {};

    /** Trigger callback. reason: 'lead' | 'in-progress' */
    onTrigger = (_event, _reason) => {};

    /**
     * Replace the event set and settings, recompute timers and next event.
     * Safe to call repeatedly (on calendar refresh / settings change).
     *
     * Strategy: cancel and rebuild all pending lead timers from scratch each call,
     * while preserving `_firedIds`. This cleanly handles removed events, retimed
     * events, and eligibility changes; `_firedIds` guarantees nothing fires twice.
     *
     * @param {import('./types.js').MeetingEvent[]} events
     * @param {{leadTimeSeconds:number, filters:{requireMeetLink:boolean,skipDeclined:boolean,skipAllDay:boolean,requireAccepted:boolean}}} settings
     */
    update(events, settings) {
        this._events = Array.isArray(events) ? events.slice() : [];
        settings = settings || {};
        const leadSeconds = Number.isFinite(settings.leadTimeSeconds)
            ? settings.leadTimeSeconds
            : DEFAULT_LEAD_SECONDS;
        this._leadMs = leadSeconds * 1000;
        this._filters = { ...DEFAULT_FILTERS, ...(settings.filters || {}) };

        // Cancel every pending (not-yet-fired) lead timer; we reschedule below.
        // A removed event simply won't be rescheduled -> its trigger is cancelled.
        for (const id of this._pendingTimers.values())
            this._deps.clearTimer(id);
        this._pendingTimers.clear();

        const now = this._deps.now();

        for (const ev of this._events) {
            if (!this._isEligible(ev))
                continue;

            // Already running when (re)loaded: notify once, never schedule a lead trigger.
            if (now >= ev.start && now < ev.end) {
                if (!this._firedIds.has(ev.id)) {
                    this._firedIds.add(ev.id);
                    this.onTrigger(ev, 'in-progress');
                }
                continue;
            }

            // Upcoming: schedule a one-shot lead trigger only if start-lead is in the future.
            const triggerAt = ev.start - this._leadMs;
            if (triggerAt > now && !this._firedIds.has(ev.id)) {
                const id = ev.id;
                const timerId = this._deps.setTimer(triggerAt - now, () => {
                    this._pendingTimers.delete(id);
                    if (this._firedIds.has(id))
                        return; // defensive: never fire an id twice
                    this._firedIds.add(id);
                    this.onTrigger(ev, 'lead');
                });
                this._pendingTimers.set(id, timerId);
            }
        }

        // Refresh the panel label immediately if the tick loop is running.
        if (this._intervalId !== null)
            this._tick();
    }

    /** Start the 1s tick loop. Idempotent. Emits an immediate tick so the label populates at once. */
    start() {
        if (this._intervalId !== null)
            return;
        this._intervalId = this._deps.setInterval(TICK_PERIOD_MS, () => this._tick());
        this._tick();
    }

    /**
     * The soonest event still relevant for the panel label.
     *
     * DISPLAY vs ELIGIBILITY: for the panel we use the same filter set as trigger
     * eligibility EXCEPT we do NOT apply requireMeetLink or requireAccepted — we still
     * want to count down to your next real meeting even if it has no Meet link or you
     * have not RSVP'd. So display only honours skipDeclined and skipAllDay.
     *
     * Among non-ended (end > now) displayable events we pick the smallest start; an
     * in-progress meeting (start <= now < end) is preferred (and naturally sorts first
     * since it has the earliest start).
     *
     * @returns {import('./types.js').MeetingEvent|null}
     */
    nextEvent() {
        const now = this._deps.now();
        const candidates = this._events.filter(
            (ev) => this._isDisplayable(ev) && ev.end > now);
        if (candidates.length === 0)
            return null;

        candidates.sort((a, b) => {
            const aInProgress = a.start <= now && now < a.end ? 0 : 1;
            const bInProgress = b.start <= now && now < b.end ? 0 : 1;
            if (aInProgress !== bInProgress)
                return aInProgress - bInProgress; // prefer in-progress
            if (a.start !== b.start)
                return a.start - b.start;          // then soonest start
            return a.end - b.end;                  // stable-ish tiebreak
        });
        return candidates[0];
    }

    /**
     * Format a countdown string.
     *   null -> '' ; <=0 -> 'now' ; <60s -> 'in Ns' ; <60min -> 'in Nm' ; else -> 'in Hh Mm'.
     * @param {number|null} secondsUntilStart
     * @returns {string}
     */
    formatCountdown(secondsUntilStart) {
        if (secondsUntilStart === null || secondsUntilStart === undefined)
            return '';
        const s = secondsUntilStart;
        if (s <= 0)
            return 'now';
        if (s < 60)
            return `in ${s}s`;
        if (s < 3600)
            return `in ${Math.floor(s / 60)}m`;
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return `in ${h}h ${m}m`;
    }

    /** Tear down all timers/intervals and reset trigger state. */
    destroy() {
        if (this._intervalId !== null) {
            this._deps.clearInterval(this._intervalId);
            this._intervalId = null;
        }
        for (const id of this._pendingTimers.values())
            this._deps.clearTimer(id);
        this._pendingTimers.clear();
        this._firedIds.clear();
    }

    // --- internals ---------------------------------------------------------

    /** Compute and emit one panel tick from nextEvent(). */
    _tick() {
        const ev = this.nextEvent();
        if (!ev) {
            this.onTick({ event: null, secondsUntilStart: null, label: '' });
            return;
        }
        const secondsUntilStart = Math.ceil((ev.start - this._deps.now()) / 1000);
        this.onTick({
            event: ev,
            secondsUntilStart,
            label: this.formatCountdown(secondsUntilStart),
        });
    }

    /** True if the event may TRIGGER auto-open/notify under the current filters. */
    _isEligible(ev) {
        const f = this._filters;
        if (f.requireMeetLink && !(typeof ev.joinUrl === 'string' && ev.joinUrl.length > 0))
            return false;
        if (f.skipDeclined && ev.rsvp === 'declined')
            return false;
        if (f.skipAllDay && ev.allDay === true)
            return false;
        if (f.requireAccepted && ev.rsvp !== 'accepted')
            return false;
        return true;
    }

    /** True if the event should appear in the panel label (display rule). */
    _isDisplayable(ev) {
        const f = this._filters;
        if (f.skipDeclined && ev.rsvp === 'declined')
            return false;
        if (f.skipAllDay && ev.allDay === true)
            return false;
        return true;
    }
}
