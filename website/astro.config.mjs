// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { CSP } from './src/data/csp.mjs';

// Custom apex domain (openirlnodekit.com) served at root. SITE_URL is the
// single source of truth (set by the deploy workflow).
export default defineConfig({
	site: process.env.SITE_URL ?? 'https://openirlnodekit.com/',
	base: '/',
	integrations: [
		starlight({
			title: 'OpenIRLNodeKit',
			logo: {
				dark: './src/assets/logo-white.png',
				light: './src/assets/logo-black.png',
				alt: 'OpenIRLNodeKit',
				replacesTitle: true,
			},
			description: 'Self-hosted IRL streaming node — headless OBS, remote desktop, live preview.',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/OpenIRLNodeKit/OINK' },
			],
			components: {
				Footer: './src/components/Footer.astro',
				PageFrame: './src/components/PageFrame.astro',
			},
			customCss: ['./src/styles/starlight-theme.css'],
			pagination: false,
			favicon: '/favicon-black.png',
			head: [
				{
					tag: 'meta',
					attrs: {
						'http-equiv': 'Content-Security-Policy',
						content: CSP,
					},
				},
				{
					tag: 'link',
					attrs: {
						rel: 'icon',
						type: 'image/png',
						href: '/favicon-white.png',
						media: '(prefers-color-scheme: dark)',
					},
				},
				{
					tag: 'link',
					attrs: {
						rel: 'icon',
						type: 'image/png',
						href: '/favicon-black.png',
						media: '(prefers-color-scheme: light)',
					},
				},
			],
			// Folders become groups, files auto-appear. ReadTheDocs style.
			sidebar: [
				{ label: 'Documentation', link: '/documentation/' },
				{ label: 'Admin guides', items: [{ autogenerate: { directory: 'admin-guides' } }] },
				{ label: 'User Guides', items: [{ autogenerate: { directory: 'user-guides' } }] },
			],
		}),
	],
});
