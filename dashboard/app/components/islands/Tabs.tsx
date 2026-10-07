"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react';
import LogViewer from './LogViewer';
import ServiceControl from './ServiceControl';
import TabBar from './TabBar';
import VersionsPanel from './VersionsPanel';

const SERVICE_TABS = [
  { key: 'versions', label: 'Versions' },
  { key: 'mediamtx', label: 'MediaMTX' },
  { key: 'noalbs', label: 'NOALBS' },
  { key: 'obs', label: 'OBS' },
];

function ServicePanel({
  service,
  name,
  description,
  configurable,
  label,
}: {
  service: string;
  name: string;
  description: string;
  configurable?: boolean;
  label: string;
}) {
  return (
    <div className="surface overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-3.5">
        <div className="flex items-baseline gap-3">
          <h3 className="text-sm font-medium tracking-tight">{name} - Logs</h3>
          <span className="text-xs text-text-secondary">{description}</span>
        </div>
        <ServiceControl service={service} label={name} configurable={configurable} />
      </div>
      <LogViewer service={service} label={label} />
    </div>
  );
}

const PANELS: Record<string, React.ReactNode> = {
  versions: <VersionsPanel />,
  mediamtx: (
    <ServicePanel
      service="mediamtx"
      name="MediaMTX"
      description="RTMP/SRT ingest server"
      configurable
      label="MediaMTX"
    />
  ),
  noalbs: (
    <ServicePanel
      service="noalbs"
      name="NOALBS"
      description="Auto scene switcher"
      configurable
      label="NOALBS"
    />
  ),
  obs: (
    <ServicePanel
      service="obs"
      name="OBS Studio"
      description="Headless OBS — systemd managed"
      label="OBS"
    />
  ),
};

export default function Tabs() {
  const [active, setActive] = useState(SERVICE_TABS[0].key);

  return (
    <div>
      <TabBar tabs={SERVICE_TABS} active={active} onChange={setActive} />
      <div className="space-y-4">{PANELS[active]}</div>
    </div>
  );
}
