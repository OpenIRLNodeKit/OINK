---
title: Quickstart
description: Install OpenIRLNodeKit on a fresh VM and run your first ingest test.
---

Get a machine, clone, open the dashboard.

## 1 · Requirements

Machine, either bare metal or VM:

:::note
Make sure this machine is only used for OINK!
:::

- Ubuntu Linux 24.04

Hardware:

- 6 CPU
- 8GB RAM
- 100GB disk
- GPU either itegrated or dedicated
  - VMs cannot use integrated graphics

Network Ports:

- OINK Dashboard: 8305
- RTMP: 1935
- SRT: 8890/udp
- SRTLA: 5000/udp

## 2 · Install

```bash
curl -fsSL https://openirlnodekit.com/install.sh | sudo bash
```

## 3 · First ingest

Dashboard at `http://<ip-address>:8305` — open Ingest, copy the channel key, push a test frame from your phone from the browser.

:::danger
The dashboard and API serve plain HTTP. Before exposing them to the public internet, use your own TLS-terminating reverse proxy (Nginx/Caddy/Traefik/Cloudflare Tunnel/VPN) — dashboard credentials and ingest stream keys otherwise travel in cleartext.
:::
