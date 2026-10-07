// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assetUrl,
  deleteAsset,
  deleteRecording,
  getDefaultPluginStatus,
  getIngestControls,
  getIngestProfiles,
  getIrlSourceStatus,
  getNoalbsConfig,
  getObsStreamSettings,
  getServiceConfig,
  getServiceStatus,
  installDefaultPlugin,
  listAssets,
  listObsScenes,
  listRecordings,
  provisionObsBrowserSource,
  provisionObsMediaSource,
  recordingDownloadUrl,
  recordingThumbUrl,
  recordingUrl,
  restartIngest,
  restartObs,
  saveIngestProfiles,
  saveNoalbsConfig,
  saveServiceConfig,
  serviceAction,
  setIngestMute,
  setIngestVisible,
  setObsStreamSettings,
  setPrimaryPlatform,
  switchObsScene,
  uploadAsset,
  uploadObsPlugin,
} from './api';

function mockFetchOnce(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response);
}

describe('api client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gets a NOALBS config and parses a JSON-string content field', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce({
        ok: true,
        content: JSON.stringify({ switcher: { bitrateSwitcherEnabled: true } }),
      }),
    );
    const cfg = await getNoalbsConfig();
    expect(cfg.switcher?.bitrateSwitcherEnabled).toBe(true);
  });

  it('returns an object content field as the config directly', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce({
        ok: true,
        content: { switcher: { bitrateSwitcherEnabled: false } },
      }),
    );
    const cfg = await getNoalbsConfig();
    expect(cfg.switcher?.bitrateSwitcherEnabled).toBe(false);
  });

  it('throws when the API returns ok:false', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({ ok: false, error: 'nope' }));
    await expect(getNoalbsConfig()).rejects.toThrow('nope');
  });

  it('saves a NOALBS config as JSON content', async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await saveNoalbsConfig({
      switcher: {
        bitrateSwitcherEnabled: false,
        triggers: { low: 1, offline: 2 },
      },
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/config/noalbs');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body)).content).toContain(
      'bitrateSwitcherEnabled',
    );
  });

  it('gets a service status', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce({ running: true, status: 'running', name: 'mediamtx' }),
    );
    await expect(getServiceStatus('mediamtx')).resolves.toEqual({
      running: true,
    });
  });

  it('posts a service action', async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await serviceAction('noalbs', 'restart');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/service/noalbs/restart');
    expect(init.method).toBe('POST');
  });

  it('provisions an OBS IRL media source', async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await provisionObsMediaSource('stream', 'srt://x:8890?streamid=read:key');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/obs/media-source');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.name).toBe('stream');
    expect(body.url).toBe('srt://x:8890?streamid=read:key');
    expect(body.kind).toBeUndefined();
  });

  it('lists default plugin status from the plugins field', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce({
        ok: true,
        plugins: [
          {
            name: 'obs-irl-source',
            version: '2.0.0',
            installed: true,
            loaded: true,
            dir: '/p',
            kind: 'tar',
            default: true,
          },
        ],
      }),
    );
    await expect(getDefaultPluginStatus()).resolves.toEqual([
      expect.objectContaining({ name: 'obs-irl-source', installed: true }),
    ]);
  });

  it('derives obs-irl-source status from the default plugin list', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce({
        ok: true,
        plugins: [
          {
            name: 'obs-irl-source',
            version: '2.0.0',
            installed: true,
            loaded: true,
            dir: '/p',
            kind: 'tar',
            default: true,
          },
        ],
      }),
    );
    await expect(getIrlSourceStatus()).resolves.toMatchObject({
      installed: true,
      loaded: true,
      dir: '/p',
    });
  });

  it('falls back to an uninstalled obs-irl-source when absent from the list', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({ ok: true, plugins: [] }));
    await expect(getIrlSourceStatus()).resolves.toEqual({
      name: 'obs-irl-source',
      version: '',
      installed: false,
      loaded: false,
      dir: '',
    });
  });

  it('installs a default plugin via POST /install', async () => {
    const fetchMock = mockFetchOnce({ ok: true, restartRequired: true });
    vi.stubGlobal('fetch', fetchMock);
    await installDefaultPlugin('aitum-multistream');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/obs/plugins/aitum-multistream/install');
    expect(init.method).toBe('POST');
  });

  it('uploads a plugin tarball as octet-stream with X-Filename', async () => {
    const fetchMock = mockFetchOnce({ ok: true, restartRequired: true });
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['fake'], 'my-plugin.tar.gz', {
      type: 'application/gzip',
    });
    await uploadObsPlugin(file);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/obs/plugins');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Filename']).toBe('my-plugin.tar.gz');
  });

  it('restarts OBS via POST /api/obs/restart', async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await restartObs();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/obs/restart');
    expect(init.method).toBe('POST');
  });

  it('provisions an OBS browser source with reroute_audio enabled', async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await provisionObsBrowserSource('twitch_clips', 'https://x/clips.html', [
      'brb',
      'low-br',
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/obs/browser-source');
    const body = JSON.parse(String(init.body));
    expect(body.name).toBe('twitch_clips');
    expect(body.scenes).toEqual(['brb', 'low-br']);
    expect(body.reroute_audio).toBe(true);
  });

  it('provisions a browser source with reroute_audio disabled when requested', async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await provisionObsBrowserSource(
      'twitch_chat',
      'https://x/chat',
      ['brb'],
      false,
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/obs/browser-source');
    const body = JSON.parse(String(init.body));
    expect(body.name).toBe('twitch_chat');
    expect(body.reroute_audio).toBe(false);
  });

  it('lists OBS scenes from the top-level response shape', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce({
        ok: true,
        currentProgramScene: 'main',
        scenes: ['main', 'brb'],
      }),
    );
    await expect(listObsScenes()).resolves.toEqual({
      currentProgramScene: 'main',
      scenes: ['main', 'brb'],
    });
  });

  it('defaults to an empty scene list when OBS returns none', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({ ok: true }));
    await expect(listObsScenes()).resolves.toEqual({
      currentProgramScene: '',
      scenes: [],
    });
  });

  it('throws when listing OBS scenes fails', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({ ok: false, error: 'OBS down' }));
    await expect(listObsScenes()).rejects.toThrow('OBS down');
  });

  it('switches an OBS scene via POST', async () => {
    const fetchMock = mockFetchOnce({ ok: true, sceneName: 'brb' });
    vi.stubGlobal('fetch', fetchMock);
    await switchObsScene('brb');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/obs/scenes/switch');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body)).sceneName).toBe('brb');
  });

  it('throws when switching an OBS scene fails', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce({ ok: false, error: 'no such scene' }),
    );
    await expect(switchObsScene('nope')).rejects.toThrow('no such scene');
  });

  it('loads OBS stream settings from the top-level response shape', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce({
        ok: true,
        encoder: 'x264',
        outputWidth: 1920,
        outputHeight: 1080,
        fpsNumerator: 60,
        fpsDenominator: 1,
        bitrate: 6000,
        hasNvenc: false,
        streamActive: false,
      }),
    );
    await expect(getObsStreamSettings()).resolves.toEqual({
      encoder: 'x264',
      outputWidth: 1920,
      outputHeight: 1080,
      fpsNumerator: 60,
      fpsDenominator: 1,
      bitrate: 6000,
      hasNvenc: false,
      streamActive: false,
    });
  });

  it('throws when loading OBS stream settings fails', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({ ok: false, error: 'OBS down' }));
    await expect(getObsStreamSettings()).rejects.toThrow('OBS down');
  });

  it('updates OBS stream settings via PUT', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      encoder: 'nvenc',
      outputWidth: 1280,
      outputHeight: 720,
      fpsNumerator: 60,
      fpsDenominator: 1,
      bitrate: 4500,
      hasNvenc: true,
      streamActive: false,
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await setObsStreamSettings({
      encoder: 'nvenc',
      outputWidth: 1280,
      outputHeight: 720,
      fpsNumerator: 60,
      fpsDenominator: 1,
      bitrate: 4500,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/obs/stream-settings');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      encoder: 'nvenc',
      outputWidth: 1280,
      outputHeight: 720,
      fpsNumerator: 60,
      fpsDenominator: 1,
      bitrate: 4500,
    });
    expect(result.encoder).toBe('nvenc');
  });

  it('throws when updating OBS stream settings fails', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce({ ok: false, error: 'Stop the stream first' }),
    );
    await expect(
      setObsStreamSettings({
        encoder: 'x264',
        outputWidth: 1920,
        outputHeight: 1080,
        fpsNumerator: 60,
        fpsDenominator: 1,
        bitrate: 6000,
      }),
    ).rejects.toThrow('Stop the stream first');
  });

  it('loads and saves a service config file', async () => {
    const getMock = mockFetchOnce({
      ok: true,
      content: { content: '# config', file: '/etc/x.conf' },
    });
    vi.stubGlobal('fetch', getMock);
    const result = await getServiceConfig('mediamtx');
    expect(result.file).toBe('/etc/x.conf');

    const putMock = mockFetchOnce({ ok: true });
    vi.stubGlobal('fetch', putMock);
    await saveServiceConfig('mediamtx', '# new');
    const [url, init] = putMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/config/mediamtx');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body)).content).toBe('# new');
  });

  it('lists OBS assets', async () => {
    const files = [{ name: 'bg.png', size: 12, mtime: 1 }];
    vi.stubGlobal('fetch', mockFetchOnce({ ok: true, files }));
    await expect(listAssets()).resolves.toEqual(files);
  });

  it('throws when listing assets returns an error', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({ ok: false, error: 'no assets' }));
    await expect(listAssets()).rejects.toThrow('no assets');
  });

  it('uses a fallback message when the list error has no details', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({ ok: false }));
    await expect(listAssets()).rejects.toThrow('Failed to list assets');
  });

  it('uploads an OBS asset as a raw octet-stream with an X-Filename header', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      file: { name: 'overlay.png', size: 9, mtime: 2 },
    });
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['overlay'], 'overlay.png', { type: 'image/png' });
    await expect(uploadAsset(file)).resolves.toEqual({
      name: 'overlay.png',
      size: 9,
      mtime: 2,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/assets');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Filename']).toBe(
      'overlay.png',
    );
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/octet-stream',
    );
  });

  it('throws when an upload returns ok:false', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce({ ok: false, error: 'File exceeds limit' }),
    );
    const file = new File(['x'], 'big.mp4', { type: 'video/mp4' });
    await expect(uploadAsset(file)).rejects.toThrow('File exceeds limit');
  });

  it('uses a fallback message when the upload error has no details', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({ ok: false }));
    const file = new File(['x'], 'x.bin');
    await expect(uploadAsset(file)).rejects.toThrow('Upload failed');
  });

  it('deletes an OBS asset by URL-encoded name', async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await deleteAsset('my overlay.png');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/assets/my%20overlay.png');
    expect(init.method).toBe('DELETE');
  });

  it('builds an asset download URL from a name', () => {
    expect(assetUrl('a b.png')).toBe('/api/assets/a%20b.png');
    expect(assetUrl('plain.png')).toBe('/api/assets/plain.png');
  });

  describe('recordings', () => {
    it('lists recordings from the top-level files field', async () => {
      const files = [
        { name: 'clip.mp4', size: 123, mtime: 5, hasThumb: false },
      ];
      vi.stubGlobal('fetch', mockFetchOnce({ ok: true, files }));
      await expect(listRecordings()).resolves.toEqual(files);
    });

    it('throws when listing recordings returns an error', async () => {
      vi.stubGlobal('fetch', mockFetchOnce({ ok: false, error: 'disk full' }));
      await expect(listRecordings()).rejects.toThrow('disk full');
    });

    it('uses a fallback message when the list error has no details', async () => {
      vi.stubGlobal('fetch', mockFetchOnce({ ok: false }));
      await expect(listRecordings()).rejects.toThrow(
        'Failed to list recordings',
      );
    });

    it('deletes a recording by URL-encoded name', async () => {
      const fetchMock = mockFetchOnce({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      await deleteRecording('2026-09-01 21-54-24.mp4');
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/recordings/2026-09-01%2021-54-24.mp4');
      expect(init.method).toBe('DELETE');
    });

    it('builds recording stream, thumb, and download URLs', () => {
      expect(recordingUrl('a b.mp4')).toBe('/api/recordings/a%20b.mp4');
      expect(recordingDownloadUrl('a b.mp4')).toBe(
        '/api/recordings/a%20b.mp4?download=1',
      );
      expect(recordingThumbUrl('a b.mp4')).toBe(
        '/api/recordings/a%20b.mp4/thumb.jpg',
      );
    });
  });

  describe('ingest profiles', () => {
    it('loads the saved profile list and the monitored feed', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetchOnce({ ok: true, profiles: ['irl', 'test'], main: 'irl' }),
      );
      expect(await getIngestProfiles()).toEqual({
        profiles: ['irl', 'test'],
        main: 'irl',
      });
    });

    it('PUTs the profile list + main and returns the server copy', async () => {
      const fetchMock = mockFetchOnce({ ok: true, profiles: ['irl', 'test'], main: 'test' });
      vi.stubGlobal('fetch', fetchMock);
      expect(await saveIngestProfiles(['irl', 'test'], 'test')).toEqual({
        profiles: ['irl', 'test'],
        main: 'test',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/ingest/profiles');
      expect(init.method).toBe('PUT');
    });
  });

  describe('ingest source controls', () => {
    it('loads control state with a names query', async () => {
      const fetchMock = mockFetchOnce({
        ok: true,
        sources: [
          { name: 'test', muted: false, visible: true, restartable: true },
        ],
      });
      vi.stubGlobal('fetch', fetchMock);
      const sources = await getIngestControls(['test', 'angle1']);
      expect(sources).toHaveLength(1);
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe('/api/obs/media-source/state?names=test%2Cangle1');
    });

    it('POSTs mute, visibility, and restart changes', async () => {
      const fetchMock = mockFetchOnce({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      await setIngestMute('test', true);
      await setIngestVisible('test', false);
      await restartIngest('test');
      const calls = fetchMock.mock.calls as [string, RequestInit][];
      expect(calls[0][0]).toBe('/api/obs/media-source/mute');
      expect(JSON.parse(String(calls[0][1].body))).toEqual({ name: 'test', muted: true });
      expect(calls[1][0]).toBe('/api/obs/media-source/visibility');
      expect(JSON.parse(String(calls[1][1].body))).toEqual({ name: 'test', visible: false });
      expect(calls[2][0]).toBe('/api/obs/media-source/restart');
      expect(JSON.parse(String(calls[2][1].body))).toEqual({ name: 'test' });
    });
  });
});

describe('CSRF header on state-changing calls', () => {
  afterEach(() => {
    document.cookie = 'oink_csrf=; Max-Age=0; path=/';
    vi.restoreAllMocks();
  });

  it('switchObsScene (POST) sends X-CSRF-Token from the cookie', async () => {
    document.cookie = 'oink_csrf=tok123; path=/';
    const fetchMock = mockFetchOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await switchObsScene('main');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/obs/scenes/switch');
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe('tok123');
  });

  it('setPrimaryPlatform (PUT) sends it too', async () => {
    document.cookie = 'oink_csrf=tok456; path=/';
    const fetchMock = mockFetchOnce({ ok: true, restartRequired: false });
    vi.stubGlobal('fetch', fetchMock);
    await setPrimaryPlatform('twitch');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe('tok456');
  });

  it('omits the header when no CSRF cookie is present (mocked e2e)', async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await switchObsScene('main');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBeUndefined();
  });
});
