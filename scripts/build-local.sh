#!/usr/bin/env bash
# Dev-local build with native CPU flags — fastest on THIS machine only.
#
# DO NOT use this for published prebuilts: a binary built with
# `-C target-cpu=native` on one CPU can SIGILL on another. Published
# prebuilts (CI) are built with portable flags; rusty_mp3 already
# runtime-dispatches AVX2/NEON on machines that have it.
# See docs/research-rusty_mp3.md and Cargo.toml [profile.release].
set -euo pipefail
cd "$(dirname "$0")/.."
export RUSTFLAGS="-C target-cpu=native"
npx napi build --platform --release --js binding.js --dts lib/binding.d.ts
echo "Built (native CPU): bun-rusty-mp3.$(node -e "console.log(require('./lib/loader.js').candidateTriples()[0])").node"
