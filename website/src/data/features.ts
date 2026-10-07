// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
export const FEATURES = [
	{
		title: 'Headless OBS',
		body: 'OBS Studio runs headless on a Linux VM, driven over the obs-websocket API — scenes, media sources, and live switch from the browser.',
		icon: 'camera',
		href: 'https://obsproject.com/',
	},
	{
		title: 'Remote desktop',
		body: 'A Guacamole tunnel into a virtual X display gives a full browser-based remote desktop to the box, wherever it sits.',
		icon: 'monitor',
		href: 'https://guacamole.apache.org/',
	},
	{
		title: 'MediaMTX ingest',
		body: 'RTMP, SRT and RTSP ingest via MediaMTX with a per-install stream key — ready for deployment use.',
		icon: 'signal',
		href: 'https://mediamtx.org/',
	},
	{
		title: 'Drop Protection',
		body: 'NOALBS watches the ingest and auto-switches OBS to a BRB or low-bitrate scene the moment your phone feed drops — no dead air.',
		icon: 'shield',
		href: 'https://github.com/NOALBS/nginx-obs-automatic-low-bitrate-switching',
	},
	{
		title: 'Aitum plugins',
		body: "Aitum's Vertical Canvas adds a ready vertical scene, while Aitum Multistream fans the stream out to Twitch, YouTube, and Kick at once.",
		icon: 'layers',
		href: 'https://aitum.tv/',
	},
	{
		title: 'React dashboard',
		body: 'A React Router SPA with live preview, service control, journald logs, and chat-driven scene switching.',
		icon: 'layout',
		href: 'https://reactrouter.com/',
	},
] as const;
