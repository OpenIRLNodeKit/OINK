// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

// Filesystem usage for the dashboard. Pure/requireable so log-server can expose
// it and node:test can exercise the df-style math without HTTP.

const fs = require('fs');

// Bytes writable by the runtime user (bavail excludes root-reserved blocks).
function freeBytes(dir) {
  const s = fs.statfsSync(dir);
  return s.bavail * s.bsize;
}

// One row per filesystem: the default install keeps assets, recordings, and the
// stack on the same device, so callers pass each purpose and this merges them.
function usage(targets) {
  const byDev = new Map();
  for (const { label, dir } of targets) {
    let st;
    let s;
    try {
      st = fs.statSync(dir);
      s = fs.statfsSync(dir);
    } catch {
      continue; // Not installed yet: omit rather than fail the whole card.
    }
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    const used = (s.blocks - s.bfree) * s.bsize;
    const denom = used + free;
    const percent = denom > 0 ? Math.round((used / denom) * 100) : 0;
    const row = byDev.get(st.dev);
    if (row) {
      if (!row.labels.includes(label)) row.labels.push(label);
      if (!row.paths.includes(dir)) row.paths.push(dir);
    } else {
      byDev.set(st.dev, { labels: [label], paths: [dir], total, used, free, percent });
    }
  }
  return [...byDev.values()].map(({ labels, ...row }) => ({
    label: labels.join(' · '),
    ...row,
  }));
}

module.exports = { freeBytes, usage };
