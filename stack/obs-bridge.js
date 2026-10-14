'use strict';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// OBS-websocket control layer for the OINK control-plane.
//
// Owns everything that talks to the loopback obs-websocket: the connection
// bridge (ObsBridge), the scene/media-source/browser-source provisioners, scene
// switching, stream-settings, primary-platform, stream-service, and Aitum
// Multistream key handling. No HTTP routing here — the routes in log-server.js
// call into this module.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocket } = require('ws');
const { InputError, BusyError } = require('./errors');

const STACK_DIR = process.env.OINK_STACK_DIR || __dirname;
const OBS_LOG_DIR = process.env.OBS_LOG_DIR || '/obs-logs';
const OBS_WS_HOST = process.env.OBS_WS_HOST || '127.0.0.1';
const OBS_WS_PORT = 4455;

const CANVAS_W = 1920;
const CANVAS_H = 1080;
// Single source of truth: canvas identity/dimensions live in the same
// components.json manifest the Python setup reads, so the two runtimes can
// never drift. Falls back to the committed values if the manifest key is absent.
const VERTICAL_CANVAS = (() => {
  const defaultsPath = path.join(STACK_DIR, 'components.json');
  try {
    const raw = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
    return raw.vertical_canvas || {};
  } catch {
    return {};
  }
})();
const AITUM_VERTICAL_CANVAS_UUID = VERTICAL_CANVAS.uuid || '0f5d712a-f8aa-44e0-acaa-1da0f9a7a645';
const AITUM_VERTICAL_W = VERTICAL_CANVAS.width || 1080;
const AITUM_VERTICAL_H = VERTICAL_CANVAS.height || 1920;

// Fit a source into the vertical canvas at its natural aspect ratio, centered.
// Unknown/zero source dimensions (feed offline at provision time) assume a 16:9
// source; OBS re-fits bounds each frame once video starts.
function centeredBoundsTransform(srcW, srcH, maxW, maxH) {
  let w = Number(srcW);
  let h = Number(srcH);
  if (!w || !h) {
    w = 16;
    h = 9;
  }
  const scale = Math.min(maxW / w, maxH / h);
  const boundsWidth = w * scale;
  const boundsHeight = h * scale;
  return {
    positionX: (maxW - boundsWidth) / 2,
    positionY: (maxH - boundsHeight) / 2,
    boundsWidth,
    boundsHeight,
  };
}
// Host capability flags written by `oink setup`; read for NVENC detection.
const HOST_INFO_FILE = path.join(STACK_DIR, 'host-info.json');

// OBS "simple output mode" encoder ids. x264 is the software fallback available
// everywhere; NVENC only exists on NVIDIA hardware.
const ENCODERS = {
  x264: 'obs_x264',
  nvenc: 'jim_nvenc',
};

const OBS_PLUGIN_CONFIG_DIR = path.join(path.dirname(OBS_LOG_DIR), 'plugin_config');
const MULTISTREAM_CONFIG_PATH = path.join(OBS_PLUGIN_CONFIG_DIR, 'aitum-multistream', 'config.json');

// ── Aitum Multistream key helpers ─────────────────────────────────────────────

// Canonical ingest servers for the three platforms the Settings UI manages. The
// primary platform uses OBS's built-in stream output; the other two use the
// Aitum Multistream plugin. `service` names are informational only (primary
// output always uses rtmp_custom now); `server` is the ingest URL used.
const PLATFORMS = {
  twitch: { name: 'Twitch', service: 'Twitch', server: 'rtmp://live.twitch.tv/app' },
  kick: { name: 'Kick', service: 'Custom', server: 'rtmp://fa723fc1b171.global-contribute.live-video.net/app' },
  youtube: { name: 'YouTube', service: 'YouTube / YouTube Gaming', server: 'rtmp://a.rtmp.youtube.com/live2' },
};

const DEFAULT_PRIMARY_PLATFORM = 'twitch';

const MULTISTREAM_PLATFORMS = {
  twitch: { name: 'Twitch', server: 'rtmp://live.twitch.tv/app' },
  kick: { name: 'Kick', server: 'rtmp://fa723fc1b171.global-contribute.live-video.net/app' },
  youtube: { name: 'YouTube', server: 'rtmp://a.rtmp.youtube.com/live2' },
};

const MULTISTREAM_MATCHERS = [
  { platform: 'kick', re: /fa723fc1b171\.global-contribute\.live-video\.net/i },
  { platform: 'twitch', re: /\.twitch\.tv|\.contribute\.live-video\.net/i },
  { platform: 'youtube', re: /(^|[.])youtube\.com|youtu\.be/i },
];

function multistreamPlatformOf(output) {
  if (!output || typeof output !== 'object') return null;
  const url = String(output.stream_server || '');
  for (const { platform, re } of MULTISTREAM_MATCHERS) {
    if (re.test(url)) return platform;
  }
  const name = String(output.name || '').toLowerCase();
  if (name === 'twitch') return 'twitch';
  if (name === 'kick') return 'kick';
  if (name === 'youtube' || name === 'youtube main') return 'youtube';
  return null;
}

function readMultistreamConfig() {
  if (!fs.existsSync(MULTISTREAM_CONFIG_PATH)) return { profiles: [] };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(MULTISTREAM_CONFIG_PATH, 'utf8'));
  } catch {
    throw new InputError(
      'Aitum Multistream config.json exists but is not valid JSON — fix it in OBS before saving keys',
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new InputError('Aitum Multistream config.json is empty or invalid');
  }
  if (!Array.isArray(parsed.profiles)) parsed.profiles = [];
  return parsed;
}

// For each platform: configured=true + last-4 once ANY profile has a key. Raw
// keys never leave the server.
function multistreamKeyState(config) {
  const state = {};
  for (const platform of Object.keys(MULTISTREAM_PLATFORMS)) {
    let configured = false;
    let last4 = null;
    for (const profile of config.profiles || []) {
      if (!profile || typeof profile !== 'object') continue;
      for (const out of profile.outputs || []) {
        if (multistreamPlatformOf(out) !== platform) continue;
        const key = String(out.stream_key || '');
        if (!key) continue;
        configured = true;
        last4 = key.slice(-4);
        break;
      }
      if (configured) break;
    }
    state[platform] = { configured, last4 };
  }
  return state;
}

// Current OBS profile name. Tries the app-wide global.ini first, then falls
// back to the only profile directory present, then OBS's out-of-the-box name.
function currentObsProfileName() {
  const configDir = path.dirname(OBS_LOG_DIR);
  try {
    const text = fs.readFileSync(path.join(configDir, 'global.ini'), 'utf8');
    let section = '';
    for (const line of text.split(/\r?\n/)) {
      const s = /^\[(.+)\]$/.exec(line.trim());
      if (s) {
        section = s[1].trim();
        continue;
      }
      if (section === 'General' && /^Profile=/i.test(line.trim())) {
        const value = line.trim().slice('Profile='.length).trim();
        if (value) return value;
      }
    }
  } catch {
    // global.ini missing/unreadable → try the profiles directory below.
  }
  try {
    const profilesDir = path.join(configDir, 'basic', 'profiles');
    const dirs = fs
      .readdirSync(profilesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    if (dirs.length === 1) return dirs[0];
  } catch {
    // no readable profiles dir → default below.
  }
  return 'oink';
}

// Write stream keys for the given platforms into EVERY profile in the plugin
// config (keys are platform credentials, not per-profile).
function applyMultistreamKeys(config, keys) {
  if (config.profiles.length === 0) {
    config.profiles.push({ name: currentObsProfileName() });
  }
  for (const platform of Object.keys(keys)) {
    const { name, server } = MULTISTREAM_PLATFORMS[platform];
    if (!name) continue;
    for (const profile of config.profiles) {
      if (!profile || typeof profile !== 'object') continue;
      if (!Array.isArray(profile.outputs)) profile.outputs = [];
      let target = null;
      for (const out of profile.outputs) {
        if (multistreamPlatformOf(out) === platform) {
          target = out;
          break;
        }
      }
      if (target) {
        target.stream_key = keys[platform];
        if (!target.stream_server) target.stream_server = server;
      } else {
        profile.outputs.push({
          name,
          stream_server: server,
          stream_key: keys[platform],
        });
      }
    }
  }
  return config;
}

// Remove a platform's output from the multistream config (when it becomes the
// primary platform it uses OBS native output instead).
function removePlatformFromMultistream(config, platform) {
  for (const profile of config.profiles || []) {
    if (!profile || typeof profile !== 'object') continue;
    if (!Array.isArray(profile.outputs)) continue;
    profile.outputs = profile.outputs.filter((out) => {
      return multistreamPlatformOf(out) !== platform;
    });
  }
  return config;
}

function writeMultistreamConfig(config) {
  fs.mkdirSync(path.dirname(MULTISTREAM_CONFIG_PATH), { recursive: true });
  const tmp = MULTISTREAM_CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, MULTISTREAM_CONFIG_PATH);
}

// ── OBS websocket bridge (obs-websocket v5) ───────────────────────────────────

function sha256Base64(value) {
  return crypto.createHash('sha256').update(value).digest('base64');
}

function buildIdentify(password, hello) {
  const d = hello.d || {};
  const auth = d.authentication || {};
  const identify = { rpcVersion: 1 };
  if (auth.challenge && auth.salt) {
    // obs-websocket: Base64(SHA256(password + salt)), then + challenge
    const secret = sha256Base64(password + auth.salt);
    identify.authentication = sha256Base64(secret + auth.challenge);
  }
  return identify;
}

function getObsPassword() {
  const configFile = path.join(STACK_DIR, 'noalbs', 'config.json');
  if (fs.existsSync(configFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      if (parsed.software && parsed.software.password) return parsed.software.password;
    } catch (e) {
      console.log('[obs-ws] failed to read noalbs config for password:', e.message);
    }
  }
  if (process.env.OBS_WS_PASSWORD) return process.env.OBS_WS_PASSWORD;
  throw new Error('OBS websocket password unavailable (software.password missing in noalbs config)');
}

// Serialize high-level calls (e.g. concurrent media-source provisions)
let obsQueue = Promise.resolve();
function obsEnqueue(fn) {
  const run = obsQueue.then(fn);
  obsQueue = run.catch(() => {});
  return run;
}

let _obsBridge = null;

class ObsBridge {
  constructor() {
    this.ws = null;
    this.identified = false;
    this.seq = 0;
    this.pending = new Map();
    this.password = null;
    this._onIdentified = null;
  }

  connect(password) {
    this.password = password;
    return new Promise((resolve, reject) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN && this.identified) {
        return resolve(this);
      }
      const ws = new WebSocket(`ws://${OBS_WS_HOST}:${OBS_WS_PORT}`, ['obswebsocket.json']);
      const timeout = setTimeout(() => {
        try { ws.terminate(); } catch {}
        reject(new Error('OBS websocket connect/identify timeout'));
      }, 10000);
      this._onIdentified = () => {
        clearTimeout(timeout);
        this.identified = true;
        this.ws = ws;
        resolve(this);
      };
      this.ws = ws;
      ws.on('open', () => {});
      ws.on('message', (data) => this._handle(data));
      ws.on('error', (err) => {
        clearTimeout(timeout);
        if (!this.identified) reject(err);
      });
      ws.on('close', () => {
        clearTimeout(timeout);
        this.identified = false;
        this.ws = null;
        const err = new Error('OBS websocket connection closed');
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
      });
    });
  }

  _handle(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const op = msg.op;
    const d = msg.d || {};
    if (op === 0) { // Hello
      this.ws.send(JSON.stringify({ op: 1, d: buildIdentify(this.password, msg) }));
      return;
    }
    if (op === 2) { // Identified
      if (this._onIdentified) { this._onIdentified(); this._onIdentified = null; }
      return;
    }
    if (op === 7) { // RequestResponse
      const p = this.pending.get(d.requestId);
      if (!p) return;
      this.pending.delete(d.requestId);
      const status = d.requestStatus || {};
      if (status.code === 100 || status.code === 104) p.resolve(d.responseData || {});
      else p.reject(new Error(`${d.requestType}: ${status.comment || JSON.stringify(status)}`));
    }
  }

  request(requestType, requestData = {}) {
    const id = 'req' + (++this.seq);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('OBS websocket not connected'));
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId: id, requestData } }));
    });
  }
}

async function ensureObs() {
  const password = getObsPassword();
  if (!_obsBridge || !_obsBridge.ws || _obsBridge.ws.readyState !== WebSocket.OPEN || !_obsBridge.identified) {
    _obsBridge = new ObsBridge();
    await _obsBridge.connect(password);
  }
  return _obsBridge;
}

// True when OBS reports an input kind (probe for plugin-load detection).
async function _obsHasInputKind(kind) {
  const bridge = await ensureObs();
  const resp = await bridge.request('GetInputKindList');
  const kinds = resp && Array.isArray(resp.inputKinds) ? resp.inputKinds : [];
  return kinds.includes(kind);
}

// OBS Studio + obs-websocket versions (for the dashboard's version report).
function getObsVersion() {
  return obsEnqueue(async () => {
    const bridge = await ensureObs();
    const resp = await bridge.request('GetVersion');
    return {
      obsVersion: resp.obsVersion || null,
      obsWebSocketVersion: resp.obsWebSocketVersion || null,
    };
  });
}

async function listScenes() {
  const bridge = await ensureObs();
  const resp = await obsEnqueue(() => bridge.request('GetSceneList'));
  return {
    currentProgramScene: resp.currentProgramSceneName,
    scenes: (resp.scenes || []).map((s) => s.sceneName),
  };
}

async function getCurrentScene() {
  const bridge = await ensureObs();
  const resp = await obsEnqueue(() => bridge.request('GetCurrentProgramScene'));
  return resp.currentProgramSceneName || null;
}

// Ensure each of the given scenes exists, then upsert an input and stretch a
// scene item for it onto the full canvas in EVERY target scene.
async function _ensureInputInScenes(name, inputKind, inputSettings, targetScenes) {
  const bridge = await ensureObs();
  const req = (type, data) => bridge.request(type, data);

  const scenesResp = await req('GetSceneList');
  const existingScenes = (scenesResp.scenes || []).map((s) => s.sceneName);
  for (const sceneName of targetScenes) {
    if (!existingScenes.includes(sceneName)) {
      await req('CreateScene', { sceneName });
      existingScenes.push(sceneName);
    }
  }

  const listResp = await req('GetInputList');
  const existing = (listResp.inputs || []).find((i) => i.inputName === name);
  let inputUuid = existing ? (existing.inputUuid || null) : null;
  if (existing) {
    await req('SetInputSettings', { inputName: name, inputSettings });
  } else {
    const created = await req('CreateInput', {
      sceneName: targetScenes[0],
      inputName: name,
      inputKind,
      inputSettings,
      sceneItemEnabled: true,
    });
    inputUuid = created.inputUuid || null;
  }

  const results = [];
  for (const sceneName of targetScenes) {
    let items = (await req('GetSceneItemList', { sceneName })).sceneItems || [];
    let item = items.find((i) => i.sourceName === name);
    if (!item) {
      await req('CreateSceneItem', { sceneName, sourceName: name, sceneItemEnabled: true });
      items = (await req('GetSceneItemList', { sceneName })).sceneItems || [];
      item = items.find((i) => i.sourceName === name);
    }
    let sceneItemId = null;
    if (item) {
      sceneItemId = item.sceneItemId;
      await req('SetSceneItemTransform', {
        sceneName,
        sceneItemId,
        sceneItemTransform: {
          positionX: 0,
          positionY: 0,
          boundsType: 'OBS_BOUNDS_STRETCH',
          boundsWidth: CANVAS_W,
          boundsHeight: CANVAS_H,
        },
      });
    }
    results.push({ scene: sceneName, sceneItemId });
  }

  // Mirror the ingest into the Aitum Vertical canvas's matching scene (9:16).
  if (targetScenes.includes('main')) {
    try {
      await _ensureVerticalInput(req, name, inputUuid);
    } catch (e) {
      console.warn(`vertical source sync skipped for "${name}": ${e?.message || e}`);
    }
  }

  return { source: name, inputUuid, scenes: results };
}

// Add the source to the vertical canvas's "main" scene, fit-and-centered: the
// source keeps its native aspect ratio (no squish), letterboxed inside the
// 9:16 (1080x1920) canvas and centered.
async function _ensureVerticalInput(req, name, inputUuid) {
  if (!inputUuid) {
    return;
  }
  let scenes = (await req('GetSceneList', { canvasUuid: AITUM_VERTICAL_CANVAS_UUID })).scenes || [];
  if (!scenes.some((s) => s.sceneName === 'main')) {
    return;
  }

  let items = (await req('GetSceneItemList', {
    sceneName: 'main',
    canvasUuid: AITUM_VERTICAL_CANVAS_UUID,
  })).sceneItems || [];
  let item = items.find((i) => i.sourceName === name);
  if (!item) {
    await req('CreateSceneItem', {
      sceneName: 'main',
      canvasUuid: AITUM_VERTICAL_CANVAS_UUID,
      sourceUuid: inputUuid,
      sceneItemEnabled: true,
    });
    items = (await req('GetSceneItemList', {
      sceneName: 'main',
      canvasUuid: AITUM_VERTICAL_CANVAS_UUID,
    })).sceneItems || [];
    item = items.find((i) => i.sourceName === name);
  }
  if (item) {
    const itemSceneName = 'main';
    const transform = (await req('GetSceneItemTransform', {
      sceneName: itemSceneName,
      canvasUuid: AITUM_VERTICAL_CANVAS_UUID,
      sceneItemId: item.sceneItemId,
    })).sceneItemTransform || {};
    const bounds = centeredBoundsTransform(
      transform.sourceWidth, transform.sourceHeight,
      AITUM_VERTICAL_W, AITUM_VERTICAL_H,
    );
    await req('SetSceneItemTransform', {
      sceneName: itemSceneName,
      canvasUuid: AITUM_VERTICAL_CANVAS_UUID,
      sceneItemId: item.sceneItemId,
      sceneItemTransform: {
        positionX: bounds.positionX,
        positionY: bounds.positionY,
        boundsType: 'OBS_BOUNDS_SCALE_INNER',
        boundsWidth: bounds.boundsWidth,
        boundsHeight: bounds.boundsHeight,
      },
    });
  }
}

// Provision the ingest read source as an `irl_source` input (the
// obs-irl-source plugin). The plugin does PTS repair + jitter/drift/A-V-sync
// correction, which OBS's built-in Media Source cannot, so it is the ONLY read
// source OINK uses. Same SRT pull URL as before.
async function _provisionIrlSource(name, url) {
  const inputSettings = {
    url,
    reconnect_delay: 2,
    buffer_target_ms: 120,
    adaptive_speed: true,
    catchup_percent: 5,
    wait_for_keyframe: true,
    low_latency_audio: true, // OBS "Use OBS Low-Latency Async Audio Mode"
    clear_on_disconnect: true,
    close_when_inactive: false,
    hw_decode: 0,
  };
  const result = await _ensureInputInScenes(name, 'irl_source', inputSettings, ['main']);
  await (await ensureObs()).request('SetCurrentProgramScene', { sceneName: 'main' });
  return { scene: 'main', source: name, sceneItemId: result.scenes[0].sceneItemId, inputUuid: result.inputUuid };
}

function provisionMediaSource(name, url) {
  return obsEnqueue(() => _provisionIrlSource(name, url));
}

async function _provisionBrowserSource(name, url, targetScenes, opts = {}) {
  const inputSettings = {
    url,
    width: CANVAS_W,
    height: CANVAS_H,
    fps: 30,
    is_local_file: false,
    ...(opts.rerouteAudio ? { reroute_audio: true } : {}),
  };
  return _ensureInputInScenes(name, 'browser_source', inputSettings, targetScenes);
}

function provisionBrowserSource(name, url, targetScenes, opts) {
  return obsEnqueue(() => _provisionBrowserSource(name, url, targetScenes, opts));
}

async function _deleteMediaSource(name) {
  const bridge = await ensureObs();
  const req = (type, data) => bridge.request(type, data);

  const itemsResp = await req('GetSceneItemList', { sceneName: 'main' });
  const item = (itemsResp.sceneItems || []).find((i) => i.sourceName === name);
  if (item) {
    await req('RemoveSceneItem', { sceneName: 'main', sceneItemId: item.sceneItemId });
  }

  const listResp = await req('GetInputList');
  const existing = (listResp.inputs || []).find((i) => i.inputName === name);
  if (existing) {
    await req('RemoveInput', { inputName: name });
  }

  return { ok: true };
}

function deleteMediaSource(name) {
  return obsEnqueue(() => _deleteMediaSource(name));
}

async function _deleteBrowserSource(name) {
  const bridge = await ensureObs();
  const req = (type, data) => bridge.request(type, data);

  const scenesResp = await req('GetSceneList');
  const allScenes = (scenesResp.scenes || []).map((s) => s.sceneName);
  for (const sceneName of allScenes) {
    let itemsResp;
    try {
      itemsResp = await req('GetSceneItemList', { sceneName });
    } catch {
      continue;
    }
    const item = (itemsResp.sceneItems || []).find((i) => i.sourceName === name);
    if (item) {
      await req('RemoveSceneItem', { sceneName, sceneItemId: item.sceneItemId });
    }
  }

  const listResp = await req('GetInputList');
  const existing = (listResp.inputs || []).find((i) => i.inputName === name);
  if (existing) {
    await req('RemoveInput', { inputName: name });
  }

  return { ok: true };
}

function deleteBrowserSource(name) {
  return obsEnqueue(() => _deleteBrowserSource(name));
}

// ── Per-ingest mute / visibility (dashboard controls) ─────────────────────────
// Each ingest feed is an OBS input named after its label, with a scene item in
// the main scene (and, when the Aitum vertical canvas has one, a copy there).
// "Visibility" toggles the scene item — output only; the input keeps pulling so
// the bitrate graph never drops. Mute is input-level (both canvases).

// Pure: join OBS data into the per-feed control state the dashboard needs.
// Feeds with no matching OBS input are omitted (controls stay disabled).
// `restartable` marks inputs that answer GetMediaInputStatus (media sources),
// i.e. the ones TriggerMediaInputAction can restart — the dashboard's Fix button.
function mapIngestControls({
  mainItems,
  verticalItems,
  inputNames,
  mutes = {},
  restartable = {},
  names,
}) {
  const main = new Map((mainItems || []).map((i) => [i.sourceName, i]));
  const vertical = new Map((verticalItems || []).map((i) => [i.sourceName, i]));
  const inputs = new Set(inputNames || []);
  const out = [];
  for (const name of names) {
    if (!inputs.has(name)) continue;
    const m = main.get(name);
    const v = vertical.get(name);
    out.push({
      name,
      muted: typeof mutes[name] === 'boolean' ? mutes[name] : null,
      visible: m ? m.sceneItemEnabled === true : null,
      vertical: v ? v.sceneItemEnabled === true : null,
      restartable: restartable[name] === true,
    });
  }
  return out;
}

// Input kinds that implement media controls (TriggerMediaInputAction). OINK's
// ingest reads use the obs-irl-source plugin (`irl_source`), which is probed
// once per kind via GetMediaInputStatus; the result is cached so the poll
// doesn't re-probe.
const MEDIA_INPUT_KINDS = new Set(['vlc_source', 'vlc-video']);
const _restartableByKind = new Map();

async function _isRestartableKind(req, kind, name) {
  if (MEDIA_INPUT_KINDS.has(kind)) return true;
  if (!_restartableByKind.has(kind)) {
    try {
      await req('GetMediaInputStatus', { inputName: name });
      _restartableByKind.set(kind, true);
    } catch {
      // Not a media input — TriggerMediaInputAction would fail on it.
      _restartableByKind.set(kind, false);
    }
  }
  return _restartableByKind.get(kind);
}

function getIngestControls(names) {
  const wanted = (Array.isArray(names) ? names : [])
    .filter((n) => typeof n === 'string' && n.trim())
    .map((n) => n.trim());
  if (wanted.length === 0) return Promise.resolve([]);
  return obsEnqueue(async () => {
    const bridge = await ensureObs();
    const req = (type, data) => bridge.request(type, data);

    const mainItems = (await req('GetSceneItemList', { sceneName: 'main' })).sceneItems || [];
    let verticalItems = [];
    try {
      const resp = await req('GetSceneItemList', {
        sceneName: 'main',
        canvasUuid: AITUM_VERTICAL_CANVAS_UUID,
      });
      verticalItems = resp.sceneItems || [];
    } catch {
      // No Aitum vertical canvas on this box — main-only.
    }

    const inputs = (await req('GetInputList')).inputs || [];
    const inputNames = inputs.map((i) => i.inputName);
    const kindByName = new Map(inputs.map((i) => [i.inputName, i.inputKind]));
    const mutes = {};
    const restartable = {};
    for (const name of wanted) {
      if (!inputNames.includes(name)) continue;
      try {
        mutes[name] = (await req('GetInputMute', { inputName: name })).inputMuted === true;
      } catch {
        mutes[name] = null;
      }
      restartable[name] = await _isRestartableKind(req, kindByName.get(name), name);
    }
    return mapIngestControls({
      mainItems, verticalItems, inputNames, mutes, restartable, names: wanted,
    });
  });
}

function setIngestMute(name, muted) {
  return obsEnqueue(async () => {
    const bridge = await ensureObs();
    await bridge.request('SetInputMute', { inputName: name, inputMuted: muted === true });
    return { name, muted: muted === true };
  });
}

// Restart the feed's media input: re-initializes the
// decoder/reconnect for that ingest without touching the MediaMTX path, the
// audio mute state, or the scene. Only media inputs support it; callers gate on
// the `restartable` flag from getIngestControls.
function restartIngestSource(name) {
  return obsEnqueue(async () => {
    const bridge = await ensureObs();
    try {
      await bridge.request('TriggerMediaInputAction', {
        inputName: name,
        mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
      });
    } catch {
      throw new InputError(`OBS source "${name}" does not support restart`);
    }
    return { name };
  });
}

async function _setSceneItemEnabled(req, sourceName, canvasUuid, visible) {
  const lookup = { sceneName: 'main', sourceName };
  const update = { sceneName: 'main', sceneItemId: null, sceneItemEnabled: visible === true };
  if (canvasUuid) {
    lookup.canvasUuid = canvasUuid;
    update.canvasUuid = canvasUuid;
  }
  update.sceneItemId = (await req('GetSceneItemId', lookup)).sceneItemId;
  await req('SetSceneItemEnabled', update);
}

function setIngestVisible(name, visible) {
  return obsEnqueue(async () => {
    const bridge = await ensureObs();
    const req = (type, data) => bridge.request(type, data);
    try {
      await _setSceneItemEnabled(req, name, null, visible);
    } catch {
      throw new InputError(`no OBS source named "${name}"`);
    }
    let vertical = null;
    try {
      await _setSceneItemEnabled(req, name, AITUM_VERTICAL_CANVAS_UUID, visible);
      vertical = visible === true;
    } catch {
      // No vertical copy for this source.
    }
    return { name, visible: visible === true, vertical };
  });
}

async function _switchScene(sceneName) {
  const bridge = await ensureObs();
  await bridge.request('SetCurrentProgramScene', { sceneName });
  return { sceneName };
}

function switchScene(sceneName) {
  return obsEnqueue(() => _switchScene(sceneName));
}

// ── Stream settings ───────────────────────────────────────────────────────────

function readHasNvenc() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HOST_INFO_FILE, 'utf-8'));
    return parsed.hasNvenc === true;
  } catch {
    return false;
  }
}

function normalizeEncoder(raw) {
  if (raw === 'obs_x264') return 'x264';
  if (raw === 'jim_nvenc' || raw === 'obs_nvenc' || raw === 'ffmpeg_nvenc') return 'nvenc';
  return raw || 'x264';
}

function encoderId(encoder) {
  return ENCODERS[encoder] || ENCODERS.x264;
}

async function _getProfileParam(req, category, name) {
  try {
    const resp = await req('GetProfileParameter', {
      parameterCategory: category,
      parameterName: name,
    });
    return resp.parameterValue;
  } catch {
    return null;
  }
}

async function _isAnyOutputActive(req) {
  for (const type of ['GetStreamStatus', 'GetRecordStatus', 'GetVirtualCamStatus']) {
    try {
      const resp = await req(type);
      if (resp.outputActive) return true;
    } catch {
      // ignore — output not available
    }
  }
  return false;
}

async function _getStreamSettings() {
  const bridge = await ensureObs();
  const req = (type, data) => bridge.request(type, data);

  const video = await req('GetVideoSettings');
  const encoder = await _getProfileParam(req, 'SimpleOutput', 'StreamEncoder');
  const bitrate = await _getProfileParam(req, 'SimpleOutput', 'VBitrate');

  return {
    encoder: normalizeEncoder(encoder),
    outputWidth: video.outputWidth,
    outputHeight: video.outputHeight,
    fpsNumerator: video.fpsNumerator,
    fpsDenominator: video.fpsDenominator,
    bitrate: parseInt(bitrate || '0', 10) || 0,
    hasNvenc: readHasNvenc(),
    streamActive: await _isAnyOutputActive(req),
  };
}

function getStreamSettings() {
  return obsEnqueue(() => _getStreamSettings());
}

async function _setStreamSettings(settings) {
  const bridge = await ensureObs();
  const req = (type, data) => bridge.request(type, data);

  if (await _isAnyOutputActive(req)) {
    throw new BusyError('Stop the stream, recording, and virtual camera before changing stream settings');
  }

  await req('SetVideoSettings', {
    outputWidth: settings.outputWidth,
    outputHeight: settings.outputHeight,
    fpsNumerator: settings.fpsNumerator,
    fpsDenominator: settings.fpsDenominator,
  });

  const commonFps = String(Math.round(settings.fpsNumerator / settings.fpsDenominator));
  await req('SetProfileParameter', {
    parameterCategory: 'Video',
    parameterName: 'FPSType',
    parameterValue: '0',
  });
  await req('SetProfileParameter', {
    parameterCategory: 'Video',
    parameterName: 'FPSCommon',
    parameterValue: commonFps,
  });

  await req('SetProfileParameter', {
    parameterCategory: 'SimpleOutput',
    parameterName: 'StreamEncoder',
    parameterValue: encoderId(settings.encoder),
  });
  await req('SetProfileParameter', {
    parameterCategory: 'SimpleOutput',
    parameterName: 'VBitrate',
    parameterValue: String(settings.bitrate),
  });

  return _getStreamSettings();
}

function setStreamSettings(settings) {
  return obsEnqueue(() => _setStreamSettings(settings));
}

function validateStreamSettings(settings) {
  if (!settings || typeof settings !== 'object') {
    throw new InputError('request body must be a JSON object');
  }
  if (settings.encoder !== 'x264' && settings.encoder !== 'nvenc') {
    throw new InputError('encoder must be "x264" or "nvenc"');
  }
  for (const key of ['outputWidth', 'outputHeight', 'fpsNumerator', 'fpsDenominator', 'bitrate']) {
    const value = settings[key];
    if (!Number.isInteger(value) || value <= 0) {
      throw new InputError(`${key} must be a positive integer`);
    }
  }
}

// ── OBS stream control (start/stop/status) ───────────────────────────────────

async function _startStream(req) {
  const status = await req('GetStreamStatus');
  if (status.outputActive) throw new BusyError('Stream is already active');
  await req('StartStream');
  return { outputActive: true };
}

function startStream() {
  return obsEnqueue(async () => {
    const bridge = await ensureObs();
    const req = (type, data) => bridge.request(type, data);
    return _startStream(req);
  });
}

async function _stopStream(req) {
  const status = await req('GetStreamStatus');
  if (!status.outputActive) throw new BusyError('Stream is not active');
  await req('StopStream');
  return { outputActive: false };
}

function stopStream() {
  return obsEnqueue(async () => {
    const bridge = await ensureObs();
    const req = (type, data) => bridge.request(type, data);
    return _stopStream(req);
  });
}

async function _getStreamStatus(req) {
  const resp = await req('GetStreamStatus');
  return {
    outputActive: resp.outputActive,
    outputTimecode: resp.outputTimecode || '',
    outputDuration: resp.outputDuration || 0,
    outputBytes: resp.outputBytes || 0,
    outputSkippedFrames: resp.outputSkippedFrames || 0,
    outputTotalFrames: resp.outputTotalFrames || 0,
  };
}

function getStreamStatus() {
  return obsEnqueue(async () => {
    const bridge = await ensureObs();
    const req = (type, data) => bridge.request(type, data);
    return _getStreamStatus(req);
  });
}

// ── OBS recording control (start/stop/status) ────────────────────────────────

async function _startRecord(req) {
  const status = await req('GetRecordStatus');
  if (status.outputActive) throw new BusyError('Recording is already active');
  await req('StartRecord');
  return { outputActive: true };
}

function startRecording() {
  return obsEnqueue(async () => {
    const bridge = await ensureObs();
    const req = (type, data) => bridge.request(type, data);
    return _startRecord(req);
  });
}

async function _stopRecord(req) {
  const status = await req('GetRecordStatus');
  if (!status.outputActive) throw new BusyError('Recording is not active');
  await req('StopRecord');
  return { outputActive: false };
}

function stopRecording() {
  return obsEnqueue(async () => {
    const bridge = await ensureObs();
    const req = (type, data) => bridge.request(type, data);
    return _stopRecord(req);
  });
}

async function _getRecordStatus(req) {
  const resp = await req('GetRecordStatus');
  return {
    outputActive: resp.outputActive,
    outputTimecode: resp.outputTimecode || '',
    outputDuration: resp.outputDuration || 0,
    outputBytes: resp.outputBytes || 0,
    outputPaused: resp.outputPaused || false,
  };
}

function getRecordingStatus() {
  return obsEnqueue(async () => {
    const bridge = await ensureObs();
    const req = (type, data) => bridge.request(type, data);
    return _getRecordStatus(req);
  });
}

// ── OBS virtual camera control (start/stop/status) ───────────────────────────
// Idempotent: the dashboard auto-starts the camera on boot and the preview
// reads the resulting v4l2loopback device, so already-on/off is not an error.

async function _startVirtualCam(req) {
  const status = await req('GetVirtualCamStatus');
  if (status.outputActive) return { outputActive: true };
  await req('StartVirtualCam');
  return { outputActive: true };
}

function startVirtualCam() {
  return obsEnqueue(async () => {
    const bridge = await ensureObs();
    const req = (type, data) => bridge.request(type, data);
    return _startVirtualCam(req);
  });
}

async function _stopVirtualCam(req) {
  const status = await req('GetVirtualCamStatus');
  if (!status.outputActive) return { outputActive: false };
  await req('StopVirtualCam');
  return { outputActive: false };
}

function stopVirtualCam() {
  return obsEnqueue(async () => {
    const bridge = await ensureObs();
    const req = (type, data) => bridge.request(type, data);
    return _stopVirtualCam(req);
  });
}

// ── Primary platform & OBS stream service ─────────────────────────────────────

// Primary output always uses OBS's rtmp_custom service, so any RTMP ingest
// endpoint works as the destination. Known platforms resolve to their canonical
// server; "custom-rtmp" carries its own server URL supplied by the user.
const PRIMARY_PLATFORM_IDS = ['twitch', 'youtube', 'kick', 'custom-rtmp'];

async function _getPrimaryPlatform(req) {
  try {
    const result = await req('GetProfileParameter', {
      parameterCategory: 'Stream',
      parameterName: 'PrimaryPlatform',
    });
    const value = result.parameterValue;
    if (PRIMARY_PLATFORM_IDS.includes(value)) return value;
  } catch {
    // Parameter not set or OBS unreachable
  }
  return DEFAULT_PRIMARY_PLATFORM;
}

function getPrimaryPlatform() {
  return obsEnqueue(async () => {
    const bridge = await ensureObs();
    const req = (type, data) => bridge.request(type, data);
    return _getPrimaryPlatform(req);
  });
}

async function _setPrimaryPlatform(req, platform, server) {
  let config = PLATFORMS[platform];
  if (!config && platform === 'custom-rtmp') {
    const trimmedServer = (server || '').trim();
    if (!/^rtmps?:\/\//i.test(trimmedServer)) {
      throw new InputError('server must start with rtmp:// or rtmps:// for custom-rtmp');
    }
    config = { name: 'Custom RTMP', service: 'Custom', server: trimmedServer };
  }
  if (!config) throw new InputError(`Unknown platform: ${platform}`);

  let currentKey = '';
  try {
    const currentSettings = await req('GetStreamServiceSettings', {});
    currentKey = String(currentSettings.streamServiceSettings?.key || '');
  } catch {
    // No current settings, key will be empty
  }

  await req('SetProfileParameter', {
    parameterCategory: 'Stream',
    parameterName: 'PrimaryPlatform',
    parameterValue: platform,
  });

  // rtmp_custom for every platform: bypasses OBS's built-in service-name list
  // (e.g. "YouTube / YouTube Gaming" was renamed in OBS 28+), so a primary
  // switch never fails on an unknown service name. Ingest URLs are identical
  // to the rtmp_common equivalents.
  await req('SetStreamServiceSettings', {
    streamServiceType: 'rtmp_custom',
    streamServiceSettings: {
      server: config.server,
      key: currentKey,
      use_auth: false,
    },
  });

  // Remove the new primary platform from multistream so only the two non-primary
  // platforms carry keys there.
  try {
    const multistreamConfig = readMultistreamConfig();
    removePlatformFromMultistream(multistreamConfig, platform);
    writeMultistreamConfig(multistreamConfig);
  } catch {
    // Multistream config might not exist yet, that's okay
  }

  return { platform, service: config.service, server: config.server };
}

function setPrimaryPlatform(platform, server) {
  return obsEnqueue(async () => {
    const bridge = await ensureObs();
    const req = (type, data) => bridge.request(type, data);
    return _setPrimaryPlatform(req, platform, server);
  });
}

async function _getStreamService(req) {
  const platform = await _getPrimaryPlatform(req);
  const config = PLATFORMS[platform] || { name: 'Custom RTMP', service: 'Custom', server: '' };

  let serviceInfo;
  try {
    serviceInfo = await req('GetStreamServiceSettings', {});
  } catch {
    return {
      platform,
      service: config.service,
      server: config.server,
      key: '',
      keyLast4: null,
    };
  }

  const settings = serviceInfo.streamServiceSettings || {};
  const key = String(settings.key || '');
  const server = String(settings.server || config.server);
  const service = String(settings.service || config.service);

  return {
    platform,
    service,
    server,
    key: '', // Never return the raw key
    keyLast4: key.length >= 4 ? key.slice(-4) : (key || null),
  };
}

function getStreamService() {
  return obsEnqueue(async () => {
    const bridge = await ensureObs();
    const req = (type, data) => bridge.request(type, data);
    return _getStreamService(req);
  });
}

async function _setStreamServiceKey(req, key) {
  const platform = await _getPrimaryPlatform(req);
  const config = PLATFORMS[platform] || { name: 'Custom RTMP', service: 'Custom', server: '' };

  let currentSettings;
  try {
    currentSettings = await req('GetStreamServiceSettings', {});
  } catch {
    currentSettings = { streamServiceType: 'rtmp_custom', streamServiceSettings: {} };
  }

  const serviceType = currentSettings.streamServiceType || 'rtmp_custom';
  const currentServiceSettings = currentSettings.streamServiceSettings || {};

  const newServiceSettings = {
    ...currentServiceSettings,
    key: key,
  };

  if (serviceType === 'rtmp_common') {
    newServiceSettings.service = currentServiceSettings.service || config.service;
    delete newServiceSettings.server;
  }
  if (serviceType === 'rtmp_custom') {
    newServiceSettings.server = currentServiceSettings.server || config.server;
  }

  await req('SetStreamServiceSettings', {
    streamServiceType: serviceType,
    streamServiceSettings: newServiceSettings,
  });

  return {
    platform,
    service: newServiceSettings.service || config.service,
    server: newServiceSettings.server || config.server,
    key: '',
    keyLast4: key.length >= 4 ? key.slice(-4) : null,
  };
}

function setStreamServiceKey(key) {
  return obsEnqueue(async () => {
    const bridge = await ensureObs();
    const req = (type, data) => bridge.request(type, data);
    return _setStreamServiceKey(req, key);
  });
}

module.exports = {
  OBS_WS_HOST,
  OBS_WS_PORT,
  OBS_PLUGIN_CONFIG_DIR,
  MULTISTREAM_CONFIG_PATH,
  PLATFORMS,
  DEFAULT_PRIMARY_PLATFORM,
  MULTISTREAM_PLATFORMS,
  ensureObs,
  getObsPassword,
  obsEnqueue,
  _obsHasInputKind,
  _getPrimaryPlatform,
  getObsVersion,
  listScenes,
  getCurrentScene,
  provisionMediaSource,
  provisionBrowserSource,
  deleteMediaSource,
  deleteBrowserSource,
  mapIngestControls,
  getIngestControls,
  setIngestMute,
  setIngestVisible,
  restartIngestSource,
  switchScene,
  getStreamSettings,
  setStreamSettings,
  validateStreamSettings,
  getPrimaryPlatform,
  setPrimaryPlatform,
  getStreamService,
  setStreamServiceKey,
  readMultistreamConfig,
  multistreamKeyState,
  applyMultistreamKeys,
  removePlatformFromMultistream,
  writeMultistreamConfig,
  centeredBoundsTransform,
  startStream,
  stopStream,
  getStreamStatus,
  startRecording,
  stopRecording,
  getRecordingStatus,
  startVirtualCam,
  stopVirtualCam,
};
