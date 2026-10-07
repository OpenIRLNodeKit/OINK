// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Content-Security-Policy, shared by the landing page and Starlight docs head.
// 'unsafe-inline' (scripts/styles) and 'wasm-unsafe-eval' are required: Starlight
// emits inline scripts and Pagefind uses a Worker + WASM. Served via <meta>, which
// is the only option on GitHub Pages; note meta CSP ignores frame-ancestors and
// cannot report. Real header enforcement needs a host that can send headers.
export const CSP = [
	"default-src 'self'",
	"script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"font-src 'self' data:",
	"connect-src 'self' https://api.github.com",
	"worker-src 'self' blob:",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
].join('; ');
