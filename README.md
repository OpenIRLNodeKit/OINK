<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="website/src/assets/logo-white.png">
    <img src="website/src/assets/logo-black.png" alt="OINK logo">
  </picture>
</p>

**The open-source, self-hosted OBS cloud streaming server.**

> [!NOTE]  
> This project is still under testing and has bugs. Thank you for testing, please report issues.

OpenIRLNodeKit (OINK) sits between your mobile or desktop and platforms like Twitch, YouTube, and Kick — providing stream-drop protection, a headless OBS instance you control from a modern browser.

```text
📱 Phone Encoder ──RTMP/SRT──▶ 🎛️ OINK Ingest ──▶ 🖥️ Headless OBS ──▶ 📡 Twitch/YouTube/Kick
                                            ▲
                    🌐 Browser Dashboard + Remote OBS
```

## 🚀 Quick Start

### Prerequisites

- Fresh **Ubuntu 24.04 LTS** server install
  - VM or bare metal
- 6+ CPU cores, 8+ GB RAM recommended
- A GPU is optional, but highly recommended

### Install

One command, from a fresh Ubuntu 24.04 box:

```bash
curl -fsSL https://openirlnodekit.com/install.sh | sudo bash
```

Then open the dashboard at `http://<YOUR-IP>:8305`.

Manually:

```bash
git clone https://github.com/OpenIRLNodeKit/OINK.git
cd OINK
sudo python3 oink.py setup
```

### When it's done

```
════════════════════════════════════════════════════════════
   All checks passed ✓
   Dashboard:     http://<YOUR-IP>:8305
   Username:      admin
   Set password:  http://<YOUR-IP>:8305/setup#token=<one-time-token>
   Remote OBS:    http://<YOUR-IP>:8305/remote/ (sign in to the dashboard first)
   RTMP Ingest:   rtmp://<YOUR-IP>:1935/live/{stream_key}/{label}
   SRT Ingest:    srt://<YOUR-IP>:8890?streamid=publish:live/{stream_key}/{label}
════════════════════════════════════════════════════════════
```

The **admin username is `admin`**. Set its password from the one-time setup link printed at the end of setup. Your secret stream key lives in dashboard **Settings → Stream Settings** (view or rotate it there).

### Commands

`setup` installs `oink` (a symlink to `oink.py`) into `/usr/local/bin`, so these run from any directory:

| Command | What it does |
|---|---|
| `sudo oink setup` | Full install (host + stack) |
| `sudo oink cleanup` | Full uninstall from a host |
| `sudo oink status` | Read-only health report |
| `sudo oink users` | List users / reset a password |

### Unattended / cloud-init installs

Pass `-c FILE` to load `OINK_*` settings from a config
file. Copy [`oink.conf.example`](oink.conf.example), set the values you want, then:

```bash
sudo python3 oink.py -c oink.conf setup -y --force
```

Without `-c`, every value is generated/default.

A ready-to-use [`cloud-init.example.yaml`](cloud-init.example.yaml) is included.

Precedence: real process environment > config file > generated/default.

## ✨ Features

- 🖥️ **Headless OBS Studio** — Runs on a virtual display; no monitor required
- 🌐 **Guacamole Remote Desktop** — Full OBS UI in your browser
- 🔌 **obs-websocket v5** — Scene switching, stream control
- 📺 **Web Dashboard** — React Router: live OBS monitor, remote desktop, ingest, recordings, settings
- 🚀 **First-run Welcome** — Guides channel name, stream keys, and video quality on first login; skipped when the `OINK_*` config already provides them
- 📡 **MediaMTX Ingest** — RTMP/SRT/RTSP ingest with a per-install secret ingest key; SRTLA bonding de-bonded by `srtla_rec`
- 🛡️ **Stream Drop Protection** — Auto-switches to BRB/Low-Bitrate when your feed drops
- 🎞️ **Overlays** — Easy Twitch clips player, chat overlay, or any custom browser-source URL
- 💬 **Multi-platform** — Stream to Twitch, YouTube, and Kick; multistream + vertical canvas via OBS plugins
- ⚙️ **Systemd Managed** — Services start on boot and auto-restart on crash

## 📄 License

AGPL-3.0 — see [LICENSE](LICENSE) for details.

## 🙏 Built With

### 🎥 OBS & Streaming

- [OBS Studio](https://obsproject.com/) — streaming/recording
- [obs-websocket](https://github.com/obsproject/obs-websocket) — OBS WebSocket API
- [NOALBS](https://github.com/NOALBS/nginx-obs-automatic-low-bitrate-switching) — stream drop protection
- [Aitum Vertical Canvas](https://github.com/Aitum/obs-vertical-canvas) — vertical canvas plugin
- [Aitum Multistream](https://github.com/Aitum/obs-aitum-multistream) — stream to Twitch/YouTube/Kick
- [obs-irl-source](https://github.com/irlserver/obs-irl-source) — IRL media source plugin
- [irl-clips](https://github.com/irlserver/irl-clips) — IRL clips player
- [srtla](https://github.com/irlserver/srtla) — SRTLA multi-link bonding receiver (srtla_rec)
- [twitch_clips_player](https://github.com/teklynk/twitch_clips_player) — Twitch clips overlay

### 🌐 Web & Remote Desktop

- [React Router](https://reactrouter.com/) — web framework
- [Vite](https://vite.dev/) — build tool
- [Apache Guacamole](https://guacamole.apache.org/) — remote desktop gateway
- [guacamole-lite](https://github.com/vadimpronin/guacamole-lite) — lightweight Guacamole client
- [x11vnc](https://github.com/LibVNC/x11vnc) — VNC server for X11
- [MediaMTX](https://github.com/bluenviron/mediamtx) — RTMP/SRT/HLS ingest server

<p align="center">
  <i>Built with ❤️ for the IRL streaming community</i>
</p>
