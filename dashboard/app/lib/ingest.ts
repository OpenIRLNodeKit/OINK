// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
export const SRT_PORT = 8890;
export const SRTLA_PORT = 5000;
export const RTMP_PORT = 1935;
export const RTSP_PORT = 8554;

// Reserved ingest label: always present, non-deletable, and the default feed
// NOALBS monitors. Mirrors stack/ingest.js RESERVED_LABEL.
export const INGEST_RESERVED_LABEL = 'irl';

export interface IngestUrls {
  rtmp: string;
  srt: string;
  srtLiveU: string;
  srtla: string;
}

// Canonical MediaMTX ingest path: `live/<key>/<label>`. Every protocol below
// embeds this exact path so an encoder publishing on one protocol is readable
// on another (and by the OBS SRT/RTSP reader). The <key> is the per-install
// secret (see /api/ingest) that gates access to the whole namespace.
export function canonicalIngestPath(key: string, label: string): string {
  return `live/${key}/${label}`;
}

export function generateRtmpUrl(
  host: string,
  key: string,
  label: string,
): string {
  return `rtmp://${host}:${RTMP_PORT}/${canonicalIngestPath(key, label)}`;
}

export function generateSrtUrl(
  host: string,
  key: string,
  label: string,
  streamId = 'publish',
): string {
  return `srt://${host}:${SRT_PORT}?streamid=${streamId}:${canonicalIngestPath(key, label)}&pkt_size=1316`;
}

export function generateSrtlaUrl(
  host: string,
  key: string,
  label: string,
): string {
  // BELABOX/Moblin bond modems with the SRTLA protocol to the oink-srtla
  // receiver on :5000, which forwards the reassembled SRT stream to MediaMTX
  // on :8890. The streamid keeps the keyed path so MediaMTX still gates access.
  return `srtla://${host}:${SRTLA_PORT}?streamid=publish:${canonicalIngestPath(key, label)}`;
}

// BELABOX splits SRTLA config across three boxes instead of one URL: the relay
// address/port (oink-srtla, UDP :5000) and the SRT streamid for MediaMTX.
export interface SrtlaDetails {
  serverAddress: string;
  port: string;
  streamId: string;
}

export function generateSrtlaDetails(
  host: string,
  key: string,
  label: string,
): SrtlaDetails {
  return {
    serverAddress: host,
    port: String(SRTLA_PORT),
    streamId: `publish:${canonicalIngestPath(key, label)}`,
  };
}

export function generateIngestUrls(
  host: string,
  key: string,
  label: string,
): IngestUrls {
  return {
    rtmp: generateRtmpUrl(host, key, label),
    srt: generateSrtUrl(host, key, label),
    srtLiveU: generateSrtUrl(host, key, label),
    srtla: generateSrtlaUrl(host, key, label),
  };
}

// LiveU Solo Portal splits SRT config across separate boxes instead of one URL.
export interface LiveUDetails {
  destination: string;
  primaryIngress: string;
  streamId: string;
}

export function generateLiveUDetails(
  host: string,
  key: string,
  label: string,
): LiveUDetails {
  return {
    destination: label,
    primaryIngress: `srt://${host}:${SRT_PORT}`,
    streamId: `publish:${canonicalIngestPath(key, label)}`,
  };
}

export function generateLarixUrl(
  host: string,
  key: string,
  label: string,
): string {
  const params: Array<[string, string]> = [
    ['conn[][url]', `srt://${host}:${SRT_PORT}`],
    ['conn[][name]', `[OINK] ${label}`],
    ['conn[][srtlatency]', '2000'],
    ['conn[][srtstreamid]', `publish:${canonicalIngestPath(key, label)}`],
    ['conn[][active]', 'off'],
    ['conn[][overwrite]', 'on'],
    ['enc[vid][format]', 'hevc'],
    ['enc[vid][keyframe]', '2'],
    ['enc[vid][bitrate]', '0'],
    ['enc[vid][adaptiveBitrate]', '1'],
    ['enc[aud][channels]', '2'],
  ];
  return (
    'larix://set/v1?' +
    params
      .map(([param, value]) => `${param}=${encodeURIComponent(value)}`)
      .join('&')
  );
}

export function generateMoblinUrl(
  host: string,
  key: string,
  label: string,
): string {
  const payload = {
    streams: [
      {
        name: `[OINK] ${label}`,
        url: `srt://${host}:${SRT_PORT}?streamid=#!::m=publish,r=${canonicalIngestPath(key, label)}`,
        video: {
          resolution: '1920x1080',
          fps: 30,
          bitrate: 4000,
          codec: 'H.265/HEVC',
          maxKeyFrameInterval: 2,
        },
        audio: { bitrate: 128 },
        srt: { latency: 2000, adaptiveBitrateEnabled: true },
      },
    ],
  };
  return `moblin://?${encodeURIComponent(JSON.stringify(payload))}`;
}

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// IRLwhatever preset schema (mirrors the app's exported preset, minus pipScale).
export function generateIrlWhateverUrl(
  host: string,
  key: string,
  label: string,
): string {
  const payload = {
    connectionName: `[OINK] ${label}`,
    destination: `srt://${host}:${SRT_PORT}?streamid=publish:${canonicalIngestPath(key, label)}`,
    videoBitrate: 6000,
    audioBitrate: 128,
    videoWidth: 1920,
    videoHeight: 1080,
    fps: 30,
    sampleRate: 48000,
    isStereo: true,
    srtLatency: 2000,
    adaptiveBitrate: true,
    pipEnabled: false,
    chatScale: 1,
    chatHeight: 0.5,
    chatBackgroundAlpha: 0.4,
    chatTextEffect: 'NONE',
    chatTextEffectColor: 4278190080,
    showPlatformBadge: true,
    animatedEmotes: true,
    showThermalWarning: true,
    defaultOpticalStabilization: 'OFF',
    defaultVideoStabilization: 'OFF',
    audioMeterPosition: 'LEFT',
    pipPositionX: -1,
    pipPositionY: -1,
    chatMode: 'OVERLAY',
    noiseReductionMode: 'FAST',
  };
  return `irlwhatever://import/${base64Url(JSON.stringify(payload))}`;
}

export type Encoder = 'irlpro' | 'moblin' | 'irlwhatever';

export function generateDeepLink(
  host: string,
  encoder: Encoder,
  key: string,
  label: string,
): string {
  if (encoder === 'moblin') return generateMoblinUrl(host, key, label);
  if (encoder === 'irlwhatever')
    return generateIrlWhateverUrl(host, key, label);
  return generateLarixUrl(host, key, label);
}

// OBS SRT read URL — MediaMTX path scoped to the keyed namespace. The read
// source is the obs-irl-source plugin's `irl_source` input; the latency window
// covers the SRT transport hop from MediaMTX.
export function generateObsReadUrl(
  host: string,
  key: string,
  label: string,
): string {
  return `srt://${host}:${SRT_PORT}?streamid=read:${canonicalIngestPath(key, label)}&latency=2000000&pkt_size=1316`;
}
