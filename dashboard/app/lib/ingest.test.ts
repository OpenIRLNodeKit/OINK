// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  canonicalIngestPath,
  generateDeepLink,
  generateIngestUrls,
  generateIrlWhateverUrl,
  generateLarixUrl,
  generateLiveUDetails,
  generateMoblinUrl,
  generateObsReadUrl,
  generateRtmpUrl,
  generateSrtlaUrl,
  generateSrtUrl,
  RTMP_PORT,
  SRT_PORT,
} from './ingest';

describe('ingest URL generators', () => {
  const host = '192.168.1.50';
  const key = 'AbC123_xYz-9';
  const label = 'my_live_stream';
  const path = canonicalIngestPath(key, label);

  it('canonical path is live/<key>/<label>', () => {
    expect(path).toBe('live/AbC123_xYz-9/my_live_stream');
  });

  it('generates an RTMP URL scoped to the keyed path', () => {
    expect(generateRtmpUrl(host, key, label)).toBe(
      `rtmp://${host}:${RTMP_PORT}/${path}`,
    );
  });

  it('generates an SRT URL with publish stream id on the keyed path', () => {
    expect(generateSrtUrl(host, key, label)).toBe(
      `srt://${host}:${SRT_PORT}?streamid=publish:${path}&pkt_size=1316`,
    );
  });

  it('generates an SRTLA URL using standard stream-id syntax on the keyed path', () => {
    expect(generateSrtlaUrl(host, key, label)).toBe(
      `srt://${host}:${SRT_PORT}?streamid=#!::m=publish,r=${path}`,
    );
  });

  it('produces all protocol URLs with the identical keyed path', () => {
    const urls = generateIngestUrls(host, key, label);
    expect(urls.rtmp).toContain(`/${path}`);
    expect(urls.srt).toBe(urls.srtLiveU);
    expect(urls.srtla).toContain(`r=${path}`);
    for (const u of [urls.rtmp, urls.srt, urls.srtLiveU, urls.srtla]) {
      expect(u).toContain(key);
    }
  });

  it('generates an OBS read URL on the keyed path', () => {
    expect(generateObsReadUrl(host, key, label)).toBe(
      `srt://${host}:${SRT_PORT}?streamid=read:${path}&latency=2000000&pkt_size=1316`,
    );
  });

  it('generates a Larix deep link carrying host:port and keyed srtstreamid', () => {
    const url = generateLarixUrl(host, key, label);
    expect(url.startsWith('larix://set/v1?')).toBe(true);
    expect(url).toContain(
      `conn[][url]=${encodeURIComponent(`srt://${host}:${SRT_PORT}`)}`,
    );
    expect(url).toContain(
      `conn[][srtstreamid]=${encodeURIComponent(`publish:${path}`)}`,
    );
    expect(url).toContain('enc[vid][format]=hevc');
  });

  it('generates a Moblin deep link with an encoded JSON settings blob', () => {
    const url = generateMoblinUrl(host, key, label);
    expect(url.startsWith('moblin://?')).toBe(true);
    const payload = JSON.parse(
      decodeURIComponent(url.slice('moblin://?'.length)),
    );
    expect(payload.streams[0].name).toBe(`[OINK] ${label}`);
    expect(payload.streams[0].url).toContain(`${host}:${SRT_PORT}`);
    expect(payload.streams[0].url).toContain(`r=${path}`);
  });

  it('splits LiveU Solo config into destination, ingress, and stream id', () => {
    expect(generateLiveUDetails(host, key, label)).toEqual({
      destination: label,
      primaryIngress: `srt://${host}:${SRT_PORT}`,
      streamId: `publish:${path}`,
    });
  });

  it('generates a base64url IRLwhatever import preset on the keyed path', () => {
    const url = generateIrlWhateverUrl(host, key, label);
    expect(url.startsWith('irlwhatever://import/')).toBe(true);
    const payload = JSON.parse(
      Buffer.from(
        url.slice('irlwhatever://import/'.length),
        'base64url',
      ).toString(),
    );
    expect(payload.connectionName).toBe(`[OINK] ${label}`);
    expect(payload.destination).toBe(
      `srt://${host}:${SRT_PORT}?streamid=publish:${path}`,
    );
    expect(payload.srtLatency).toBe(2000);
    expect(payload.audioMeterPosition).toBe('LEFT');
    expect(payload.pipScale).toBeUndefined();
  });

  it('selects the right deep link per encoder', () => {
    expect(generateDeepLink(host, 'irlpro', key, label)).toContain('larix://');
    expect(generateDeepLink(host, 'moblin', key, label)).toContain('moblin://');
    expect(generateDeepLink(host, 'irlwhatever', key, label)).toContain(
      'irlwhatever://import/',
    );
  });
});
