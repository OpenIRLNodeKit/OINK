// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PreviewFrame from './PreviewFrame';

function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value, configurable: true });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

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
});
