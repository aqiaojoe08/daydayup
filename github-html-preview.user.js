// ==UserScript==
// @name         GitHub HTML Preview
// @namespace    yuliang.userscripts
// @version      1.4.0
// @description  Adds a Preview button to GitHub file pages for HTML blobs (.htm, .html, .xhtml, .shtml, ...), opening the rendered page on htmlpreview.github.io (Alt-click for raw.githack.com) instead of the HTML source.
// @author       yuliang
// @match        https://github.com/*/*/blob/*
// @grant        none
// @downloadURL  https://github.com/aqiaojoe08/daydayup/raw/refs/heads/main/github-html-preview.user.js
// @updateURL    https://github.com/aqiaojoe08/daydayup/raw/refs/heads/main/github-html-preview.user.js
// ==/UserScript==
(function () {
    'use strict';

    const BTN_ID = 'gmGithubHtmlPreview';
    // The HTML test lives here rather than in @match on purpose. Managers disagree about whether a
    // * in the middle of a path crosses a / — Greasemonkey is the unreliable one — and @match is
    // evaluated only when the document loads, so a filename-specific pattern also misses files
    // reached by GitHub's client-side navigation. @match stays coarse; this decides.
    // Matches .htm plus any extension ending in html: .html, .xhtml, .shtml, .phtml.
    const PREVIEWABLE = /\.(?:htm|[^./]*html)$/i;

    // Both preview services fetch the file from raw.githubusercontent.com, so they only work
    // for public repos. Nothing here can fix that; the button just links out.
    const EYE = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">'
        + '<path d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.831.88 9.577.43 8.899a1.62 1.62 0 0 1 0-1.798c.45-.678 1.367-1.932 2.637-3.023C4.33 2.992 6.019 2 8 2Zm0 1.5c-1.51 0-2.879.755-4 1.72C2.89 6.176 2.11 7.24 1.68 7.887a.12.12 0 0 0 0 .226C2.11 8.76 2.89 9.824 4 10.78c1.121.965 2.49 1.72 4 1.72s2.879-.755 4-1.72c1.11-.956 1.89-2.02 2.32-2.667a.12.12 0 0 0 0-.226C14.89 7.24 14.11 6.176 13 5.22 11.879 4.255 10.51 3.5 9 3.5Zm0 1.5a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm0 1.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"></path></svg>';

    const BASE_STYLE = [
        'display:inline-flex',
        'align-items:center',
        'gap:6px',
        'height:28px',
        'padding:0 10px',
        'border-radius:6px',
        'cursor:pointer',
        'text-decoration:none',
        'white-space:nowrap',
        'font:600 12px/1 var(--fontStack-system, -apple-system, system-ui, "Segoe UI", sans-serif)',
        // GitHub defines these Primer variables per theme, so the button follows light/dark
        // without the script having to detect which one is active.
        'color:var(--button-default-fgColor-rest, var(--color-btn-text, #24292f))',
        'background:var(--button-default-bgColor-rest, var(--color-btn-bg, #f6f8fa))',
        'border:1px solid var(--button-default-borderColor-rest, var(--color-btn-border, rgba(31,35,40,.15)))'
    ].join(';');

    // A blob path is /<owner>/<repo>/blob/<ref>/<path>, and raw.githubusercontent.com uses the
    // same /<owner>/<repo>/<ref>/<path> layout, so the ref never has to be told apart from the
    // file path — branches with slashes in them come out right either way.
    function blobParts() {
        const seg = location.pathname.split('/').filter(Boolean);
        if (seg.length < 5 || seg[2] !== 'blob') return null;
        let rest = seg.slice(3);
        // GitHub links both /blob/main/x and the fully-qualified /blob/refs/heads/main/x; the
        // preview CDNs want the short form.
        if (rest[0] === 'refs' && (rest[1] === 'heads' || rest[1] === 'tags')) rest = rest.slice(2);
        if (rest.length < 2) return null;
        const file = decodeURIComponent(rest[rest.length - 1]);
        if (!PREVIEWABLE.test(file)) return null;
        return { owner: seg[0], repo: seg[1], path: rest.join('/') };
    }

    function urls(parts) {
        const tail = parts.owner + '/' + parts.repo + '/' + parts.path;
        return {
            // htmlpreview proxies the file and rewrites relative refs — best for a standalone page.
            htmlpreview: 'https://htmlpreview.github.io/?https://raw.githubusercontent.com/' + tail,
            // githack serves it from a CDN with the right content-type — best when the page
            // pulls in sibling assets.
            githack: 'https://raw.githack.com/' + tail
        };
    }

    // The toolbar next to Raw is the natural home, but its markup churns; when the anchor is
    // not found the button parks itself in the corner rather than disappearing.
    function mount(el) {
        const raw = document.querySelector('[data-testid="raw-button"], #raw-url, a[href*="raw.githubusercontent.com"]');
        const group = raw && (raw.closest('.react-blob-header-edit-and-raw-actions') || raw.closest('.BtnGroup') || raw.parentElement);
        if (group && group.parentElement) {
            el.style.cssText = BASE_STYLE + ';margin-right:8px';
            group.parentElement.insertBefore(el, group);
        } else {
            el.style.cssText = BASE_STYLE + ';position:fixed;right:16px;bottom:16px;height:32px;z-index:100;box-shadow:0 1px 3px rgba(0,0,0,.2)';
            document.body.appendChild(el);
        }
    }

    function add(parts) {
        const { htmlpreview, githack } = urls(parts);
        const a = document.createElement('a');
        a.id = BTN_ID;
        a.dataset.target = parts.path;
        a.href = htmlpreview;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = 'Open the rendered page (htmlpreview.github.io)\nAlt-click: raw.githack.com\nPublic repos only';
        a.innerHTML = EYE + '<span>Preview</span>';
        a.addEventListener('click', (e) => {
            if (!e.altKey) return; // a plain click just follows href
            e.preventDefault();
            window.open(githack, '_blank', 'noopener');
        });
        mount(a);
    }

    // @match only gates the page the script loads on. Once loaded, GitHub navigates without
    // reloading the document, so the button is reconciled against the current URL rather than
    // added once at start-up — that keeps it correct when a soft nav moves to another file.
    function sync() {
        const parts = blobParts();
        const existing = document.getElementById(BTN_ID);
        if (!parts) {
            if (existing) existing.remove();
            return;
        }
        if (existing && existing.dataset.target === parts.path) return;
        if (existing) existing.remove();
        add(parts);
    }

    let pending = 0;
    function schedule() {
        clearTimeout(pending);
        pending = setTimeout(sync, 200);
    }

    ['turbo:load', 'turbo:render', 'pjax:end', 'popstate'].forEach((evt) => {
        window.addEventListener(evt, schedule);
    });
    // Turbo re-renders the blob header on its own schedule and can drop the button after the
    // navigation events have already fired, so the DOM is watched as well.
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    schedule();
})();
