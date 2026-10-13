// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * vcam-state.js — remembers whether the OBS virtual camera was on, so a restart
 * of oink-obs can restore it (the unit's ExecStop stops the cam before teardown;
 * its ExecStartPost re-starts it when this flag is set). A dedicated file rather
 * than dashboard.json so the preview lifecycle can't race UI settings writes.
 */

const fs = require('fs');
const path = require('path');

const FLAG = '.vcam-wanted';

function flagPath(stackDir) {
  return path.join(stackDir, FLAG);
}

function isWanted(stackDir) {
  return fs.existsSync(flagPath(stackDir));
}

function setWanted(stackDir, wanted) {
  const file = flagPath(stackDir);
  if (wanted) {
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(file, '');
  } else {
    try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

module.exports = { flagPath, isWanted, setWanted };
