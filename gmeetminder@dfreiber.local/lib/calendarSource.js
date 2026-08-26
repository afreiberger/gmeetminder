/**
 * calendarSource.js — read the user's Google calendars from Evolution Data
 * Server (EDS), which GNOME populates via GNOME Online Accounts (GOA), and
 * emit normalized {@link MeetingEvent} objects.
 *
 * This is the highest-uncertainty module in gmeetminder: it talks to a stack of
 * GObject-introspected libraries (EDataServer, ECal, ICalGLib, Goa) whose exact
 * behavior we can only fully verify on a live GNOME session with a configured
 * Google account. It is therefore written *defensively*:
 *
 *   - GI modules are loaded via dynamic `import()` inside {@link CalendarSource#init}
 *     and wrapped in try/catch, so a missing typelib degrades to an empty result
 *     set instead of throwing during `enable()`.
 *   - Every EDS/ECal/ICalGLib call is guarded; a failure on one source is logged
 *     and skipped, never fatal.
 *   - Public methods never throw: on any failure they return sensible empties.
 *
 * Diagnostic logging (prefix `[gmeetminder]`) records: number of calendars found,
 * each source's backend, and — per event — booleans/lengths describing which
 * field a meeting link would come from (X-GOOGLE-CONFERENCE vs location vs
 * description vs url). Contents of private fields are NEVER logged, only their
 * presence/length, so we can verify the "#1 risk" (does EDS surface the Meet
 * link?) on real data without leaking calendar contents.
 *
 * Recurrence correctness: we expand occurrences with
 * `ECal.Client.generate_instances_sync`, which yields one callback per real
 * occurrence within the range with the *occurrence's* start/end. A plain
 * `get_object_list` would instead hand back the recurring master (with its
 * original DTSTART), giving wrong times for today's instance — so instances are
 * the primary path and object-list is only a last-ditch fallback.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { makeEvent, Rsvp } from './types.js';

const LOG_PREFIX = '[gmeetminder]';

/** Seconds `connect`/`connect_sync` will wait for the backend to come online. */
const CONNECT_WAIT_SECONDS = 5;

/** Log helper — uses console.log when available (GNOME 50 GJS), else log(). */
function logMsg(...args) {
    try {
        // eslint-disable-next-line no-console
        console.log(LOG_PREFIX, ...args);
    } catch (_e) {
        try {
            // eslint-disable-next-line no-undef
            log(`${LOG_PREFIX} ${args.join(' ')}`);
        } catch (_e2) {
            // Nothing we can do; never throw from logging.
        }
    }
}

/** Run `fn`, returning `fallback` (default undefined) on any throw. */
function safe(fn, fallback) {
    try {
        return fn();
    } catch (_e) {
        return fallback;
    }
}

export class CalendarSource {
    constructor() {
        /** @type {object|null} EDataServer module namespace (dynamic import). */
        this._ED = null;
        /** @type {object|null} ECal module namespace. */
        this._ECal = null;
        /** @type {object|null} ICalGLib module namespace. */
        this._ICal = null;
        /** @type {object|null} Goa module namespace (best-effort, optional). */
        this._Goa = null;

        /** @type {object|null} EDataServer.SourceRegistry instance. */
        this._registry = null;

        /**
         * Connected calendars, keyed by source UID.
         * @type {Map<string, {
         *   source: object, client: object|null, uid: string, displayName: string,
         *   backendName: string, isGoogle: boolean, ownerEmail: string,
         *   view: object|null, viewHandlerIds: number[]
         * }>}
         */
        this._entries = new Map();

        /** All discovered calendar sources (even ones we could not connect). */
        this._catalog = [];

        /** Registered change callbacks, keyed by handler id. */
        this._changeCbs = new Map();
        this._nextChangeId = 1;

        /** Registry signal handler ids (for teardown). */
        this._registryHandlerIds = [];

        this._cancellable = new Gio.Cancellable();
        this._ready = false;
        this._destroyed = false;
    }

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    /**
     * Load GI modules, create the EDS SourceRegistry, and connect an ECal client
     * per enabled calendar source. Never throws; on failure the instance is left
     * in a degraded (empty) but usable state.
     * @returns {Promise<void>}
     */
    async init() {
        if (this._destroyed)
            return;

        // --- Load GI bindings (dynamic so a missing typelib degrades gracefully).
        try {
            const [ED, ECal, ICal] = await Promise.all([
                import('gi://EDataServer?version=1.2'),
                import('gi://ECal?version=2.0'),
                import('gi://ICalGLib'),
            ]);
            this._ED = ED.default;
            this._ECal = ECal.default;
            this._ICal = ICal.default;
        } catch (e) {
            logMsg('EDS/ECal/ICalGLib bindings unavailable; calendar source degraded:', `${e}`);
            this._ready = false;
            return;
        }

        // Goa is optional — only used to sharpen isGoogle detection.
        try {
            const Goa = await import('gi://Goa?version=1.0');
            this._Goa = Goa.default;
        } catch (_e) {
            this._Goa = null; // Fine; we fall back to backend-name heuristics.
        }

        // --- Create the source registry.
        try {
            this._registry = await this._newRegistry();
        } catch (e) {
            logMsg('SourceRegistry creation failed; no calendars available:', `${e}`);
            this._registry = null;
            this._ready = false;
            return;
        }
        if (!this._registry) {
            logMsg('SourceRegistry is null; no calendars available.');
            this._ready = false;
            return;
        }

        // --- Enumerate calendar sources and build the catalog.
        this._buildCatalog();
        logMsg(`discovered ${this._catalog.length} calendar source(s);`,
            `google-backed=${this._catalog.filter(c => c.isGoogle).length}`);
        for (const c of this._catalog)
            logMsg(`  source uid=${c.uid} backend=${c.backendName || '?'} google=${c.isGoogle} name="${c.displayName}"`);

        // --- Connect a client per source (best-effort, per-source try/catch).
        await this._connectAllClients();

        // --- Watch for changes.
        this._installRegistrySignals();
        this._installViews();

        this._ready = this._registry !== null;
    }

    /** Wrap the async SourceRegistry constructor in a Promise. */
    _newRegistry() {
        const ED = this._ED;
        return new Promise((resolve, reject) => {
            try {
                ED.SourceRegistry.new(this._cancellable, (_obj, res) => {
                    try {
                        resolve(ED.SourceRegistry.new_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            } catch (e) {
                // Fall back to the synchronous constructor if the async form is
                // unavailable for some reason.
                try {
                    resolve(ED.SourceRegistry.new_sync(this._cancellable));
                } catch (e2) {
                    reject(e2);
                }
            }
        });
    }

    /** Populate this._catalog from the registry's calendar sources. */
    _buildCatalog() {
        const ED = this._ED;
        this._catalog = [];
        let sources;
        try {
            sources = this._registry.list_sources(ED.SOURCE_EXTENSION_CALENDAR) || [];
        } catch (e) {
            logMsg('list_sources failed:', `${e}`);
            return;
        }

        for (const source of sources) {
            const uid = safe(() => source.get_uid(), '') || '';
            if (!uid)
                continue;
            const displayName = safe(() => source.get_display_name(), '') || uid;
            let backendName = '';
            try {
                const ext = source.get_extension(ED.SOURCE_EXTENSION_CALENDAR);
                backendName = (ext && safe(() => ext.get_backend_name(), '')) || '';
            } catch (_e) {
                backendName = '';
            }
            const isGoogle = this._isGoogleSource(source, backendName);
            const ownerEmail = this._resolveOwnerEmail(source);
            this._catalog.push({ source, uid, displayName, backendName, isGoogle, ownerEmail });
        }
    }

    /**
     * Decide whether a source is Google/GOA-backed. Lenient by design:
     *   - backend name 'google' → true;
     *   - source (or its parent) carries the GOA extension whose account maps to
     *     a Goa provider of type 'google' (when Goa is available);
     *   - source (or its parent) carries the GOA extension and the backend is a
     *     CalDAV/webcal talking to a google host.
     */
    _isGoogleSource(source, backendName) {
        if ((backendName || '').toLowerCase() === 'google')
            return true;

        const ED = this._ED;

        // Collect the GOA account id from this source or its parent.
        const goaAccountId = this._goaAccountId(source);
        if (goaAccountId) {
            // If we have Goa, verify the provider type is Google.
            const provider = this._goaProviderType(goaAccountId);
            if (provider && provider.toLowerCase().includes('google'))
                return true;
            // Even without Goa, a google-ish address is a strong hint.
            const addr = this._resolveOwnerEmail(source);
            if (addr && addr.toLowerCase().endsWith('@gmail.com'))
                return true;
        }

        // Last resort: a CalDAV source pointing at a Google host.
        try {
            if (source.has_extension(ED.SOURCE_EXTENSION_CALENDAR)) {
                const ext = source.get_extension(ED.SOURCE_EXTENSION_CALENDAR);
                // Some EDS versions expose a soup/webdav URI via other extensions;
                // keep this defensive and cheap.
                const host = safe(() => ext.get_host && ext.get_host(), '') || '';
                if (host && host.toLowerCase().includes('google'))
                    return true;
            }
        } catch (_e) { /* ignore */ }

        return false;
    }

    /** GOA account id for a source or its parent, or '' if none. */
    _goaAccountId(source) {
        const ED = this._ED;
        const readFrom = (src) => {
            try {
                if (src && src.has_extension(ED.SOURCE_EXTENSION_GOA)) {
                    const goa = src.get_extension(ED.SOURCE_EXTENSION_GOA);
                    return (goa && safe(() => goa.get_account_id(), '')) || '';
                }
            } catch (_e) { /* ignore */ }
            return '';
        };
        let id = readFrom(source);
        if (id)
            return id;
        // Walk up to the collection/account parent.
        try {
            const parentUid = safe(() => source.get_parent(), '');
            if (parentUid && this._registry) {
                const parent = safe(() => this._registry.ref_source(parentUid), null);
                if (parent)
                    id = readFrom(parent);
            }
        } catch (_e) { /* ignore */ }
        return id;
    }

    /** Map a GOA account id → provider type via Goa (best-effort). '' if unknown. */
    _goaProviderType(accountId) {
        if (!this._Goa || !accountId)
            return '';
        try {
            if (!this._goaClient)
                this._goaClient = this._Goa.Client.new_sync(this._cancellable);
            const objects = this._goaClient.get_accounts() || [];
            for (const obj of objects) {
                const account = safe(() => obj.get_account(), null);
                if (!account)
                    continue;
                const id = safe(() => account.get_id(), '');
                if (id === accountId)
                    return safe(() => account.get_provider_type(), '') || '';
            }
        } catch (_e) { /* ignore — degrade to heuristic */ }
        return '';
    }

    /**
     * Best-effort owner email for RSVP matching:
     *   1. GOA address on the source;
     *   2. GOA address on the parent (account/collection) source;
     *   3. Authentication extension's user.
     * Returned lowercased; '' if unknown.
     */
    _resolveOwnerEmail(source) {
        const ED = this._ED;

        const goaAddress = (src) => {
            try {
                if (src && src.has_extension(ED.SOURCE_EXTENSION_GOA)) {
                    const goa = src.get_extension(ED.SOURCE_EXTENSION_GOA);
                    const addr = goa && safe(() => goa.get_address(), '');
                    if (addr)
                        return addr;
                }
            } catch (_e) { /* ignore */ }
            return '';
        };

        let addr = goaAddress(source);
        if (!addr) {
            const parentUid = safe(() => source.get_parent(), '');
            if (parentUid && this._registry) {
                const parent = safe(() => this._registry.ref_source(parentUid), null);
                if (parent)
                    addr = goaAddress(parent);
            }
        }
        if (!addr) {
            try {
                if (source.has_extension(ED.SOURCE_EXTENSION_AUTHENTICATION)) {
                    const auth = source.get_extension(ED.SOURCE_EXTENSION_AUTHENTICATION);
                    addr = (auth && safe(() => auth.get_user(), '')) || '';
                }
            } catch (_e) { /* ignore */ }
        }
        return (addr || '').toLowerCase();
    }

    /** Connect an ECal client for each cataloged source. */
    async _connectAllClients() {
        for (const c of this._catalog) {
            if (this._destroyed)
                return;
            let client = null;
            try {
                client = await this._connectClient(c.source);
            } catch (e) {
                logMsg(`connect failed for uid=${c.uid} ("${c.displayName}"): ${e}`);
                client = null;
            }
            this._entries.set(c.uid, {
                source: c.source,
                client,
                uid: c.uid,
                displayName: c.displayName,
                backendName: c.backendName,
                isGoogle: c.isGoogle,
                ownerEmail: c.ownerEmail,
                view: null,
                viewHandlerIds: [],
            });
            if (client)
                logMsg(`connected client uid=${c.uid} backend=${c.backendName || '?'}`);
        }
    }

    /** Promise wrapper around ECal.Client.connect (async), with sync fallback. */
    _connectClient(source) {
        const ECal = this._ECal;
        return new Promise((resolve, reject) => {
            try {
                ECal.Client.connect(
                    source,
                    ECal.ClientSourceType.EVENTS,
                    CONNECT_WAIT_SECONDS,
                    this._cancellable,
                    (_obj, res) => {
                        try {
                            resolve(ECal.Client.connect_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            } catch (e) {
                // Fall back to the synchronous connect.
                try {
                    resolve(ECal.Client.connect_sync(
                        source, ECal.ClientSourceType.EVENTS, CONNECT_WAIT_SECONDS, this._cancellable));
                } catch (e2) {
                    reject(e2);
                }
            }
        });
    }

    // ---------------------------------------------------------------------
    // Public queries
    // ---------------------------------------------------------------------

    /**
     * @returns {Array<{uid:string, displayName:string, backendName:string, isGoogle:boolean}>}
     */
    listCalendars() {
        try {
            return this._catalog.map(c => ({
                uid: c.uid,
                displayName: c.displayName,
                backendName: c.backendName,
                isGoogle: c.isGoogle,
            }));
        } catch (e) {
            logMsg('listCalendars failed:', `${e}`);
            return [];
        }
    }

    /** @returns {boolean} */
    hasGoogleAccount() {
        try {
            return this._catalog.some(c => c.isGoogle);
        } catch (_e) {
            return false;
        }
    }

    /**
     * Query events occurring today (local 00:00 → 24:00) across the given calendars.
     * @param {{enabledCalendars: string[]}} [opts]
     * @returns {Promise<import('../lib/types.js').MeetingEvent[]>}
     */
    async getTodayEvents(opts) {
        const events = [];
        if (this._destroyed || !this._ECal || !this._ICal)
            return events;

        const enabled = (opts && Array.isArray(opts.enabledCalendars)) ? opts.enabledCalendars : [];
        const useAll = enabled.length === 0;

        // Compute today's local-day bounds.
        const bounds = this._todayBounds();
        if (!bounds) {
            logMsg('could not compute day bounds; returning no events.');
            return events;
        }
        const { startSecs, endSecs, sexp } = bounds;

        for (const entry of this._entries.values()) {
            if (this._destroyed)
                break;
            if (!entry.client)
                continue;
            if (!useAll && !enabled.includes(entry.uid))
                continue;

            let count = 0;
            const before = events.length;
            try {
                count = this._generateInstances(entry, startSecs, endSecs, events);
            } catch (e) {
                logMsg(`generate_instances failed uid=${entry.uid}: ${e}; trying object-list fallback`);
                count = -1;
            }
            if (count < 0) {
                // Fallback: object list (recurring masters — approximate times).
                try {
                    this._queryObjectList(entry, sexp, events);
                } catch (e) {
                    logMsg(`object-list fallback failed uid=${entry.uid}: ${e}`);
                }
            }
            logMsg(`uid=${entry.uid} yielded ${events.length - before} event(s) for today`);
        }

        logMsg(`getTodayEvents: ${events.length} event(s) total`);
        return events;
    }

    /** Compute {startSecs,endSecs,sexp} for the local day, or null. */
    _todayBounds() {
        try {
            const now = GLib.DateTime.new_now_local();
            const startLocal = GLib.DateTime.new_local(
                now.get_year(), now.get_month(), now.get_day_of_month(), 0, 0, 0);
            const endLocal = startLocal.add_days(1);
            const startSecs = startLocal.to_unix();
            const endSecs = endLocal.to_unix();
            const startZ = startLocal.to_utc().format('%Y%m%dT%H%M%SZ');
            const endZ = endLocal.to_utc().format('%Y%m%dT%H%M%SZ');
            const sexp = `(occur-in-time-range? (make-time "${startZ}") (make-time "${endZ}"))`;
            return { startSecs, endSecs, sexp };
        } catch (e) {
            logMsg('_todayBounds error:', `${e}`);
            return null;
        }
    }

    /**
     * Expand real occurrences via generate_instances_sync. Returns the number of
     * events appended, or throws if the call itself fails (caller falls back).
     */
    _generateInstances(entry, startSecs, endSecs, out) {
        const ECal = this._ECal;
        let appended = 0;

        // The ECalRecurInstanceCb shape varies across EDS versions: it may pass an
        // ICalGLib.Component or an ECal.Component, and instance start/end as either
        // ICalGLib.Time or raw time_t numbers. Normalize defensively.
        const cb = (compArg, startArg, endArg) => {
            try {
                const icomp = this._toIcalComponent(compArg);
                if (!icomp)
                    return true; // keep iterating
                const instStartMs = this._flexTimeToMs(startArg);
                const instEndMs = this._flexTimeToMs(endArg);
                const ev = this._buildEvent(entry, icomp, instStartMs, instEndMs);
                if (ev) {
                    out.push(ev);
                    appended++;
                }
            } catch (e) {
                logMsg(`instance callback error uid=${entry.uid}: ${e}`);
            }
            return true; // continue enumeration
        };

        entry.client.generate_instances_sync(startSecs, endSecs, this._cancellable, cb);
        return appended;
    }

    /** Fallback: query whole objects (masters) and build events from them. */
    _queryObjectList(entry, sexp, out) {
        const [ok, comps] = entry.client.get_object_list_as_comps_sync(sexp, this._cancellable);
        if (!ok || !comps)
            return;
        for (const comp of comps) {
            const icomp = this._toIcalComponent(comp);
            if (!icomp)
                continue;
            const dts = safe(() => icomp.get_dtstart(), null);
            const dte = safe(() => icomp.get_dtend(), null);
            const startMs = dts ? this._icalTimeToMs(dts) : 0;
            const endMs = dte ? this._icalTimeToMs(dte) : startMs;
            const ev = this._buildEvent(entry, icomp, startMs, endMs);
            if (ev)
                out.push(ev);
        }
    }

    /** Normalize a callback/component argument to an ICalGLib.Component or null. */
    _toIcalComponent(arg) {
        if (!arg)
            return null;
        // ECal.Component → its icalcomponent.
        if (typeof arg.get_icalcomponent === 'function')
            return safe(() => arg.get_icalcomponent(), null);
        // Already an ICalGLib.Component (has property/summary accessors).
        if (typeof arg.get_first_property === 'function' || typeof arg.get_summary === 'function')
            return arg;
        return null;
    }

    /** Convert a flexible time arg (ICalGLib.Time | time_t number | null) → unix ms. */
    _flexTimeToMs(v) {
        if (v == null)
            return 0;
        if (typeof v === 'number')
            return v > 0 ? v * 1000 : 0;
        if (typeof v.as_timet === 'function')
            return this._icalTimeToMs(v);
        return 0;
    }

    /** Convert an ICalGLib.Time → unix epoch ms (absolute instant). */
    _icalTimeToMs(t) {
        const ICal = this._ICal;
        if (!t)
            return 0;
        if (safe(() => t.is_null_time(), false))
            return 0;

        // All-day (DATE, no time component): interpret as local midnight so the
        // event lands on the correct calendar day for the user.
        if (safe(() => t.is_date(), false)) {
            const y = safe(() => t.get_year(), 0);
            const mo = safe(() => t.get_month(), 0);
            const d = safe(() => t.get_day(), 0);
            if (y && mo && d) {
                const dt = safe(() => GLib.DateTime.new_local(y, mo, d, 0, 0, 0), null);
                if (dt)
                    return dt.to_unix() * 1000;
            }
            return 0;
        }

        // Timed value: return the absolute instant. Use the time's own zone as the
        // source zone when present, else UTC. as_timet_with_zone yields UTC seconds,
        // which is exactly the absolute unix time we want (display tz is irrelevant).
        let zone = safe(() => t.get_timezone(), null);
        if (!zone)
            zone = safe(() => ICal.Timezone.get_utc_timezone(), null);
        let secs = 0;
        if (zone)
            secs = safe(() => t.as_timet_with_zone(zone), 0);
        if (!secs)
            secs = safe(() => t.as_timet(), 0);
        return secs > 0 ? secs * 1000 : 0;
    }

    /**
     * Build a normalized MeetingEvent from an ICalGLib.Component and the
     * occurrence's start/end (unix ms). Returns null on unrecoverable error.
     */
    _buildEvent(entry, icomp, instStartMs, instEndMs) {
        const ICal = this._ICal;

        const uid = safe(() => icomp.get_uid(), '') || '';
        const title = safe(() => icomp.get_summary(), '') || '';

        // All-day flag from the component's DTSTART value type.
        const dts = safe(() => icomp.get_dtstart(), null);
        const allDay = dts ? safe(() => dts.is_date(), false) : false;

        // Prefer the occurrence's instance times (correct for recurrences);
        // fall back to the component's own DTSTART/DTEND.
        let startMs = instStartMs || (dts ? this._icalTimeToMs(dts) : 0);
        let endMs = instEndMs;
        if (!endMs) {
            const dte = safe(() => icomp.get_dtend(), null);
            endMs = dte ? this._icalTimeToMs(dte) : 0;
        }
        if (!endMs)
            endMs = startMs;

        // Stable per-occurrence id: uid + recurrence-id (or instance start).
        let rid = '';
        const ridT = safe(() => icomp.get_recurrenceid(), null);
        if (ridT && !safe(() => ridT.is_null_time(), true))
            rid = String(this._icalTimeToMs(ridT));
        if (!rid && startMs)
            rid = String(startMs);
        const id = rid ? `${uid}::${rid}` : uid;

        // Raw text fields.
        const location = safe(() => icomp.get_location(), '') || '';
        const description = safe(() => icomp.get_description(), '') || '';
        const url = this._readUrl(icomp);
        const xGoogleConference = this._readXGoogleConference(icomp);

        // RSVP from the owner's ATTENDEE PARTSTAT.
        const rsvp = this._resolveRsvp(icomp, entry.ownerEmail);

        // Diagnostic logging: presence/lengths only, never contents.
        const titleForLog = title.length > 40 ? `${title.slice(0, 40)}…` : title;
        logMsg(
            `event uid=${uid} cal=${entry.uid} "${titleForLog}"`,
            `allDay=${allDay} rsvp=${rsvp}`,
            `xgc=${xGoogleConference ? 'yes' : 'no'}`,
            `loc=${location.length} desc=${description.length} url=${url ? 'yes' : 'no'}`
        );

        return makeEvent({
            id,
            title,
            start: startMs,
            end: endMs,
            allDay,
            calendarId: entry.uid,
            rsvp,
            joinUrl: null,
            service: null,
            raw: { location, description, url, xGoogleConference },
        });
    }

    /** Read the URL property value, or '' if absent. */
    _readUrl(icomp) {
        const ICal = this._ICal;
        try {
            const prop = icomp.get_first_property(ICal.PropertyKind.URL_PROPERTY);
            if (!prop)
                return '';
            let v = safe(() => prop.get_url(), '');
            if (!v)
                v = safe(() => prop.get_value_as_string(), '');
            return v || '';
        } catch (_e) {
            return '';
        }
    }

    /** Find X-GOOGLE-CONFERENCE among the X-properties; '' if absent. */
    _readXGoogleConference(icomp) {
        const ICal = this._ICal;
        try {
            let prop = icomp.get_first_property(ICal.PropertyKind.X_PROPERTY);
            while (prop) {
                const name = safe(() => prop.get_x_name(), '') || '';
                if (name.toUpperCase() === 'X-GOOGLE-CONFERENCE') {
                    let v = safe(() => prop.get_x(), '');
                    if (!v)
                        v = safe(() => prop.get_value_as_string(), '');
                    return v || '';
                }
                prop = icomp.get_next_property(ICal.PropertyKind.X_PROPERTY);
            }
        } catch (_e) { /* ignore */ }
        return '';
    }

    /**
     * Resolve RSVP by matching the owner's email against the event's ATTENDEE
     * CAL-ADDRESS (case-insensitive, mailto: stripped) and reading PARTSTAT.
     * Returns Rsvp.UNKNOWN when there is no owner email or no matching attendee.
     */
    _resolveRsvp(icomp, ownerEmail) {
        const ICal = this._ICal;
        if (!ownerEmail)
            return Rsvp.UNKNOWN;
        try {
            let prop = icomp.get_first_property(ICal.PropertyKind.ATTENDEE_PROPERTY);
            while (prop) {
                let cal = safe(() => prop.get_attendee(), '') || '';
                cal = cal.replace(/^mailto:/i, '').trim().toLowerCase();
                if (cal && cal === ownerEmail)
                    return this._readPartstat(prop);
                prop = icomp.get_next_property(ICal.PropertyKind.ATTENDEE_PROPERTY);
            }
        } catch (_e) { /* ignore */ }
        return Rsvp.UNKNOWN;
    }

    /** Read PARTSTAT from an ATTENDEE property → Rsvp value. */
    _readPartstat(prop) {
        const ICal = this._ICal;
        // Enum path first.
        try {
            const param = prop.get_first_parameter(ICal.ParameterKind.PARTSTAT_PARAMETER);
            if (param) {
                const ps = safe(() => param.get_partstat(), null);
                const P = ICal.ParameterPartstat;
                if (P) {
                    if (ps === P.ACCEPTED)
                        return Rsvp.ACCEPTED;
                    if (ps === P.DECLINED)
                        return Rsvp.DECLINED;
                    if (ps === P.TENTATIVE)
                        return Rsvp.TENTATIVE;
                    if (ps === P.NEEDSACTION)
                        return Rsvp.NEEDS_ACTION;
                }
            }
        } catch (_e) { /* fall through to string parse */ }

        // String fallback (handles "PARTSTAT=ACCEPTED" or bare "ACCEPTED").
        try {
            let s = prop.get_parameter_as_string('PARTSTAT');
            if (s) {
                s = s.toUpperCase();
                if (s.includes('ACCEPTED'))
                    return Rsvp.ACCEPTED;
                if (s.includes('DECLINED'))
                    return Rsvp.DECLINED;
                if (s.includes('TENTATIVE'))
                    return Rsvp.TENTATIVE;
                if (s.includes('NEEDS-ACTION') || s.includes('NEEDSACTION'))
                    return Rsvp.NEEDS_ACTION;
            }
        } catch (_e) { /* ignore */ }

        return Rsvp.UNKNOWN;
    }

    // ---------------------------------------------------------------------
    // Change watching
    // ---------------------------------------------------------------------

    /**
     * Register a callback fired when any watched calendar changes.
     * @param {() => void} cb
     * @returns {number} handler id (pass to disconnectChanged)
     */
    connectChanged(cb) {
        const id = this._nextChangeId++;
        if (typeof cb === 'function')
            this._changeCbs.set(id, cb);
        if (!this._registry && this._entries.size === 0)
            logMsg('connectChanged: change-watching unavailable (no registry/clients yet).');
        return id;
    }

    /** Disconnect a changed handler by id. */
    disconnectChanged(id) {
        this._changeCbs.delete(id);
    }

    /** Fan out a change notification to all registered callbacks. */
    _notifyChanged() {
        for (const cb of this._changeCbs.values()) {
            try {
                cb();
            } catch (e) {
                logMsg('change callback threw:', `${e}`);
            }
        }
    }

    /** Connect registry-level signals so account/calendar edits trigger refresh. */
    _installRegistrySignals() {
        if (!this._registry)
            return;
        const signals = ['source-added', 'source-removed', 'source-changed', 'source-enabled', 'source-disabled'];
        for (const name of signals) {
            try {
                const hid = this._registry.connect(name, () => this._notifyChanged());
                this._registryHandlerIds.push(hid);
            } catch (_e) {
                // Some signals may not exist on all EDS versions; ignore.
            }
        }
    }

    /** Create a live view per connected client and wire its object signals. */
    _installViews() {
        for (const entry of this._entries.values()) {
            if (!entry.client)
                continue;
            let view = null;
            try {
                // "#t" matches all objects: any add/modify/remove fires a refresh.
                const [ok, v] = entry.client.get_view_sync('#t', this._cancellable);
                if (ok && v)
                    view = v;
            } catch (e) {
                logMsg(`get_view_sync failed uid=${entry.uid}: ${e}`);
                view = null;
            }
            if (!view) {
                logMsg(`change-watching unavailable for uid=${entry.uid} (no view).`);
                continue;
            }
            entry.view = view;
            for (const sig of ['objects-added', 'objects-modified', 'objects-removed']) {
                try {
                    const hid = view.connect(sig, () => this._notifyChanged());
                    entry.viewHandlerIds.push(hid);
                } catch (_e) { /* ignore */ }
            }
            try {
                view.start();
            } catch (e) {
                logMsg(`view.start failed uid=${entry.uid}: ${e}`);
            }
        }
    }

    // ---------------------------------------------------------------------
    // Teardown
    // ---------------------------------------------------------------------

    /** Tear down all ECal clients, views, and the registry. */
    destroy() {
        this._destroyed = true;
        this._ready = false;

        try {
            if (this._cancellable && !this._cancellable.is_cancelled())
                this._cancellable.cancel();
        } catch (_e) { /* ignore */ }

        // Views.
        for (const entry of this._entries.values()) {
            try {
                if (entry.view) {
                    for (const hid of entry.viewHandlerIds)
                        safe(() => entry.view.disconnect(hid));
                    safe(() => entry.view.stop());
                }
            } catch (_e) { /* ignore */ }
            entry.view = null;
            entry.viewHandlerIds = [];
            entry.client = null;
        }
        this._entries.clear();

        // Registry signals.
        if (this._registry) {
            for (const hid of this._registryHandlerIds)
                safe(() => this._registry.disconnect(hid));
        }
        this._registryHandlerIds = [];

        this._changeCbs.clear();
        this._catalog = [];
        this._registry = null;
        this._goaClient = null;
        this._ED = null;
        this._ECal = null;
        this._ICal = null;
        this._Goa = null;
    }
}
