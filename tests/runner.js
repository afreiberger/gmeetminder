#!/usr/bin/env -S gjs -m
/**
 * Test entrypoint. Add new *.test.js imports here.
 * Run: gjs -m tests/runner.js   (or `make test`)
 */

import { run } from './harness.js';

// Test suites register themselves on import via describe().
import './meetLink.test.js';
import './scheduler.test.js';
import './launcher.test.js';

const ok = run();
imports.system.exit(ok ? 0 : 1);
