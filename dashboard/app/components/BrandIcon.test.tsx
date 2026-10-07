// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import BrandIcon from './BrandIcon';

describe('BrandIcon', () => {
  it('renders the white and black icon marks', () => {
    const { container } = render(<BrandIcon className="h-6 w-6" />);
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(2);
    expect(imgs[0]).toHaveAttribute('src', '/branding/oink-icon-white.png');
    expect(imgs[1]).toHaveAttribute('src', '/branding/oink-icon-black.png');
  });

  it('renders the logo variant when requested', () => {
    const { container } = render(<BrandIcon variant="logo" className="h-9 w-auto" />);
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(2);
    expect(imgs[0]).toHaveAttribute('src', '/branding/oink-logo-white.png');
    expect(imgs[1]).toHaveAttribute('src', '/branding/oink-logo-black.png');
    for (const img of imgs) {
      expect(img).toHaveAttribute('alt', '');
      expect(img).toHaveAttribute('aria-hidden', 'true');
    }
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
