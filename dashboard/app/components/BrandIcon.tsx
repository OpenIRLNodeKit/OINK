// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
type BrandVariant = 'icon' | 'logo';

const SOURCES: Record<BrandVariant, { dark: string; light: string }> = {
  icon: {
    dark: '/branding/oink-icon-white.png',
    light: '/branding/oink-icon-black.png',
  },
  logo: {
    dark: '/branding/oink-logo-white.png',
    light: '/branding/oink-logo-black.png',
  },
};

interface BrandIconProps {
  className?: string;
  variant?: BrandVariant;
}

export default function BrandIcon({
  className = '',
  variant = 'icon',
}: BrandIconProps) {
  const src = SOURCES[variant];
  return (
    <>
      <img
        src={src.dark}
        alt=""
        aria-hidden="true"
        className={`brand-icon-dark ${className}`}
      />
      <img
        src={src.light}
        alt=""
        aria-hidden="true"
        className={`brand-icon-light ${className}`}
      />
    </>
  );
}
