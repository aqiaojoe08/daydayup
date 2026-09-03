// ==UserScript==
// @name         GitHub HTML Preview
// @namespace    yuliang.userscripts
// @version      1.5.0
// @description  Jumps both ways between a GitHub HTML blob and its rendered copy: a Preview button on the blob page (htmlpreview.github.io, Alt-click for raw.githack.com), and an Edit on GitHub button on the rendered page that opens the file in GitHub's editor.
// @author       yuliang
// @match        https://github.com/*/*/blob/*
// @match        https://htmlpreview.github.io/*
// @match        https://raw.githack.com/*
// @match        https://rawcdn.githack.com/*
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

    // Both preview services fetch the file from raw.githubusercontent.com, so they only work for
    // public repos. Nothing here can fix that; the buttons just link out.
    const EYE = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">'
        + '<path d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.831.88 9.577.43 8.899a1.62 1.62 0 0 1 0-1.798c.45-.678 1.367-1.932 2.637-3.023C4.33 2.992 6.019 2 8 2Zm0 1.5c-1.51 0-2.879.755-4 1.72C2.89 6.176 2.11 7.24 1.68 7.887a.12.12 0 0 0 0 .226C2.11 8.76 2.89 9.824 4 10.78c1.121.965 2.49 1.72 4 1.72s2.879-.755 4-1.72c1.11-.956 1.89-2.02 2.32-2.667a.12.12 0 0 0 0-.226C14.89 7.24 14.11 6.176 13 5.22 11.879 4.255 10.51 3.5 9 3.5Zm0 1.5a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm0 1.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"></path></svg>';
    const PENCIL = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">'
        + '<path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"></path></svg>';

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
        // GitHub defines these Primer variables per theme, so the button follows light/dark without
        // the script having to detect which one is active. On a rendered page they are absent and
        // the literal fallbacks apply.
        'color:var(--button-default-fgColor-rest, var(--color-btn-text, #24292f))',
        'background:var(--button-default-bgColor-rest, var(--color-btn-bg, #f6f8fa))',
        'border:1px solid var(--button-default-borderColor-rest, var(--color-btn-border, rgba(31,35,40,.15)))'
    ].join(';');

    // GitHub links both /blob/main/x and the fully-qualified /blob/refs/heads/main/x; the preview
    // CDNs and the editor both want the short ref.
    function shortRef(seg) {
        return (seg[0] === 'refs' && (seg[1] === 'heads' || seg[1] === 'tags')) ? seg.slice(2) : seg;
    }

    function isHtml(seg) {
        try {
            return PREVIEWABLE.test(decodeURIComponent(seg[seg.length - 1] || ''));
        } catch (e) {
            return PREVIEWABLE.test(seg[seg.length - 1] || ''); // stray % in the name
        }
    }

    function parseUrl(s) {
        try {
            return new URL(s);
        } catch (e) {
            return null;
        }
    }

    // On a GitHub blob page, point at the rendered copies. A blob path is
    // /<owner>/<repo>/blob/<ref>/<path> and raw.githubusercontent.com uses the same
    // /<owner>/<repo>/<ref>/<path> layout, so the ref never has to be told apart from the file
    // path — branches with slashes in them come out right either way.
    function previewTarget() {
        if (location.hostname !== 'github.com') return null;
        const seg = location.pathname.split('/').filter(Boolean);
        if (seg.length < 5 || seg[2] !== 'blob') return null;
        const rest = shortRef(seg.slice(3));
        if (rest.length < 2 || !isHtml(rest)) return null;
        const tail = seg[0] + '/' + seg[1] + '/' + rest.join('/');
        return {
            key: 'preview:' + tail,
            icon: EYE,
            label: 'Preview',
            title: 'Open the rendered page (htmlpreview.github.io)\nAlt-click: raw.githack.com\nPublic repos only',
            // htmlpreview proxies the file and rewrites relative refs — best for a standalone page.
            href: 'https://htmlpreview.github.io/?https://raw.githubusercontent.com/' + tail,
            // githack serves it from a CDN with the right content-type — best when the page pulls in
            // sibling assets.
            altHref: 'https://raw.githack.com/' + tail
        };
    }

    // On a rendered page, point back at GitHub's editor: htmlpreview carries the source URL in its
    // query string, and githack mirrors raw.githubusercontent.com's path.
    function editTarget() {
        let seg;
        if (location.hostname === 'htmlpreview.github.io') {
            const q = location.search.replace(/^\?/, '');
            let decoded = q;
            try {
                decoded = decodeURIComponent(q);
            } catch (e) { /* keep the raw form */ }
            const url = parseUrl(q) || parseUrl(decoded);
            if (!url) return null;
            seg = url.pathname.split('/').filter(Boolean);
            // a blob URL carries an extra /blob/ marker that a raw URL does not
            if (seg[2] === 'blob') seg.splice(2, 1);
        } else {
            seg = location.pathname.split('/').filter(Boolean);
        }
        if (seg.length < 4) return null;
        const rest = shortRef(seg.slice(2));
        if (rest.length < 2 || !isHtml(rest)) return null;
        const tail = seg[0] + '/' + seg[1] + '/' + rest.join('/');
        return {
            key: 'edit:' + tail,
            icon: PENCIL,
            label: 'Edit on GitHub',
            title: 'Edit this file on GitHub\n' + tail,
            href: 'https://github.com/' + seg[0] + '/' + seg[1] + '/edit/' + rest.join('/')
        };
    }

    // The toolbar next to Raw is the natural home on a blob page, but its markup churns; a rendered
    // page has no toolbar at all. Either way the button parks itself in the corner rather than
    // disappearing.
    function mount(el) {
        const raw = document.querySelector('[data-testid="raw-button"], #raw-url, a[href*="raw.githubusercontent.com"]');
        const group = raw && (raw.closest('.react-blob-header-edit-and-raw-actions') || raw.closest('.BtnGroup') || raw.parentElement);
        if (group && group.parentElement) {
            el.style.cssText = BASE_STYLE + ';margin-right:8px';
            group.parentElement.insertBefore(el, group);
        } else {
            el.style.cssText = BASE_STYLE + ';position:fixed;right:16px;bottom:16px;height:32px;z-index:2147483000;box-shadow:0 1px 3px rgba(0,0,0,.2)';
            document.body.appendChild(el);
        }
    }

    function add(t) {
        const a = document.createElement('a');
        a.id = BTN_ID;
        a.dataset.target = t.key;
        a.href = t.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = t.title;
        a.innerHTML = t.icon + '<span>' + t.label + '</span>';
        if (t.altHref) {
            a.addEventListener('click', (e) => {
                if (!e.altKey) return; // a plain click just follows href
                e.preventDefault();
                window.open(t.altHref, '_blank', 'noopener');
            });
        }
        mount(a);
    }

    // @match only gates the page the script loads on. GitHub navigates without reloading the
    // document and htmlpreview replaces the document with the file it fetched, so the button is
    // reconciled against the current page rather than added once at start-up.
    function sync() {
        const t = previewTarget() || editTarget();
        const existing = document.getElementById(BTN_ID);
        if (!t) {
            if (existing) existing.remove();
            return;
        }
        if (existing && existing.dataset.target === t.key) return;
        if (existing) existing.remove();
        add(t);
    }

    let pending = 0;
    function schedule() {
        clearTimeout(pending);
        pending = setTimeout(sync, 200);
    }

    ['turbo:load', 'turbo:render', 'pjax:end', 'popstate'].forEach((evt) => {
        window.addEventListener(evt, schedule);
    });
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    schedule();
})();
