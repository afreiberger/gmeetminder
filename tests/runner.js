#!/usr/bin/env -S gjs -m
// SPDX-FileCopyrightText: 2026 Drew Freiberger
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Test entrypoint. Add new *.test.js imports here.
 * Run: gjs -m tests/runner.js   (or `make test`)
 */

import { run } from './harness.js';

// Test suites register themselves on import via describe().
import './meetLink.test.js';
import './scheduler.test.js';
import './launcher.test.js';
import './calendarSource.reconnect.test.js';

const ok = run();
imports.system.exit(ok ? 0 : 1);
