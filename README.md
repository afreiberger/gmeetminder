<div align="center">

# gmeetminder

**Your next Google Meet — one glance, zero clicks away.**

A GNOME Shell extension that puts a live countdown to your next meeting in the
top bar and opens it in Chrome right before it starts.

[![CI](https://github.com/afreiberger/gmeetminder/actions/workflows/ci.yml/badge.svg)](https://github.com/afreiberger/gmeetminder/actions/workflows/ci.yml)
[![License: GPL v2+](https://img.shields.io/badge/License-GPLv2%2B-blue.svg)](LICENSE)
[![GNOME Shell 50](https://img.shields.io/badge/GNOME%20Shell-50-4A86CF.svg)](https://release.gnome.org/)

</div>

Inspired by [MeetingBar](https://github.com/leits/MeetingBar) for macOS — the UX
and feature concepts, reimplemented natively for GNOME. See
[Acknowledgements](#acknowledgements).

## Features

- **Top-bar countdown** to your next meeting (e.g. _"Management sync in 11m"_).
- **Dropdown agenda** of today's events; click any event to join.
- **Auto-opens Chrome** to the Meet URL one minute before start (configurable —
  or switch to a notification with a **Join** button).
- **Join next meeting** global shortcut (default <kbd>Super</kbd>+<kbd>Shift</kbd>+<kbd>J</kbd>).
- **Create instant meeting** (`meet.new`) and **bookmarks** for recurring rooms.
- Detects **Zoom / Teams** links too, not just Google Meet.
- Reads calendars from **GNOME Online Accounts** via **Evolution Data Server** —
  no OAuth setup, no API keys, no tokens to manage.

## Screenshots

> _Add screenshots to `docs/screenshots/` and reference them here._

| Panel countdown | Dropdown agenda | Preferences |
| --- | --- | --- |
| _coming soon_ | _coming soon_ | _coming soon_ |

## Requirements

- **GNOME Shell 50** (Wayland or X11).
- **Google Chrome** (`google-chrome`) — the launch command is configurable.
- A Google account added in **Settings → Online Accounts** with **Calendar**
  enabled.

## Installation

### From source

```sh
git clone https://github.com/afreiberger/gmeetminder.git
cd gmeetminder
make install          # compiles the GSettings schema and copies to ~/.local/share/gnome-shell/extensions
```

Then log out and back in (required on Wayland) and enable it:

```sh
gnome-extensions enable gmeetminder@afreiberger.github.io
```

Open preferences with:

```sh
gnome-extensions prefs gmeetminder@afreiberger.github.io
```

## Configuration

Preferences let you set:

- **Joining** — auto-open vs. notify, and the lead time (default 60s).
- **Chrome** — the command and which **profile** to launch (enumerated from your
  Chrome install).
- **Which meetings auto-open** — require a video link, skip declined, skip
  all-day, only-accepted, and whether to detect Zoom/Teams links too.
  Defaults: require link ✓, skip declined ✓, skip all-day ✓, only-accepted ✗.
- **Calendars** — choose which calendars to watch (all by default).
- **Bookmarks** — named links pinned in the dropdown.
- **Shortcut** — the global "join next meeting" accelerator.

## Development

```sh
make test      # run pure-logic unit tests (meetLink, scheduler, launcher) under gjs
make schemas   # recompile the GSettings schema after editing it
make pack      # build a distributable .shell-extension.zip
make logs      # tail the shell journal filtered to this extension
```

Architecture and design rationale live in [`docs/DESIGN.md`](docs/DESIGN.md).

### Verifying calendar data on your machine

Because meeting links can live in different fields depending on how Google syncs
them, there's a standalone probe:

```sh
gjs -m tests/eds_probe.js
```

It lists your calendars and prints a **redacted** summary of today's events
(title, time, all-day, RSVP, and which field a join link would come from) so you
can confirm gmeetminder finds your Meet links.

## Contributing

Contributions are welcome! Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) for
the development workflow, coding conventions, and testing expectations.

## Acknowledgements

### 🙏 A huge shout-out to MeetingBar

gmeetminder exists because of **[MeetingBar](https://github.com/leits/MeetingBar)**
by [Andrii Leitsius](https://github.com/leits) and its contributors. MeetingBar
is the wonderful, open-source macOS menu-bar app that nailed the idea of keeping
your next meeting — and the one-click join — always within reach.

This project is an independent GNOME Shell reimagining of that experience for
Linux. **Every bit of the "next meeting at a glance, join with zero clicks" UX
was inspired by their work.** If you're on macOS, go use MeetingBar — and if you
like what gmeetminder does, star [their repo](https://github.com/leits/MeetingBar)
too. 💛

gmeetminder reuses the *concepts* only; none of MeetingBar's code (it's Swift) is
included here. All the credit for the original idea belongs to that team.

## License

Released under the [GNU General Public License v2.0 or later](LICENSE).
