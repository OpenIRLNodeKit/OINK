// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
interface TabBarProps {
  tabs: Array<{ key: string; label: string }>;
  active: string;
  onChange: (key: string) => void;
  className?: string;
}

export default function TabBar({
  tabs,
  active,
  onChange,
  className = '',
}: TabBarProps) {
  return (
    <div
      className={`mb-4 flex gap-1 border-b border-border-subtle ${className}`}
      role="tablist"
    >
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          onClick={() => onChange(tab.key)}
          aria-selected={active === tab.key}
          role="tab"
          className={`-mb-px px-4 py-2 text-sm font-medium transition-colors ${
            active === tab.key
              ? 'border-b-2 border-primary text-primary'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
