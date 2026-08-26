/**
 * Notification path: tell the user a meeting is starting (or already running)
 * and offer a one-click "Join" action.
 *
 * Uses the GNOME 46+/50 MessageTray API (object-param constructors,
 * notification.addAction, source.addNotification). A single MessageTray.Source
 * is reused across notifications and lazily recreated if the shell destroys it.
 */

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

/** @typedef {import('./types.js').MeetingEvent} MeetingEvent */

const SOURCE_TITLE = 'gmeetminder';
const SOURCE_ICON = 'x-office-calendar-symbolic';

/** @type {MessageTray.Source|null} */
let _source = null;

/**
 * Get (or lazily create) the shared notification source and register it with
 * the message tray. Recreated automatically if a previous source was destroyed.
 * @returns {MessageTray.Source}
 */
function _getSource() {
    if (_source)
        return _source;

    _source = new MessageTray.Source({
        title: SOURCE_TITLE,
        iconName: SOURCE_ICON,
    });
    _source.connect('destroy', () => {
        _source = null;
    });
    Main.messageTray.add(_source);
    return _source;
}

/** Human-readable meeting title with a graceful fallback. */
function _titleOf(event) {
    return event && event.title && event.title.length
        ? event.title
        : _('Untitled meeting');
}

/** Local "HH:MM" for a Unix-ms timestamp, or '' if unavailable. */
function _timeOf(event) {
    if (!event || typeof event.start !== 'number')
        return '';
    const dt = GLib.DateTime.new_from_unix_local(Math.floor(event.start / 1000));
    return dt ? dt.format('%H:%M') : '';
}

/**
 * Build, show, and wire a Join notification.
 * @param {string} title notification title
 * @param {string} body notification body
 * @param {{onJoin:()=>void}} handlers
 */
function _notify(title, body, handlers) {
    const source = _getSource();
    const notification = new MessageTray.Notification({
        source,
        title,
        body,
        iconName: SOURCE_ICON,
        // Resident/critical so the user can still act on it after it slides
        // away — a meeting-join prompt shouldn't silently vanish.
        urgency: MessageTray.Urgency.CRITICAL,
    });
    notification.addAction(_('Join'), () => {
        handlers?.onJoin?.();
    });
    source.addNotification(notification);
    return notification;
}

/**
 * Show a notification that a meeting is starting, with a Join button.
 * @param {MeetingEvent} event
 * @param {{onJoin:()=>void}} handlers
 */
export function notifyJoin(event, handlers) {
    const time = _timeOf(event);
    const body = time
        ? `${_titleOf(event)} · ${time}`
        : _titleOf(event);
    return _notify(_('Meeting starting'), body, handlers);
}

/**
 * Show a notification that a meeting is already in progress, with a Join button.
 * @param {MeetingEvent} event
 * @param {{onJoin:()=>void}} handlers
 */
export function notifyInProgress(event, handlers) {
    const time = _timeOf(event);
    const body = time
        ? `${_titleOf(event)} · ${_('started at')} ${time}`
        : _titleOf(event);
    return _notify(_('Meeting in progress'), body, handlers);
}
