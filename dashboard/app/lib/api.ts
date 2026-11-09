// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { csrfHeaders } from './csrf';
import { INGEST_RESERVED_LABEL } from './ingest';
import type {
  ApiResponse,
  IngestInfo,
  NoalbsConfig,
  StreamStatus,
  RecordStatus,
} from './types';

// Raw fetch for endpoints whose response shape is not the {ok, content}
// envelope. Attaches the CSRF token on state-changing methods: log-server
// rejects unsafe /api/* calls without it (403 "Invalid CSRF token"), so use
// this — never a bare fetch() — for any new non-GET call.
async function apiFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const method = (init.method || 'GET').toUpperCase();
  const unsafe = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  return fetch(path, {
    ...init,
    headers: { ...(unsafe ? csrfHeaders() : {}), ...init.headers },
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const text = await res.text();
  let data: ApiResponse<T>;
  try {
    data = JSON.parse(text) as ApiResponse<T>;
  } catch {
    throw new Error(
      `Request to ${path} failed (HTTP ${res.status}, non-JSON response)`,
    );
  }
  if (!data.ok) {
    throw new Error(data.error || `Request to ${path} failed`);
  }
  return data.content as T;
}

export async function getNoalbsConfig(): Promise<NoalbsConfig> {
  const data = await request<unknown>('/api/config/noalbs');
  if (typeof data === 'string') return JSON.parse(data) as NoalbsConfig;
  return data as NoalbsConfig;
}

export async function saveNoalbsConfig(config: NoalbsConfig): Promise<void> {
  await request<never>('/api/config/noalbs', {
    method: 'PUT',
    body: JSON.stringify({ content: JSON.stringify(config, null, 2) }),
  });
}

// NOALBS chat bot credentials live in noalbs/.env (loaded by oink-noalbs.service).
// The oauth value comes back redacted; a save that leaves it untouched round-trips
// the placeholder and the server restores the real token from disk.
export async function getNoalbsEnv(): Promise<string> {
  const data = await request<unknown>('/api/config/noalbs_env');
  return typeof data === 'string' ? data : '';
}

export async function saveNoalbsEnv(content: string): Promise<void> {
  await request<never>('/api/config/noalbs_env', {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });
}

interface ServiceStatus {
  running: boolean;
}

export async function getServiceStatus(
  service: string,
): Promise<ServiceStatus> {
  const res = await fetch(`/api/service/${service}/status`);
  const data = (await res.json()) as { running?: boolean };
  return { running: Boolean(data.running) };
}

export async function serviceAction(
  service: string,
  action: 'start' | 'stop' | 'restart',
): Promise<void> {
  await request<never>(`/api/service/${service}/${action}`, {
    method: 'POST',
  });
}

interface IngestResponse {
  ok: boolean;
  error?: string;
  key?: string;
  defaultPath?: string;
  createdAt?: number;
  updatedAt?: number;
}

export async function getIngestInfo(): Promise<IngestInfo> {
  const res = await fetch('/api/ingest');
  const data = (await res.json()) as IngestResponse;
  if (!data.ok || !data.key || !data.defaultPath) {
    throw new Error(data.error || 'Failed to load ingest stream key');
  }
  return {
    key: data.key,
    defaultPath: data.defaultPath,
    createdAt: data.createdAt ?? 0,
    updatedAt: data.updatedAt ?? 0,
  };
}

export async function rotateIngestInfo(): Promise<IngestInfo> {
  const res = await apiFetch('/api/ingest/rotate', { method: 'POST' });
  const data = (await res.json()) as IngestResponse;
  if (!data.ok || !data.key || !data.defaultPath) {
    throw new Error(data.error || 'Failed to rotate ingest stream key');
  }
  return {
    key: data.key,
    defaultPath: data.defaultPath,
    createdAt: data.createdAt ?? 0,
    updatedAt: data.updatedAt ?? 0,
  };
}

export interface IngestProfiles {
  profiles: string[];
  main: string;
}

function parseIngestProfiles(data: {
  ok: boolean;
  profiles?: string[];
  main?: string;
  error?: string;
}): IngestProfiles {
  if (!data.ok) throw new Error(data.error || 'Failed to load ingest profiles');
  return {
    profiles: data.profiles ?? [],
    main: data.main ?? INGEST_RESERVED_LABEL,
  };
}

export async function getIngestProfiles(): Promise<IngestProfiles> {
  const res = await fetch('/api/ingest/profiles');
  const data = (await res.json()) as {
    ok: boolean;
    profiles?: string[];
    main?: string;
    error?: string;
  };
  return parseIngestProfiles(data);
}

export async function saveIngestProfiles(
  profiles: string[],
  main?: string,
): Promise<IngestProfiles> {
  const res = await fetch('/api/ingest/profiles', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ profiles, main }),
  });
  const data = (await res.json()) as {
    ok: boolean;
    profiles?: string[];
    main?: string;
    error?: string;
  };
  return parseIngestProfiles(data);
}

export interface IngestControlState {
  name: string;
  muted: boolean | null;
  visible: boolean | null;
  restartable: boolean;
}

export async function getIngestControls(
  names: string[],
): Promise<IngestControlState[]> {
  const query = names.length
    ? `?names=${encodeURIComponent(names.join(','))}`
    : '';
  const res = await fetch(`/api/obs/media-source/state${query}`);
  const data = (await res.json()) as {
    ok: boolean;
    sources?: IngestControlState[];
    error?: string;
  };
  if (!data.ok)
    throw new Error(data.error || 'Failed to load ingest source state');
  return data.sources ?? [];
}

async function postIngestControl(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };
  if (!data.ok) throw new Error(data.error || `Request to ${path} failed`);
}

export async function setIngestMute(
  name: string,
  muted: boolean,
): Promise<void> {
  await postIngestControl('/api/obs/media-source/mute', { name, muted });
}

export async function setIngestVisible(
  name: string,
  visible: boolean,
): Promise<void> {
  await postIngestControl('/api/obs/media-source/visibility', {
    name,
    visible,
  });
}

export async function restartIngest(name: string): Promise<void> {
  await postIngestControl('/api/obs/media-source/restart', { name });
}

export async function getServiceConfig(
  service: string,
): Promise<{ content: string; file: string }> {
  const res = await fetch(`/api/config/${service}`);
  const text = await res.text();
  let data: { ok?: boolean; error?: string; content?: string; file?: string };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Request to /api/config/${service} failed (HTTP ${res.status}, non-JSON response)`,
    );
  }
  if (!data.ok) {
    throw new Error(data.error || `Request to /api/config/${service} failed`);
  }
  return { content: data.content ?? '', file: data.file ?? '' };
}

export async function saveServiceConfig(
  service: string,
  content: string,
): Promise<void> {
  await request<never>(`/api/config/${service}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });
}

export async function provisionObsMediaSource(
  name: string,
  url: string,
): Promise<void> {
  await request<never>('/api/obs/media-source', {
    method: 'POST',
    body: JSON.stringify({ name, url }),
  });
}

export async function deleteObsMediaSource(name: string): Promise<void> {
  await request<never>(
    `/api/obs/media-source?name=${encodeURIComponent(name)}`,
    {
      method: 'DELETE',
    },
  );
}

// ── OBS drop-in plugin manager ──────────────────────────────────────────────

export interface DefaultPluginStatus {
  name: string;
  version: string;
  installed: boolean;
  loaded: boolean;
  dir: string;
  kind: 'tar' | 'deb';
  default: true;
}

interface IrlSourceStatus {
  name: string;
  version: string;
  installed: boolean;
  loaded: boolean;
  dir: string;
}

interface PluginInstallResult {
  ok: boolean;
  name: string;
  so: string;
  dir: string;
  restartRequired: boolean;
}

export async function getDefaultPluginStatus(): Promise<DefaultPluginStatus[]> {
  const res = await fetch('/api/obs/plugins/status');
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    plugins?: DefaultPluginStatus[];
  };
  if (!data.ok) {
    throw new Error(data.error || 'Failed to load plugin status');
  }
  return data.plugins ?? [];
}

export interface VersionPlugin {
  name: string;
  version: string;
  installed: boolean;
  loaded: boolean;
}

export interface VersionsInfo {
  oink: string;
  obs: string | null;
  obsWebSocket: string | null;
  mediamtx: string | null;
  noalbs: string | null;
  srtlaRec: string | null;
  plugins: VersionPlugin[];
  node: string;
  os: string;
  arch: string;
}

export async function getVersions(): Promise<VersionsInfo> {
  const res = await fetch('/api/versions');
  const data = (await res.json()) as { ok: boolean; error?: string } &
    Partial<VersionsInfo>;
  if (!data.ok) {
    throw new Error(data.error || 'Failed to load versions');
  }
  return {
    oink: data.oink ?? '',
    obs: data.obs ?? null,
    obsWebSocket: data.obsWebSocket ?? null,
    mediamtx: data.mediamtx ?? null,
    noalbs: data.noalbs ?? null,
    srtlaRec: data.srtlaRec ?? null,
    plugins: data.plugins ?? [],
    node: data.node ?? '',
    os: data.os ?? '',
    arch: data.arch ?? '',
  };
}

export async function getIrlSourceStatus(): Promise<IrlSourceStatus> {  const plugins = await getDefaultPluginStatus();
  const p = plugins.find((x) => x.name === 'obs-irl-source');
  return {
    name: p?.name ?? 'obs-irl-source',
    version: p?.version ?? '',
    installed: p?.installed ?? false,
    loaded: p?.loaded ?? false,
    dir: p?.dir ?? '',
  };
}

export async function installDefaultPlugin(
  name: string,
): Promise<PluginInstallResult> {
  const res = await apiFetch(
    `/api/obs/plugins/${encodeURIComponent(name)}/install`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
  );
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
  } & Partial<PluginInstallResult>;
  if (!data.ok) {
    throw new Error(data.error || `Failed to install ${name}`);
  }
  return data as PluginInstallResult;
}

export async function uploadObsPlugin(
  file: File,
): Promise<PluginInstallResult> {
  const res = await apiFetch('/api/obs/plugins', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Filename': file.name,
    },
    body: file,
  });
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
  } & Partial<PluginInstallResult>;
  if (!data.ok) {
    throw new Error(data.error || 'Plugin upload failed');
  }
  return data as PluginInstallResult;
}

export async function restartObs(): Promise<void> {
  await request<never>('/api/obs/restart', { method: 'POST', body: '{}' });
}

export type Platform = 'twitch' | 'youtube' | 'kick' | 'custom-rtmp';

interface ObsStreamService {
  platform: Platform;
  service: string;
  server: string;
  key: string;
  keyLast4: string | null;
}

export async function getObsStreamService(): Promise<ObsStreamService> {
  const res = await fetch('/api/obs/stream-service');
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
  } & ObsStreamService;
  if (!data.ok) {
    throw new Error(data.error || 'Failed to load OBS stream service');
  }
  return {
    platform: data.platform,
    service: data.service,
    server: data.server,
    key: data.key,
    keyLast4: data.keyLast4,
  };
}

export async function setObsStreamServiceKey(
  key: string,
): Promise<ObsStreamService> {
  const res = await apiFetch('/api/obs/stream-service', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    restartRequired?: boolean;
  } & ObsStreamService;
  if (!data.ok) {
    throw new Error(data.error || 'Failed to update OBS stream service');
  }
  return {
    platform: data.platform,
    service: data.service,
    server: data.server,
    key: data.key,
    keyLast4: data.keyLast4,
  };
}

export async function getPrimaryPlatform(): Promise<Platform> {
  const res = await fetch('/api/obs/primary-platform');
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    platform?: Platform;
  };
  if (!data.ok) {
    throw new Error(data.error || 'Failed to load primary platform');
  }
  return data.platform || 'twitch';
}

export async function setPrimaryPlatform(
  platform: Platform,
  server?: string,
): Promise<{ restartRequired: boolean }> {
  const res = await apiFetch('/api/obs/primary-platform', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, server }),
  });
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    restartRequired?: boolean;
  };
  if (!data.ok) {
    throw new Error(data.error || 'Failed to update primary platform');
  }
  return { restartRequired: data.restartRequired ?? true };
}

interface DashboardSettings {
  welcomeComplete: boolean;
  twitchChannel: string;
  presetProvided: boolean;
}

function parseSettings(
  data: { ok: boolean; error?: string } & Partial<DashboardSettings>,
  fallback: string,
): DashboardSettings {
  if (!data.ok) throw new Error(data.error || fallback);
  return {
    welcomeComplete: data.welcomeComplete === true,
    twitchChannel: data.twitchChannel || '',
    presetProvided: data.presetProvided === true,
  };
}

export async function getSettings(): Promise<DashboardSettings> {
  const res = await fetch('/api/settings');
  return parseSettings(
    (await res.json()) as { ok: boolean; error?: string } & Partial<DashboardSettings>,
    'Failed to load settings',
  );
}

export async function saveSettings(
  patch: Partial<DashboardSettings>,
): Promise<DashboardSettings> {
  const res = await apiFetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return parseSettings(
    (await res.json()) as { ok: boolean; error?: string } & Partial<DashboardSettings>,
    'Failed to save settings',
  );
}

export interface MultistreamKeyStatus {
  configured: boolean;
  last4: string | null;
}

export type MultistreamPlatform = 'twitch' | 'kick' | 'youtube';

export type MultistreamKeys = Partial<
  Record<MultistreamPlatform, MultistreamKeyStatus>
>;

interface MultistreamKeysResponse {
  platforms: MultistreamKeys;
  primaryPlatform: Platform;
}

export async function getMultistreamKeys(): Promise<MultistreamKeysResponse> {
  const res = await fetch('/api/obs/multistream/keys');
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    platforms?: MultistreamKeys;
    primaryPlatform?: Platform;
  };
  if (!data.ok) {
    throw new Error(data.error || 'Failed to load multistream keys');
  }
  return {
    platforms: data.platforms || {},
    primaryPlatform: data.primaryPlatform || 'twitch',
  };
}

export async function saveMultistreamKeys(
  keys: Partial<Record<MultistreamPlatform, string>>,
): Promise<MultistreamKeysResponse> {
  const res = await apiFetch('/api/obs/multistream/keys', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(keys),
  });
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    platforms?: MultistreamKeys;
    primaryPlatform?: Platform;
  };
  if (!data.ok) {
    throw new Error(data.error || 'Failed to save multistream keys');
  }
  return {
    platforms: data.platforms || {},
    primaryPlatform: data.primaryPlatform || 'twitch',
  };
}

export async function provisionObsBrowserSource(
  name: string,
  url: string,
  scenes: string[],
  rerouteAudio = true,
): Promise<void> {
  await request<never>('/api/obs/browser-source', {
    method: 'POST',
    body: JSON.stringify({
      name,
      url,
      scenes,
      reroute_audio: rerouteAudio,
    }),
  });
}

export async function deleteObsBrowserSource(name: string): Promise<void> {
  await request<never>(
    `/api/obs/browser-source?name=${encodeURIComponent(name)}`,
    {
      method: 'DELETE',
    },
  );
}

interface ObsScenes {
  currentProgramScene: string;
  scenes: string[];
}

export async function listObsScenes(): Promise<ObsScenes> {
  const res = await fetch('/api/obs/scenes');
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    currentProgramScene?: string;
    scenes?: string[];
  };
  if (!data.ok) {
    throw new Error(data.error || 'Failed to list OBS scenes');
  }
  return {
    currentProgramScene: data.currentProgramScene ?? '',
    scenes: data.scenes ?? [],
  };
}

export async function switchObsScene(sceneName: string): Promise<void> {
  const res = await apiFetch('/api/obs/scenes/switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneName }),
  });
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(data.error || 'Failed to switch OBS scene');
  }
}

export type ObsEncoder = 'x264' | 'nvenc';

export interface ObsStreamSettings {
  encoder: ObsEncoder;
  outputWidth: number;
  outputHeight: number;
  fpsNumerator: number;
  fpsDenominator: number;
  bitrate: number;
  hasNvenc: boolean;
  streamActive: boolean;
}

export interface ObsStreamSettingsInput {
  encoder: ObsEncoder;
  outputWidth: number;
  outputHeight: number;
  fpsNumerator: number;
  fpsDenominator: number;
  bitrate: number;
}

export async function getObsStreamSettings(): Promise<ObsStreamSettings> {
  const res = await fetch('/api/obs/stream-settings');
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
  } & ObsStreamSettings;
  if (!data.ok) {
    throw new Error(data.error || 'Failed to load OBS stream settings');
  }
  return {
    encoder: data.encoder,
    outputWidth: data.outputWidth,
    outputHeight: data.outputHeight,
    fpsNumerator: data.fpsNumerator,
    fpsDenominator: data.fpsDenominator,
    bitrate: data.bitrate,
    hasNvenc: data.hasNvenc,
    streamActive: data.streamActive,
  };
}

export async function setObsStreamSettings(
  settings: ObsStreamSettingsInput,
): Promise<ObsStreamSettings> {
  const res = await apiFetch('/api/obs/stream-settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
  } & ObsStreamSettings;
  if (!data.ok) {
    throw new Error(data.error || 'Failed to update OBS stream settings');
  }
  return {
    encoder: data.encoder,
    outputWidth: data.outputWidth,
    outputHeight: data.outputHeight,
    fpsNumerator: data.fpsNumerator,
    fpsDenominator: data.fpsDenominator,
    bitrate: data.bitrate,
    hasNvenc: data.hasNvenc,
    streamActive: data.streamActive,
  };
}

export interface AssetFile {
  name: string;
  size: number;
  mtime: number;
}

// ── OBS stream control ──────────────────────────────────────────────────────

export async function startObsStream(): Promise<void> {
  await request<never>('/api/obs/stream/start', { method: 'POST', body: '{}' });
}

export async function stopObsStream(): Promise<void> {
  await request<never>('/api/obs/stream/stop', { method: 'POST', body: '{}' });
}

export async function getObsStreamStatus(): Promise<StreamStatus> {
  const res = await fetch('/api/obs/stream/status');
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
  } & StreamStatus;
  if (!data.ok) {
    throw new Error(data.error || 'Failed to load stream status');
  }
  return {
    outputActive: data.outputActive,
    outputTimecode: data.outputTimecode || '',
    outputDuration: data.outputDuration || 0,
    outputBytes: data.outputBytes || 0,
    outputSkippedFrames: data.outputSkippedFrames || 0,
    outputTotalFrames: data.outputTotalFrames || 0,
  };
}

// ── OBS recording control ───────────────────────────────────────────────────

export async function startObsRecord(): Promise<void> {
  await request<never>('/api/obs/record/start', { method: 'POST', body: '{}' });
}

export async function stopObsRecord(): Promise<void> {
  await request<never>('/api/obs/record/stop', { method: 'POST', body: '{}' });
}

export async function getObsRecordStatus(): Promise<RecordStatus> {
  const res = await fetch('/api/obs/record/status');
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
  } & RecordStatus;
  if (!data.ok) {
    throw new Error(data.error || 'Failed to load recording status');
  }
  return {
    outputActive: data.outputActive,
    outputTimecode: data.outputTimecode || '',
    outputDuration: data.outputDuration || 0,
    outputBytes: data.outputBytes || 0,
    outputPaused: data.outputPaused || false,
  };
}

export async function listAssets(): Promise<AssetFile[]> {
  const res = await fetch('/api/assets');
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    files: AssetFile[];
  };
  if (!data.ok) {
    throw new Error(data.error || 'Failed to list assets');
  }
  return data.files;
}

export async function uploadAsset(file: File): Promise<AssetFile> {
  const res = await apiFetch('/api/assets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Filename': file.name,
    },
    body: file,
  });
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    file: AssetFile;
  };
  if (!data.ok) {
    throw new Error(data.error || 'Upload failed');
  }
  return data.file;
}

export async function deleteAsset(name: string): Promise<void> {
  await request<never>(`/api/assets/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

export function assetUrl(name: string): string {
  return `/api/assets/${encodeURIComponent(name)}`;
}

export interface RecordingFile {
  name: string;
  size: number;
  mtime: number;
  hasThumb: boolean;
}

export async function listRecordings(): Promise<RecordingFile[]> {
  const res = await fetch('/api/recordings');
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    files: RecordingFile[];
  };
  if (!data.ok) {
    throw new Error(data.error || 'Failed to list recordings');
  }
  return data.files;
}

export async function deleteRecording(name: string): Promise<void> {
  await request<never>(`/api/recordings/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

export function recordingUrl(name: string): string {
  return `/api/recordings/${encodeURIComponent(name)}`;
}

export function recordingDownloadUrl(name: string): string {
  return `${recordingUrl(name)}?download=1`;
}

export function recordingThumbUrl(name: string): string {
  return `/api/recordings/${encodeURIComponent(name)}/thumb.jpg`;
}

// ── Backup / restore ────────────────────────────────────────────────────────

interface BackupSize {
  files: number;
  bytes: number;
}

export async function getBackupSize(
  assets: boolean,
  recordings: boolean,
): Promise<BackupSize> {
  const qs = `?assets=${assets ? 1 : 0}&recordings=${recordings ? 1 : 0}`;
  const res = await fetch(`/api/backup/size${qs}`);
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
  } & Partial<BackupSize>;
  if (!data.ok) throw new Error(data.error || 'Failed to size the backup');
  return { files: data.files ?? 0, bytes: data.bytes ?? 0 };
}

export function backupDownloadUrl(
  assets: boolean,
  recordings: boolean,
  channel = '',
): string {
  const qs = `?assets=${assets ? 1 : 0}&recordings=${recordings ? 1 : 0}`;
  return channel
    ? `/api/backup${qs}&channel=${encodeURIComponent(channel)}`
    : `/api/backup${qs}`;
}

// Same-origin .zip download of MediaMTX + NOALBS + OBS logs (operator/admin).
export function logsDownloadUrl(): string {
  return '/api/log-bundle';
}

interface RestoreResult {  restored: string[];
  skipped: string[];
  failed: { path: string; error: string }[];
  restarted: string[];
  note: string;
}

export async function restoreBackup(file: File): Promise<RestoreResult> {
  const res = await apiFetch('/api/backup/restore', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Filename': file.name,
    },
    body: file,
  });
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
  } & Partial<RestoreResult>;
  if (!data.ok) throw new Error(data.error || 'Restore failed');
  return {
    restored: data.restored ?? [],
    skipped: data.skipped ?? [],
    failed: data.failed ?? [],
    restarted: data.restarted ?? [],
    note: data.note ?? '',
  };
}
