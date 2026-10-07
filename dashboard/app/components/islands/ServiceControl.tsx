"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useCallback } from 'react';
import {
  getServiceStatus,
  serviceAction,
  getServiceConfig,
  saveServiceConfig,
} from '../../lib/api';
import { useIntervalPolling } from '../../lib/useIntervalPolling';

interface ServiceControlProps {
  service: string;
  label: string;
  configurable?: boolean;
}

export default function ServiceControl({ service, label, configurable = false }: ServiceControlProps) {
  const [running, setRunning] = useState<boolean | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [configContent, setConfigContent] = useState('');
  const [configFile, setConfigFile] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkStatus = useCallback(async () => {
    try {
      const { running } = await getServiceStatus(service);
      setRunning(running);
    } catch {
      setRunning(null);
    }
  }, [service]);

  useIntervalPolling(checkStatus, 10000);

  async function doAction(action: 'start' | 'stop' | 'restart') {
    setAction(action);
    setError(null);
    try {
      await serviceAction(service, action);
      await checkStatus();
    } catch (e: any) {
      setError(e.message);
    }
    setAction(null);
  }

  async function loadConfig() {
    try {
      const { content, file } = await getServiceConfig(service);
      setConfigContent(content);
      setConfigFile(file);
      setShowEditor(true);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function saveConfig() {
    if (!window.confirm(`Overwrite ${label} config? The service will be restarted.`)) return;
    setSaving(true);
    setError(null);
    try {
      await saveServiceConfig(service, configContent);
      setShowEditor(false);
      await checkStatus();
    } catch (e: any) {
      setError(e.message);
    }
    setSaving(false);
  }

  return (
    <div className="flex items-center gap-2">
      {/* Status indicator */}
      <div className={`w-2 h-2 rounded-full ${
        running === true ? 'bg-success' :
        running === false ? 'bg-danger' :
        'bg-yellow-500'
      }`} />

      {/* Start/Stop/Restart buttons */}
      {running === true ? (
        <>
          <button
            onClick={() => doAction('stop')}
            disabled={!!action}
            className="px-2 py-1 text-xs rounded bg-danger/20 text-danger border border-danger/30 hover:bg-danger/30 disabled:opacity-50 transition-colors"
          >
            {action === 'stop' ? 'Stopping...' : 'Stop'}
          </button>
          <button
            onClick={() => doAction('restart')}
            disabled={!!action}
            className="px-2 py-1 text-xs rounded bg-yellow-500/20 text-yellow-500 border border-yellow-500/30 hover:bg-yellow-500/30 disabled:opacity-50 transition-colors"
          >
            {action === 'restart' ? 'Restarting...' : 'Restart'}
          </button>
        </>
      ) : running === false ? (
        <button
          onClick={() => doAction('start')}
          disabled={!!action}
          className="px-2 py-1 text-xs rounded bg-success/20 text-success border border-success/30 hover:bg-success/30 disabled:opacity-50 transition-colors"
        >
          {action === 'start' ? 'Starting...' : 'Start'}
        </button>
      ) : (
        <span className="text-xs text-text-secondary">Loading...</span>
      )}

      {/* Edit config button */}
      {configurable && (
        <button
          onClick={loadConfig}
          className="px-2 py-1 text-xs rounded bg-bg-card border border-border text-text-secondary hover:text-text-primary hover:bg-primary/20 transition-colors"
        >
          Edit Config
        </button>
      )}

      {/* Error */}
      {error && (
        <span className="text-xs text-danger ml-2">{error}</span>
      )}

      {/* Config editor modal */}
      {showEditor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-bg-card rounded-xl border border-border w-full max-w-3xl max-h-[80vh] flex flex-col mx-4">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div>
                <h3 className="font-medium">Edit {label} Config</h3>
                <span className="text-xs text-text-secondary">{configFile}</span>
              </div>
              <button
                onClick={() => setShowEditor(false)}
                className="text-text-secondary hover:text-text-primary text-lg"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-hidden p-4">
              {configContent.includes('<redacted>') && (
                <div className="mb-2 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-xs text-yellow-500">
                  Secret values are shown as <code className="text-yellow-300">&lt;redacted&gt;</code> and are
                  preserved on save unless you replace them with a new value.
                </div>
              )}
              <textarea
                value={configContent}
                onChange={(e) => setConfigContent(e.target.value)}
                className="w-full h-96 bg-black text-text-secondary font-mono text-xs p-4 rounded-lg border border-border resize-none focus:outline-none focus:border-primary"
                spellCheck={false}
              />
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
              <button
                onClick={() => setShowEditor(false)}
                className="px-4 py-2 text-sm rounded-lg border border-border text-text-secondary hover:text-text-primary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveConfig}
                disabled={saving}
                className="px-4 py-2 text-sm rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-50 transition-colors"
              >
                {saving ? 'Saving...' : 'Save & Close'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
