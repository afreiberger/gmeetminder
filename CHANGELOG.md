# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- EDS calendar sources that fail to connect at GNOME Shell startup (e.g.
  due to early-startup timeout or cancellation) are now retried automatically
  on each safety repoll cycle instead of being silently dropped for the session.
- Race condition: if `disable()` is called while `CalendarSource.init()` is
  still in flight, the extension no longer crashes with "can't access property
  connectChanged, this._source is null".

### Added
- Top-bar countdown to the next meeting.
- Dropdown agenda of today's events with click-to-join.
- Auto-open Chrome to the meeting URL before start, or notify with a Join button.
- "Join next meeting" global shortcut (default <kbd>Super</kbd>+<kbd>Shift</kbd>+<kbd>J</kbd>).
- Create instant meeting (`meet.new`) and pinned bookmarks.
- Zoom / Teams link detection in addition to Google Meet.
- Calendar reading via GNOME Online Accounts / Evolution Data Server.
- libadwaita preferences window.

[Unreleased]: https://github.com/afreiberger/gmeetminder/commits/main
