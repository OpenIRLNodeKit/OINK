---
title: Environment Variables
---

**Available settings** (see [`oink.conf.example`](oink.conf.example)):

| Variable | Default | Purpose |
|---|---|---|
| `OINK_ADMIN_PASSWORD` | unset — set at first visit | Optional admin bootstrap password for unattended installs (username `admin`). If unset, setup prints a one-time `/setup#token=…` link where you choose the username and password. |
| `OINK_OBS_USER` | `obsuser` | Unprivileged account OBS + the stack run as |
| `OINK_INGEST_KEY` | generated | Keyed ingest prefix `live/<key>/` |
| `OINK_PRIMARY_PLATFORM` | `twitch` | `twitch` \| `youtube` \| `kick` — the platform OBS streams to |
| `OINK_TWITCH_CHANNEL` | — | Twitch channel name (used by the clips/chat overlays; seeds the first-run welcome) |
| `OINK_VIDEO_PRESET` | — | `720p30` \| `720p60` \| `1080p30` \| `1080p60` \| `1440p60` — resolution/fps/bitrate (seeds the welcome) |
| `OINK_TWITCH_STREAM_KEY` / `OINK_YOUTUBE_STREAM_KEY` / `OINK_KICK_STREAM_KEY` | — | Per-platform stream keys; non-primary platforms go out via Aitum Multistream |
| `OINK_WEB_PORT` | `8305` | Dashboard (Nginx) listen port |
| `OINK_TRUSTED_PROXIES` | unset (off) | Trust a fronting TLS proxy — `true` (same-host/loopback) or a comma-separated CIDR list (e.g. `10.0.0.0/8,192.168.0.0/16`). Enables real client IP, `Secure` session cookie, and HSTS. Leave unset for plain HTTP. |
| `OINK_TWITCH_BOT_USERNAME` | — | NOALBS chat-bot account (must be Editor of your channel) |
| `OINK_TWITCH_BOT_OAUTH` | — | `oauth:<token>` for the chat bot |
| `OINK_SESSION_SECRET` | generated | Session-cookie HMAC key (always generated, preserved) |

**Re-running `setup -c` overrides what a config can *not* change** — these are
seed-once / first-boot-only and ignore a changed value on an already-set-up node:

| Setting | Why |
|---|---|
| `OINK_ADMIN_PASSWORD` | Optional bootstrap seed. The first admin login is hashed into `users.json` on the first API start, or created from the one-time `/setup` page when the password is unset. Later config re-runs don't touch it. Change a login with `sudo oink users reset`. |
| `OINK_INGEST_KEY` | The ingest profile is created once. An existing `ingest.json` is kept on re-runs; apply a new key by deleting it (`rm ~/obsuser/oink/stack/ingest.json`) or in the dashboard (Settings → Stream Settings → rotate). |
| `OINK_OBS_USER` | The runtime account and every path are baked at the first setup. Set before the first install. |
| `OINK_SESSION_SECRET` | Not configurable — always generated and preserved. |
| `OINK_TWITCH_BOT_USERNAME` / `OINK_TWITCH_BOT_OAUTH` | `noalbs/.env` is only created when missing; existing chat credentials are never clobbered. |
| `OINK_TWITCH_CHANNEL` / `OINK_VIDEO_PRESET` | Seed the first-run welcome screen once. They are stored in `dashboard.json`/OBS on the first API boot; later dashboard edits are never clobbered by a setup re-run. |

Everything else (`OINK_PRIMARY_PLATFORM`, the `OINK_*_STREAM_KEY` set, and
`OINK_TWITCH_CHANNEL` — which is wired into NOALBS' `chat.username`, the channel
it joins) is re-applied to the box on every setup run and at OBS boot.

---
