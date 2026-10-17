"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react';
import { Link } from 'react-router';
import { useAuth, useHasRole } from '../../lib/auth-context';
import { Card } from '../ui';
import AccountProfileCard from './AccountProfileCard';
import BackupCard from './BackupCard';
import ChangePasswordCard from './ChangePasswordCard';
import ObsPluginsCard from './ObsPluginsCard';
import StreamKeysForm from './StreamKeysForm';
import StreamSettingsForm from './StreamSettingsForm';
import SwitcherConfigForm from './SwitcherConfigForm';
import TabBar from './TabBar';
import ThemeSelector from './ThemeSelector';
import UsersManagementCard from './UsersManagementCard';

export default function SettingsTabs() {
  const { enabled } = useAuth();
  const isAdmin = useHasRole(['admin']);
  const canOperate = useHasRole(['admin', 'operator']);

  const generalPanel = (
    <>
      <Card
        title="Appearance"
        description="Choose the accent and surface palette for the control room."
      >
        <div className="flex items-center gap-4">
          <ThemeSelector />
        </div>
      </Card>

      {canOperate && (
        <Card
          title="Stream Settings"
          description="Encoder, resolution, framerate, and bitrate."
        >
          <StreamSettingsForm />
        </Card>
      )}

      {canOperate && <ObsPluginsCard />}

      {canOperate && (
        <Card
          title="Stream Keys"
          description="Pick the destination for OBS's built-in output (primary) and set stream keys for all platforms."
        >
          <StreamKeysForm />
        </Card>
      )}

      {isAdmin && (
        <Card
          title="Auto Scene Switcher"
          description="Automatically switch OBS scenes based on your stream health."
        >
          <SwitcherConfigForm />
        </Card>
      )}

      {isAdmin && <BackupCard />}

      {canOperate && (
        <div className="surface flex items-center justify-between gap-4 p-5">
          <div>
            <h3 className="text-sm font-semibold tracking-tight">Advanced</h3>
            <p className="mt-0.5 text-[13px] leading-relaxed text-text-secondary">
              Live logs, service controls, and config editing.
            </p>
          </div>
          <Link
            to="/advanced"
            className="shrink-0 rounded-control bg-primary px-3 py-1.5 text-xs font-medium text-on-primary shadow-sm transition-colors hover:bg-primary-hover"
          >
            Open Advanced
          </Link>
        </div>
      )}

      {!canOperate && (
        <p className="text-[13px] leading-relaxed text-text-secondary">
          Viewer accounts have read-only access — configuration and control are
          limited to operators and admins.
        </p>
      )}
    </>
  );

  const tabs = [
    { key: 'general', label: 'General', panel: generalPanel },
    ...(enabled
      ? [
          { key: 'account', label: 'Account', panel: <><AccountProfileCard /><ChangePasswordCard /></> },
          ...(isAdmin
            ? [
                {
                  key: 'users',
                  label: 'Users & Access',
                  panel: <UsersManagementCard />,
                },
              ]
            : []),
        ]
      : []),
  ];

  const [active, setActive] = useState(tabs[0].key);

  if (tabs.length < 2) {
    return <div className="space-y-6">{tabs[0].panel}</div>;
  }

  return (
    <div>
      <TabBar tabs={tabs} active={active} onChange={setActive} />
      <div role="tabpanel" className="space-y-6">
        {tabs.find((tab) => tab.key === active)?.panel ?? tabs[0].panel}
      </div>
    </div>
  );
}
