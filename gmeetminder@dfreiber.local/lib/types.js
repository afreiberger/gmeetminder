/**
 * Shared type contracts for gmeetminder.
 *
 * Every module speaks `MeetingEvent`. This file is the interface boundary:
 * do not add module-specific fields here without updating the spec.
 *
 * @typedef {Object} MeetingEvent
 * @property {string}  id           Stable per-occurrence id (uid + recurrence-id).
 * @property {string}  title        Event summary; may be ''.
 * @property {number}  start        Unix epoch milliseconds (local wall clock).
 * @property {number}  end          Unix epoch milliseconds (local wall clock).
 * @property {boolean} allDay       True for all-day events.
 * @property {string}  calendarId   EDS source UID the event came from.
 * @property {('accepted'|'declined'|'tentative'|'needs-action'|'unknown')} rsvp
 * @property {?string} joinUrl      Filled by meetLink.enrich(); null if none found.
 * @property {?('meet'|'zoom'|'teams'|'other')} service  Classified by meetLink.enrich().
 * @property {RawEventText} raw     Original text fields used for link extraction.
 */

/**
 * @typedef {Object} RawEventText
 * @property {string} location
 * @property {string} description
 * @property {string} url
 * @property {string} xGoogleConference  Value of the X-GOOGLE-CONFERENCE property, or ''.
 */

/** RSVP status values. */
export const Rsvp = Object.freeze({
    ACCEPTED: 'accepted',
    DECLINED: 'declined',
    TENTATIVE: 'tentative',
    NEEDS_ACTION: 'needs-action',
    UNKNOWN: 'unknown',
});

/** Known conferencing services. */
export const Service = Object.freeze({
    MEET: 'meet',
    ZOOM: 'zoom',
    TEAMS: 'teams',
    OTHER: 'other',
});

/**
 * Create a MeetingEvent with safe defaults. Callers override fields as needed.
 * @param {Partial<MeetingEvent>} [fields]
 * @returns {MeetingEvent}
 */
export function makeEvent(fields = {}) {
    return {
        id: '',
        title: '',
        start: 0,
        end: 0,
        allDay: false,
        calendarId: '',
        rsvp: Rsvp.UNKNOWN,
        joinUrl: null,
        service: null,
        raw: { location: '', description: '', url: '', xGoogleConference: '' },
        ...fields,
    };
}
