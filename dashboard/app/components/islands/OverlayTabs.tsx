"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react';
import CustomOverlayForm from './CustomOverlayForm';
import JstChatForm from './JstChatForm';
import TabBar from './TabBar';
import TwitchClipsPlayerForm from './TwitchClipsPlayerForm';

const TABS = [
  { key: 'twitch-clips', label: 'Twitch Clips' },
  { key: 'jst-chat', label: 'Chat' },
  { key: 'custom-url', label: 'Custom URL' },
];

export default function OverlayTabs() {
  const [active, setActive] = useState('twitch-clips');

  return (
    <div>
      <TabBar tabs={TABS} active={active} onChange={setActive} />
      <div role="tabpanel">
        {active === 'twitch-clips' && <TwitchClipsPlayerForm />}
        {active === 'jst-chat' && <JstChatForm />}
        {active === 'custom-url' && <CustomOverlayForm />}
      </div>
    </div>
  );
}
