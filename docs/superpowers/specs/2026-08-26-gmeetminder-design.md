# gmeetminder — Design Spec

**Date:** 2026-08-26
**Status:** Approved (backbone + decisions confirmed by user)
**Inspiration:** [MeetingBar](https://github.com/leits/MeetingBar) (macOS, Swift). We reuse the UX/feature concepts, not the code.

## Goal

A GNOME Shell extension that shows the next meeting + countdown in the top bar, lists today's events in a dropdown, and — 1 minute before a meeting starts — automatically opens Google Chrome (with a user-selected profile) to the meeting's Google Meet URL. Targets GNOME users on GNOME Shell 50 / Wayland.

## Key Decisions (locked)

| Decision | Choice |
|---|---|
| Calendar data source | **GNOME Online Accounts → Evolution Data Server (EDS)**. Zero OAuth setup; GNOME manages tokens. |
| Packaging | **Pure GNOME Shell extension (GJS/ESM, GNOME 50)**. Single artifact. Only shell extensions can register global shortcuts. |
| Join behavior | **Configurable**: `auto-open` (default) launches Chrome silently; `notify` shows a notification with a Join button. |
| Lead time | Configurable, default **60s**. |
| Event filters | All configurable. Defaults: require Meet link ✓, skip declined ✓, skip all-day ✓, require-accepted ✗. |
| v1 extras (all in) | Join-next + global shortcut, Create instant meeting (`meet.new`), Bookmarks, non-Meet service detection (Zoom/Teams/etc.). |
| Chrome launch | `google-chrome --profile-directory="<dir>" --new-window "<url>"` via async `Gio.Subprocess`. |

## Architecture

Single extension, split into focused modules communicating through a normalized `MeetingEvent` struct.

| Module | Responsibility | Deps |
|---|---|---|
| `extension.js` | Lifecycle (enable/disable), wires modules | Shell |
| `lib/calendarSource.js` | Enumerate GOA-backed EDS calendars; query today's events; normalize to `MeetingEvent[]`; emit `changed` | `ECal`, `EDataServer`, `GLib` |
| `lib/meetLink.js` | Extract join URL + classify service. Priority: `X-GOOGLE-CONFERENCE` → location → description → url | pure JS |
| `lib/scheduler.js` | Compute next actionable meeting; fire `start − leadTime` triggers (de-duped); drive countdown tick. Clock injectable. | `GLib` (injected) |
| `lib/launcher.js` | Build/run Chrome command line (profile, new-window, url); `meet.new`; enumerate Chrome profiles | `Gio` |
| `lib/indicator.js` | Panel button (countdown label) + dropdown PopupMenu | Shell UI |
| `lib/notifier.js` | Notification-with-Join-button path | Shell MessageTray |
| `lib/settings.js` | Typed wrapper over GSettings | `Gio.Settings` |
| `prefs.js` | libadwaita preferences window | `Adw`, `Gtk4` |

### `MeetingEvent` interface (the boundary contract)

```js
/**
 * @typedef {Object} MeetingEvent
 * @property {string}  id           Stable per-occurrence id (uid + recurrence-id)
 * @property {string}  title        Event summary (may be '')
 * @property {number}  start        Unix ms, local
 * @property {number}  end          Unix ms, local
 * @property {boolean} allDay
 * @property {string}  calendarId   EDS source UID
 * @property {'accepted'|'declined'|'tentative'|'needs-action'|'unknown'} rsvp
 * @property {string|null} joinUrl  Filled by meetLink.js
 * @property {'meet'|'zoom'|'teams'|'other'|null} service
 * @property {Object}  raw          { location, description, url, xGoogleConference }
 */
```

### Data flow

```
GOA → EDS → calendarSource (query today) → MeetingEvent[]
   → meetLink (enrich joinUrl/service) → { indicator (UI), scheduler (triggers) }
   → scheduler fires → auto-open ? launcher : notifier → google-chrome
```

EDS emits change signals → reactive refresh, plus a periodic safety re-poll (e.g. every 5 min).

## Settings schema (GSettings, id `org.gnome.shell.extensions.gmeetminder`)

- `join-mode` enum `['auto-open','notify']` = `auto-open`
- `lead-time-seconds` int = 60
- `enabled-calendars` as (array of EDS source UIDs); empty = all
- `chrome-command` string = `google-chrome`
- `chrome-profile` string = `Default`
- `filter-require-meet-link` bool = true
- `filter-skip-declined` bool = true
- `filter-skip-all-day` bool = true
- `filter-require-accepted` bool = false
- `detect-services` bool = true
- `bookmarks` as (array of JSON strings `{"name","url"}`)
- `join-next-shortcut` as (keybinding) = `['<Super><Shift>j']`

## Meet-link extraction

1. `X-GOOGLE-CONFERENCE` iCal X-property (cleanest).
2. Regex `https://meet\.google\.com/[a-z0-9-]+` across location, description, url.
3. If `detect-services`: Zoom (`*.zoom.us/j/…`), Teams (`teams.microsoft.com/l/meetup-join/…`), generic fallback.

Log which source matched (self-diagnosing on real data).

## RSVP

Match the calendar owner's email (from GOA account) against event `ATTENDEE` `PARTSTAT` → accepted/declined/tentative/needs-action. Unknown if unmatched.

## Scheduler behavior

- Per second: recompute countdown label ("in 11m", "in 45s", "now").
- Per meeting: one-shot trigger at `start − leadTime`; record fired ids so a meeting opens once.
- Meetings already in progress at enable/login: single "still running — join?" notification, never a surprise auto-launch.

## Error handling / edge cases

- No GOA/Google account → dropdown shows a "Connect a Google account in Settings → Online Accounts" hint.
- No Chrome binary → error notification; command configurable.
- Event with no join URL → shown in list, not eligible for auto-open, greyed "join".
- Overlapping meetings → next by start time; both listed.
- Chrome profile missing → fall back to `Default`, warn in prefs.
- Clock changes / suspend-resume → recompute on `changed` and on a wall-clock check.

## Testing

- **Unit (TDD):** `meetLink.js` (extraction/classification across fixture events), `scheduler.js` (trigger timing, de-dupe, in-progress handling, countdown formatting) with an injected clock.
- **Mocked:** `launcher.js` (assert argv), Chrome profile parsing.
- **Manual smoke checklist:** load extension, verify panel label, dropdown contents, auto-open on a real/near-term event, notify mode, global shortcut, create-meeting, bookmarks.

## Project structure

```
gmeetminder@dfreiber.local/
  metadata.json
  extension.js
  prefs.js
  lib/{calendarSource,meetLink,scheduler,launcher,indicator,notifier,settings}.js
  schemas/org.gnome.shell.extensions.gmeetminder.gschema.xml
  stylesheet.css
tests/
  runner + meetLink.test.js + scheduler.test.js + fixtures/
docs/superpowers/specs/2026-08-26-gmeetminder-design.md
Makefile   (build schemas, pack, install, test)
```

## Out of scope (v1)

Multi-day agenda, per-calendar colors, custom countdown templates, non-Google CalDAV specifics beyond what EDS gives, Firefox/other browsers (Chrome only for now, command configurable).
