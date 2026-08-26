# Contributing to gmeetminder

Thanks for your interest in improving gmeetminder! This document covers the
development workflow, conventions, and how to get changes merged.

## Getting set up

You'll need a GNOME Shell 50 session and the GJS toolchain:

```sh
# Fedora
sudo dnf install gjs glib2-devel gnome-extensions-app

# Debian / Ubuntu
sudo apt install gjs libglib2.0-bin gnome-shell-extension-prefs
```

Clone the repo and run the tests:

```sh
git clone https://github.com/afreiberger/gmeetminder.git
cd gmeetminder
make test
```

To try your changes live:

```sh
make install
# log out/in on Wayland, then:
gnome-extensions enable gmeetminder@afreiberger.github.io
make logs        # watch the shell journal for this extension
```

## Project layout

```
gmeetminder@afreiberger.github.io/   the extension itself
  extension.js       lifecycle + wiring
  prefs.js           libadwaita preferences window
  lib/               focused modules (see docs/DESIGN.md)
  schemas/           GSettings schema
tests/               pure-logic unit tests (run under plain gjs)
docs/DESIGN.md       architecture + design rationale
```

Read [`docs/DESIGN.md`](docs/DESIGN.md) before making structural changes — it
explains the module boundaries and the `MeetingEvent` contract every module
speaks.

## Coding conventions

- **ES modules (GJS/ESM)** targeting GNOME Shell 50.
- Keep **pure logic free of `gi://` imports** so it stays unit-testable
  (`meetLink.js`, `scheduler.js`, and the pure halves of `launcher.js`).
- Match the surrounding style: JSDoc module headers, descriptive names, thin
  coordination in `extension.js`.
- Every source file carries an SPDX header:
  ```js
  // SPDX-FileCopyrightText: 2026 Your Name
  // SPDX-License-Identifier: GPL-2.0-or-later
  ```

## Tests

- Add or update unit tests in `tests/` for any logic change.
- Register new suites by importing them in `tests/runner.js`.
- `make test` must pass before you open a pull request.
- For calendar/EDS changes, verify against real data with
  `gjs -m tests/eds_probe.js` (output is redacted and safe to share).

## Submitting changes

1. Fork and create a topic branch (`git checkout -b my-change`).
2. Keep commits focused and write clear commit messages.
3. Ensure `make test` passes and the schema still compiles (`make schemas`).
4. Open a pull request describing the change and how you tested it.

## License

By contributing, you agree that your contributions are licensed under the
[GNU General Public License v2.0 or later](LICENSE).
