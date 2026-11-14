'use strict';

// bun-rusty-mp3 — Bun/Node bindings to rusty_mp3 (pure-Rust MP3 codec).
//
// The native binding is loaded by lib/loader.js (which delegates to the
// napi-rs generated loader in lib/binding.js) and fails loudly with
// ERR_BUN_RUSTY_MP3_NO_PREBUILT when no prebuilt binary fits this machine.
// This package never builds from source on install (see README).
//
// NOTE: `napi build` generates its loader as lib/binding.js (see the
// `build` script in package.json) — it must NOT overwrite this file.

module.exports = require('./lib/wrapper.js');
