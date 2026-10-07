// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { UseObsScenesResult } from '../../lib/useObsScenes';
import SceneSwitcher from './SceneSwitcher';

function props(
  overrides: Partial<UseObsScenesResult> = {},
): UseObsScenesResult {
  return {
    scenes: ['main', 'brb', 'offline'],
    current: 'main',
    loading: false,
    error: null,
    pending: null,
    switchScene: vi.fn(),
    ...overrides,
  };
}

describe('SceneSwitcher', () => {
  it('renders a button per scene and highlights the active one', () => {
    render(<SceneSwitcher {...props()} />);

    expect(screen.getByRole('button', { name: 'main' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'brb' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('button', { name: 'offline' })).toBeInTheDocument();
  });

  it('shows the current scene in a badge', () => {
    render(<SceneSwitcher {...props()} />);
    expect(screen.getByText('main', { selector: 'span' })).toBeInTheDocument();
  });

  it('calls switchScene with the clicked scene', async () => {
    const switchScene = vi.fn();
    const user = userEvent.setup();
    render(<SceneSwitcher {...props({ switchScene })} />);

    await user.click(screen.getByRole('button', { name: 'brb' }));
    expect(switchScene).toHaveBeenCalledWith('brb');
  });

  it('disables all buttons and labels the pending scene while switching', () => {
    render(<SceneSwitcher {...props({ pending: 'brb' })} />);

    expect(screen.getByRole('button', { name: 'Switching…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'main' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'offline' })).toBeDisabled();
  });

  it('shows an error message when present', () => {
    render(<SceneSwitcher {...props({ error: 'OBS down' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('OBS down');
  });

  it('marks managed scenes with a robot icon, dimmed when NOALBS is off', () => {
    render(
      <SceneSwitcher
        {...props()}
        managedScenes={['main', 'low-br', 'offline']}
        managedActive={false}
      />,
    );

    expect(
      within(screen.getByRole('button', { name: 'main' })).getByTestId(
        'robot-badge',
      ),
    ).toHaveClass('opacity-50');
    expect(
      within(screen.getByRole('button', { name: 'offline' })).getByTestId(
        'robot-badge',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('button', { name: 'brb' })).queryByTestId(
        'robot-badge',
      ),
    ).toBeNull();
  });

  it('shows managed robot icons un-dimmed when NOALBS is active', () => {
    render(
      <SceneSwitcher {...props()} managedScenes={['main']} managedActive />,
    );

    expect(
      within(screen.getByRole('button', { name: 'main' })).getByTestId(
        'robot-badge',
      ),
    ).not.toHaveClass('opacity-50');
  });

  it('renders no robot icons when no managed scenes are supplied', () => {
    render(<SceneSwitcher {...props()} />);
    expect(screen.queryByTestId('robot-badge')).toBeNull();
  });

  it('renders a loading state when scenes have not loaded yet', () => {
    render(<SceneSwitcher {...props({ scenes: [], loading: true })} />);
    expect(screen.getByText('Loading scenes…')).toBeInTheDocument();
  });

  it('renders an empty state when there are no scenes', () => {
    render(<SceneSwitcher {...props({ scenes: [], loading: false })} />);
    expect(screen.getByText(/No scenes available/)).toBeInTheDocument();
  });
});
