// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CustomOverlayForm from './CustomOverlayForm';

const mocks = vi.hoisted(() => ({
  provision: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  provisionObsBrowserSource: mocks.provision,
  deleteObsBrowserSource: mocks.remove,
}));

function mockLocalStorage(config: Partial<CustomOverlayConfig> = {}) {
  const store = new Map<string, string>();
  if (Object.keys(config).length > 0) {
    store.set(
      'oink_custom_overlay_config',
      JSON.stringify(config),
    );
  }
  Object.defineProperty(window, 'localStorage', {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
    configurable: true,
  });
  return store;
}

interface CustomOverlayConfig {
  sourceName: string;
  url: string;
  scenes: string[];
  rerouteAudio: boolean;
}

describe('CustomOverlayForm', () => {
  beforeEach(() => {
    mocks.provision.mockReset().mockResolvedValue(undefined);
    mocks.remove.mockReset().mockResolvedValue(undefined);
    mockLocalStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders source fields with defaults', () => {
    render(<CustomOverlayForm />);
    expect(screen.getByText('Source')).toBeInTheDocument();
    expect(screen.getByLabelText('OBS source name')).toHaveValue('custom_overlay');
    expect(screen.getByLabelText('Reroute audio')).toBeChecked();
    expect(screen.getByLabelText('OBS Source URL')).toHaveValue('');
  });

  it('renders scene targets with defaults', () => {
    render(<CustomOverlayForm />);
    expect(screen.getByRole('heading', { name: 'Target scenes' })).toBeInTheDocument();

    const brb = document.querySelector<HTMLInputElement>('input[name="scene-brb"]');
    expect(brb).not.toBeNull();
    expect(brb!.checked).toBe(true);

    const lowBr = document.querySelector<HTMLInputElement>('input[name="scene-low-br"]');
    expect(lowBr).not.toBeNull();
    expect(lowBr!.checked).toBe(true);

    const offline = document.querySelector<HTMLInputElement>('input[name="scene-offline"]');
    expect(offline).not.toBeNull();
    expect(offline!.checked).toBe(false);
  });

  it('updates source name, url, and reroute audio in config', async () => {
    const user = userEvent.setup();
    render(<CustomOverlayForm />);

    const name = screen.getByLabelText('OBS source name');
    await user.clear(name);
    await user.type(name, 'my_custom_overlay');

    const audio = screen.getByLabelText('Reroute audio');
    await user.click(audio);

    const url = screen.getByLabelText('OBS Source URL');
    await user.type(url, 'https://example.com/overlay');

    expect(name).toHaveValue('my_custom_overlay');
    expect(audio).not.toBeChecked();
    expect(url).toHaveValue('https://example.com/overlay');
  });

  it('renders a Preview link and Copy button', () => {
    render(<CustomOverlayForm />);
    expect(screen.getByRole('button', { name: 'Copy URL' })).toBeInTheDocument();
  });

  it('enables Apply when a URL is provided', async () => {
    const user = userEvent.setup();
    render(<CustomOverlayForm />);
    expect(screen.getByRole('button', { name: /Apply to OBS/i })).toBeDisabled();

    const url = screen.getByLabelText('OBS Source URL');
    await user.type(url, 'https://example.com/overlay');
    expect(screen.getByRole('button', { name: /Apply to OBS/i })).not.toBeDisabled();
  });

  it('applies the custom overlay to selected scenes', async () => {
    const user = userEvent.setup();
    render(<CustomOverlayForm />);

    const url = screen.getByLabelText('OBS Source URL');
    await user.type(url, 'https://example.com/overlay');

    await user.click(screen.getByRole('button', { name: /Apply to OBS/i }));

    expect(mocks.provision).toHaveBeenCalledWith(
      'custom_overlay',
      'https://example.com/overlay',
      ['brb', 'low-br'],
      true,
    );
  });

  it('uses custom source name and audio setting when applying', async () => {
    const user = userEvent.setup();
    render(<CustomOverlayForm />);

    const name = screen.getByLabelText('OBS source name');
    await user.clear(name);
    await user.type(name, 'my_overlay');

    const audio = screen.getByLabelText('Reroute audio');
    await user.click(audio);

    const url = screen.getByLabelText('OBS Source URL');
    await user.type(url, 'https://example.com/overlay');

    await user.click(screen.getByRole('button', { name: /Apply to OBS/i }));

    expect(mocks.provision).toHaveBeenCalledWith(
      'my_overlay',
      'https://example.com/overlay',
      ['brb', 'low-br'],
      false,
    );
  });

  it('removes the custom overlay from OBS', async () => {
    const user = userEvent.setup();
    render(<CustomOverlayForm />);

    await user.click(screen.getByRole('button', { name: 'Remove from OBS' }));

    expect(mocks.remove).toHaveBeenCalledWith('custom_overlay');
  });

  });
