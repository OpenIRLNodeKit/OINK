// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PreviewFrame from './PreviewFrame';

const requestFullscreen = vi.fn();
const exitFullscreen = vi.fn();

function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    value,
    configurable: true,
  });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  requestFullscreen.mockReset().mockResolvedValue(undefined);
  exitFullscreen.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(document, 'fullscreenEnabled', {
    value: true,
    configurable: true,
  });
  Object.defineProperty(document, 'fullscreenElement', {
    value: null,
    configurable: true,
  });
  Object.defineProperty(document, 'exitFullscreen', {
    value: exitFullscreen,
    configurable: true,
  });
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
    value: requestFullscreen,
    configurable: true,
  });
});

describe('PreviewFrame', () => {
  it('renders the MJPEG preview as a same-origin <img>', () => {
    const { container } = render(
      <PreviewFrame title="OBS Preview" wrapperClass="" />,
    );
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/preview/stream');
    expect(img?.getAttribute('alt')).toBe('OBS Preview');
  });

  it('shows the connecting overlay until the first frame loads', () => {
    render(<PreviewFrame title="OBS Preview" wrapperClass="" />);
    expect(screen.getByText(/Connecting to preview feed/)).toBeInTheDocument();
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument();
  });

  it('detaches the stream while the tab is hidden and reattaches on return', () => {
    const { container } = render(
      <PreviewFrame title="OBS Preview" wrapperClass="" />,
    );
    const src = () => container.querySelector('img')?.getAttribute('src');
    expect(src()).toBe('/api/preview/stream');

    setVisibility('hidden');
    expect(src()).toBeNull();

    setVisibility('visible');
    expect(src()).toBe('/api/preview/stream');
  });

  it('does not render a fullscreen toggle unless asked', () => {
    render(<PreviewFrame title="OBS Preview" wrapperClass="" />);
    expect(
      screen.queryByRole('button', { name: /fullscreen/i }),
    ).not.toBeInTheDocument();
  });

  it('hides the fullscreen toggle when the browser does not support it', async () => {
    Object.defineProperty(document, 'fullscreenEnabled', {
      value: false,
      configurable: true,
    });
    render(<PreviewFrame title="OBS Preview" wrapperClass="" fullscreen />);
    await act(async () => {});
    expect(
      screen.queryByRole('button', { name: /fullscreen/i }),
    ).not.toBeInTheDocument();
  });

  it('enters and exits fullscreen from the /preview toggle', async () => {
    const { container } = render(
      <PreviewFrame title="OBS Preview" wrapperClass="" fullscreen />,
    );
    const enter = await screen.findByRole('button', {
      name: 'Enter fullscreen',
    });

    fireEvent.click(enter);
    expect(requestFullscreen).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'fullscreenElement', {
      value: container.firstChild,
      configurable: true,
    });
    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    const exit = screen.getByRole('button', { name: 'Exit fullscreen' });
    expect(exit).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(exit);
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
  });
});
