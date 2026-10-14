// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
export interface NoalbsSwitcherConfig {
  bitrateSwitcherEnabled: boolean;
  triggers: {
    low: number;
    offline: number;
  };
  switchingScenes: {
    normal?: string;
    low?: string;
    offline?: string;
  };
}

export interface NoalbsConfig {
  switcher?: Partial<NoalbsSwitcherConfig>;
  [key: string]: unknown;
}

export interface IngestInfo {
  key: string;
  defaultPath: string;
  createdAt: number;
  updatedAt: number;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  error?: string;
  content?: T;
}

export interface StreamStatus {
  outputActive: boolean;
  outputTimecode: string;
  outputDuration: number;
  outputBytes: number;
  outputSkippedFrames: number;
  outputTotalFrames: number;
}

export interface RecordStatus {
  outputActive: boolean;
  outputTimecode: string;
  outputDuration: number;
  outputBytes: number;
  outputPaused: boolean;
}
