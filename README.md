# gmeetminder

A GNOME Shell extension that keeps your next Google Meet one glance — and zero clicks — away.
Inspired by [MeetingBar](https://github.com/leits/MeetingBar) for macOS.

- **Top-bar countdown** to your next meeting (e.g. "Management sync in 11m").
- **Dropdown** with today's events; click any event to join.
- **Auto-opens Chrome** to the Meet URL 1 minute before start (configurable; or switch to a notification with a Join button).
- **Join next meeting** global shortcut (default `Super+Shift+J`).
- **Create instant meeting** (`meet.new`) and **bookmarks** for recurring rooms.
- Reads your calendars from **GNOME Online Accounts** via **Evolution Data Server** — no OAuth setup, no API keys.

## Requirements

- GNOME Shell **50** (Wayland or X11).
- Google Chrome (`google-chrome`); the command is configurable.
- A Google account added in **Settings → Online Accounts** with **Calendar** enabled.

## Install (from source)

```sh
make install          # compiles the GSettings schema and copies to ~/.local/share/gnome-shell/extensions
# Log out and back in (Wayland), then:
gnome-extensions enable gmeetminder@dfreiber.local
```

Open preferences with `gnome-extensions prefs gmeetminder@dfreiber.local`.

## Configure

Preferences let you set:

- **Joining** — auto-open vs. notify, and the lead time (default 60s).
- **Chrome** — the command and which **profile** to launch (enumerated from your Chrome install).
- **Which meetings auto-open** — require a video link, skip declined, skip all-day, only-accepted, and whether to detect Zoom/Teams links too. Defaults: require link ✓, skip declined ✓, skip all-day ✓, only-accepted ✗.
- **Calendars** — choose which calendars to watch (all by default).
- **Bookmarks** — named links pinned in the dropdown.
- **Shortcut** — the global "join next meeting" accelerator.

## Develop

```sh
make test      # run pure-logic unit tests (meetLink, scheduler, launcher) under gjs
make schemas   # recompile the GSettings schema after editing it
make logs      # tail the shell journal filtered to this extension
```

Architecture and design rationale live in
[`docs/superpowers/specs/2026-08-26-gmeetminder-design.md`](docs/superpowers/specs/2026-08-26-gmeetminder-design.md).

### Verifying calendar data on your machine

Because meeting links can live in different fields depending on how Google syncs
them, there's a standalone probe:

```sh
gjs -m tests/eds_probe.js
```

It lists your calendars and prints a **redacted** summary of today's events
(title, time, all-day, RSVP, and which field a join link would come from) so you
can confirm gmeetminder finds your Meet links.
