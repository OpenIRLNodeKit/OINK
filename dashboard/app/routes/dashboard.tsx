"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useState } from "react";
import PreviewFrame from "../components/islands/PreviewFrame";
import StreamControls from "../components/islands/StreamControls";
import PreviewTelemetry from "../components/islands/PreviewTelemetry";
import NoalbsToggle from "../components/islands/NoalbsToggle";
import SceneSwitcher from "../components/islands/SceneSwitcher";
import IngestStatsChart from "../components/islands/IngestStatsChart";
import IngestMenu from "../components/islands/IngestMenu";
import {
  getIngestProfiles,
  getObsStreamService,
  getObsStreamStatus,
  type IngestProfiles,
} from "../lib/api";
import { INGEST_RESERVED_LABEL } from "../lib/ingest";
import { useObsScenes } from "../lib/useObsScenes";
import { useNoalbs } from "../lib/useNoalbs";
import { mergeFeedList, useStatusUpdate } from "../lib/useStatusUpdate";
import { useIngestControls } from "../lib/useIngestControls";
import { Link } from "react-router";

const WIZARD_DISMISS_KEY = "oink-wizard-dismissed";

export default function Dashboard() {
  const obsScenes = useObsScenes();
  const noalbs = useNoalbs();
  const ingestStatus = useStatusUpdate();
  const [ingestProfiles, setIngestProfiles] = useState<IngestProfiles>({
    profiles: [],
    main: INGEST_RESERVED_LABEL,
  });
  const [selectedIngest, setSelectedIngest] = useState<string | null>(null);
  const [streamActive, setStreamActive] = useState(false);
  const [showWizard, setShowWizard] = useState(false);

  useEffect(() => {
    getIngestProfiles()
      .then(setIngestProfiles)
      .catch(() => {});
  }, []);

  const feeds = mergeFeedList(ingestStatus.ingests, ingestProfiles.profiles);
  const ingestControls = useIngestControls(feeds.map((f) => f.id));
  // Default the graph to whichever feed NOALBS is monitoring; the operator can
  // still pick any other feed explicitly.
  const effectiveIngest =
    selectedIngest && feeds.some((f) => f.id === selectedIngest)
      ? selectedIngest
      : feeds.some((f) => f.id === ingestProfiles.main)
        ? ingestProfiles.main
        : ingestStatus.mainIngestId ?? feeds[0]?.id ?? null;
  const selectedSeries = feeds.find((f) => f.id === effectiveIngest) ?? null;

  useEffect(() => {
    document.querySelectorAll<HTMLAnchorElement>('a[data-external="true"]').forEach((a) => {
      // Same-origin: nginx proxies the full Remote OBS client at /remote/.
      a.href = '/remote/';
    });
  }, []);

  const checkStream = useCallback(async () => {
    try {
      const status = await getObsStreamStatus();
      setStreamActive(status.outputActive);
    } catch {
      setStreamActive(false);
    }
  }, []);

  useEffect(() => {
    void checkStream();
    const interval = setInterval(() => void checkStream(), 2500);
    return () => clearInterval(interval);
  }, [checkStream]);

  useEffect(() => {
    if (localStorage.getItem(WIZARD_DISMISS_KEY) === "1") return;
    void getObsStreamService()
      .then((svc) => {
        if (!svc.keyLast4) setShowWizard(true);
      })
      .catch(() => {});
  }, []);

  const dismissWizard = () => {
    localStorage.setItem(WIZARD_DISMISS_KEY, "1");
    setShowWizard(false);
  };

  return (
    <div className="space-y-6">
      {showWizard && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg bg-primary/10 p-4 ring-1 ring-inset ring-primary/30">
          <div>
            <p className="text-sm font-semibold tracking-tight text-text-primary">
              No stream key configured
            </p>
            <p className="mt-0.5 text-[13px] text-text-secondary">
              Add a stream key to start broadcasting. Set your destination in Settings.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="/settings"
              className="rounded-control bg-primary px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-primary-hover"
            >
              Set up stream key
            </Link>
            <button
              type="button"
              onClick={dismissWizard}
              className="rounded-control px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Dashboard</h2>
          <p className="mt-0.5 text-sm text-text-secondary">
            Live view, stream health, and remote control at a glance.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <NoalbsToggle
            running={noalbs.running}
            pending={noalbs.pending}
            error={noalbs.error}
            onToggle={noalbs.toggle}
          />
          <StreamControls />
        </div>
      </div>

      <div
        className="grid grid-cols-2 gap-3 sm:gap-4"
        data-testid="stat-grid"
      >
        <div className="surface surface-hover p-4">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-text-faint">
            Stream State
          </p>
          <p className="mt-2 flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <span className={`h-2 w-2 rounded-full ${streamActive ? "bg-success" : "bg-warning"}`}></span>
            <span className="tabular">{streamActive ? "Live" : "Offline"}</span>
          </p>
        </div>

        <div className="surface surface-hover p-4">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-text-faint">
            Active Scene
          </p>
          <p className="mt-2 flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <span className="h-2 w-2 rounded-full bg-warning"></span>
            <span className="tabular">
              {obsScenes.current || "—"}
            </span>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="surface lg:col-span-2 p-5">
          <div className="flex items-center justify-between pb-4">
            <div>
              <h3 className="text-sm font-semibold tracking-tight">OBS Output Monitor</h3>
              <p className="mt-0.5 text-[13px] text-text-secondary">
                Preview of the encoder output.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a
                href="/preview"
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1.5 rounded-control bg-primary px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-primary-hover"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                </svg>
                Full Screen Preview
              </a>
              <a
                href="#"
                data-external="true"
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1.5 rounded-control bg-bg-card px-3 py-1.5 text-xs font-medium text-text-primary ring-1 ring-inset ring-border-subtle transition-colors hover:bg-bg-elevated hover:ring-border"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
                </svg>
                OBS Remote
              </a>
            </div>
          </div>
          <div className="relative w-full overflow-hidden rounded-lg bg-black ring-1 ring-inset ring-border-subtle" style={{ aspectRatio: "16/9" }}>
            <PreviewFrame
              title="OBS Preview"
              wrapperClass="absolute inset-0"
            />
          </div>
          <PreviewTelemetry bitrate={selectedSeries?.bitrate ?? null} />
        </div>

        <div className="space-y-6">
          <div className="surface p-5">
            <h3 className="text-sm font-semibold tracking-tight">Scenes</h3>
            <p className="mt-0.5 text-[13px] text-text-secondary">
              Switch the active OBS scene.
            </p>
            <div className="mt-4">
              <SceneSwitcher
                {...obsScenes}
                managedScenes={noalbs.managedScenes}
                managedActive={noalbs.active}
              />
            </div>
          </div>

          <div className="surface p-5">
            <h3 className="text-sm font-semibold tracking-tight">Ingests</h3>
            <p className="mt-0.5 text-[13px] text-text-secondary">
              Feeds published from ingests.
            </p>
            <div className="mt-4">
              <IngestMenu
                ingests={feeds}
                selected={effectiveIngest}
                monitored={ingestProfiles.main}
                onSelect={setSelectedIngest}
                connected={ingestStatus.connected}
                controls={ingestControls.state}
                pending={ingestControls.pending}
                onToggleMute={ingestControls.toggleMute}
                onToggleVisibility={ingestControls.toggleVisibility}
                onRestart={ingestControls.restart}
              />
              {ingestControls.error && (
                <p className="mt-2 text-xs text-danger" role="alert" aria-live="polite">
                  {ingestControls.error}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="surface p-5">
        <div className="flex items-center justify-between pb-4">
          <div>
            <h3 className="text-sm font-semibold tracking-tight">Ingest Statistics</h3>
            <p className="mt-0.5 text-[13px] text-text-secondary">
              Ingest bitrate over time.
            </p>
          </div>
        </div>
        <IngestStatsChart
          series={selectedSeries}
          low={ingestStatus.latest?.low ?? null}
          offline={ingestStatus.latest?.offline ?? null}
          connected={ingestStatus.connected}
        />
      </div>
    </div>
  );
}
