// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
(function () {
	var owner = document.body.getAttribute('data-owner');
	var repo = document.body.getAttribute('data-repo');
	var starsEl = document.querySelector('[data-stars]');
	var fmt = function (n) {
		return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
	};
	if (owner && starsEl) {
		fetch('https://api.github.com/repos/' + owner + '/' + repo)
			.then(function (r) { return r.ok ? r.json() : null; })
			.then(function (d) {
				if (d && typeof d.stargazers_count === 'number') starsEl.textContent = fmt(d.stargazers_count);
			})
			.catch(function () {});
	}
	var copyBtn = document.querySelector('[data-copy]');
	if (copyBtn && navigator.clipboard) {
		var cmd = copyBtn.getAttribute('data-copy');
		copyBtn.addEventListener('click', function () {
			navigator.clipboard.writeText(cmd).then(function () {
				var prev = copyBtn.textContent;
				copyBtn.textContent = 'Copied';
				setTimeout(function () { copyBtn.textContent = prev; }, 1600);
			});
		});
	}
	var themeBtn = document.querySelector('[data-theme-toggle]');
	if (themeBtn) {
		var syncPressed = function () {
			themeBtn.setAttribute(
				'aria-pressed',
				document.documentElement.dataset.theme === 'light' ? 'true' : 'false'
			);
		};
		syncPressed();
		themeBtn.addEventListener('click', function () {
			var next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
			document.documentElement.dataset.theme = next;
			try { localStorage.setItem('starlight-theme', next); } catch (e) {}
			syncPressed();
		});
	}
})();
