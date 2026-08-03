// ==UserScript==
// @name         StudyTube
// @namespace    yuliang.userscripts
// @version      1.30.0
// @description  A study dashboard on YouTube and Google: one sidebar with today's + tomorrow's calendar, keyword-filtered unread Gmail, and AI-lab research news from the last 7 days (Anthropic, OpenAI, DeepMind), newest first with hover previews, all in one shared visual style. On YouTube it also covers burned-in captions with a movable overlay, replaces the related-videos rail, docks a panel on the home page, and hides the Shorts shelf.
// @author       yuliang
// @match        https://www.youtube.com/*
// @match        https://www.google.com/*
// @include      /^https:\/\/www\.google\.(?:[a-z]{2,3})(?:\.[a-z]{2})?\//
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @connect      openai.com
// @connect      deepmind.google
// @connect      anthropic.com
// @connect      prod-pdx.yinliy.people.amazon.dev
// @connect      mail.google.com
// @connect      calendar.google.com
// @downloadURL  https://github.com/aqiaojoe08/daydayup/raw/refs/heads/main/studyhub.user.js
// @updateURL    https://github.com/aqiaojoe08/daydayup/raw/refs/heads/main/studyhub.user.js
// ==/UserScript==
(function () {
    'use strict';

    // The dashboard (calendar + mail + news) runs on both hosts; everything that pokes at
    // YouTube's player and feeds is gated on IS_YT.
    const IS_YT = /(^|\.)youtube\.com$/.test(location.hostname);
    const IS_GOOGLE = !IS_YT;

    const POS_KEY = 'gmYtCaptionHiderPos';
    const HIDE_KEY = 'gmYtCaptionHiderHidden';
    const SIDEBAR_KEY = 'gmStudyTubeNewsSidebar'; // '1' news zone (default), '0' related videos
    const HOME_FEED_KEY = 'gmStudyTubeHomeFeed'; // '1' StudyTube feed (default), '0' recommendations
    // Gmail's legacy Atom feed rides the Google cookies YouTube already has, so unread mail
    // needs no token. /u/0 is whichever account is signed in first; bump for other accounts.
    const GMAIL_FEED = 'https://mail.google.com/mail/u/0/feed/atom';
    const GMAIL_POLL_MS = 5 * 60 * 1000;
    const MAIL_FILTER_KEY = 'gmStudyTubeMailFilter'; // persisted keyword filter for the inbox
    // The Atom feed only ever returns UNREAD mail, so read messages have to be remembered:
    // anything that was in the feed and then left it has been read (or archived/deleted).
    // Keeping that history means a filtered inbox still shows its matches once you've read
    // them, instead of collapsing to "nothing here".
    const MAIL_SEEN_KEY = 'gmStudyTubeMailSeen';
    const MAIL_SEEN_MAX = 150; // newest kept; bounds the stored blob
    const MAIL_SEEN_TTL_DAYS = 30;
    // Inbox starts filtered by this keyword. Clearing the field is remembered (the stored
    // empty string wins), so this only applies until the filter is first touched.
    const DEFAULT_MAIL_FILTER = 'airbnb';
    // Google Calendar has no cookie-authenticated feed left (GData was retired), so the
    // calendar section reads iCal URLs instead: either a public .ics or the per-calendar
    // "secret address in iCal format" from Calendar settings. That URL is a bearer
    // credential — it is kept in GM storage, never logged, and never sent anywhere but
    // the host it points at.
    const CAL_ICS_KEY = 'gmStudyTubeCalendarIcs';
    const CAL_POLL_MS = 10 * 60 * 1000;
    const CAL_DAYS = 2; // today + tomorrow
    const DEFAULT_POS = { left: 20, top: 78, width: 60, height: 2 }; // percentages of player size
    const RESIZE_HANDLE = 16; // px, bottom-right corner reserved for CSS resize
    const NEWS_MAX_AGE_DAYS = 7; // headlines older than this are dropped from the rotation

    let overlay, restoreTab, preview, player, dragState, resizing;

    // hide the Shorts shelf on the home page (and Shorts entries elsewhere in feeds)
    if (IS_YT) {
    const shortsStyle = document.createElement('style');
    shortsStyle.textContent = `
        ytd-rich-shelf-renderer[is-shorts],
        ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts]),
        ytd-reel-shelf-renderer,
        grid-shelf-view-model:has(ytm-shorts-lockup-view-model-v2),
        grid-shelf-view-model:has(ytm-shorts-lockup-view-model) {
            display: none !important;
        }
    `;
    document.head.appendChild(shortsStyle);

    // rebrand the tab title; YouTube rewrites document.title on every navigation
    const retitle = () => {
        if (document.title.includes('YouTube') && !document.title.includes('StudyTube')) {
            document.title = document.title.replace('YouTube', 'StudyTube');
        }
    };
    retitle();
    const titleEl = document.querySelector('title');
    if (titleEl) new MutationObserver(retitle).observe(titleEl, { childList: true });
    } // end IS_YT-only chrome

    function loadPos() {
        try {
            return JSON.parse(localStorage.getItem(POS_KEY)) || DEFAULT_POS;
        } catch {
            return DEFAULT_POS;
        }
    }

    function savePos(pos) {
        localStorage.setItem(POS_KEY, JSON.stringify(pos));
    }

    function loadHidden() {
        return localStorage.getItem(HIDE_KEY) === '1';
    }

    function saveHidden(hidden) {
        localStorage.setItem(HIDE_KEY, hidden ? '1' : '0');
    }

    function applyPos(pos) {
        Object.assign(overlay.style, {
            left: pos.left + '%',
            top: pos.top + '%',
            width: pos.width + '%',
            height: pos.height + '%',
        });
    }

    function clamp(v, min, max) {
        return Math.min(Math.max(v, min), max);
    }

    function currentPos() {
        const rect = player.getBoundingClientRect();
        const o = overlay.getBoundingClientRect();
        return {
            left: ((o.left - rect.left) / rect.width) * 100,
            top: ((o.top - rect.top) / rect.height) * 100,
            width: (o.width / rect.width) * 100,
            height: (o.height / rect.height) * 100,
        };
    }

    function startDrag(e) {
        if (e.target === overlay.closeBtn) return;
        const overlayRect = overlay.getBoundingClientRect();
        // let the native CSS resize handle in the bottom-right corner win
        if (overlayRect.right - e.clientX < RESIZE_HANDLE && overlayRect.bottom - e.clientY < RESIZE_HANDLE) {
            resizing = true;
            return;
        }
        const rect = player.getBoundingClientRect();
        dragState = {
            rect,
            offsetX: e.clientX - overlayRect.left,
            offsetY: e.clientY - overlayRect.top,
        };
        e.preventDefault();
    }

    function onDrag(e) {
        if (!dragState) return;
        const { rect, offsetX, offsetY } = dragState;
        const widthPct = (overlay.offsetWidth / rect.width) * 100;
        const heightPct = (overlay.offsetHeight / rect.height) * 100;
        let left = ((e.clientX - offsetX - rect.left) / rect.width) * 100;
        let top = ((e.clientY - offsetY - rect.top) / rect.height) * 100;
        left = clamp(left, 0, 100 - widthPct);
        top = clamp(top, 0, 100 - heightPct);
        applyPos({ left, top, width: widthPct, height: heightPct });
    }

    function endDrag() {
        if (!dragState && !resizing) return;
        if (resizing) {
            // convert the px size CSS resize leaves behind back to %
            const pos = currentPos();
            overlay.style.width = '';
            overlay.style.height = '';
            applyPos(pos);
            savePos(pos);
        } else {
            savePos(currentPos());
        }
        dragState = null;
        resizing = false;
    }

    function applyHiddenState(hidden) {
        if (!overlay || !restoreTab) return;
        overlay.style.display = hidden ? 'none' : 'block';
        restoreTab.style.display = hidden ? 'block' : 'none';
        if (hidden && preview) preview.style.display = 'none';
    }

    function closeOverlay() {
        applyHiddenState(true);
        saveHidden(true);
    }

    function reopenOverlay() {
        applyHiddenState(false);
        saveHidden(false);
    }

    function createOverlay() {
        if (overlay) overlay.remove();
        if (restoreTab) restoreTab.remove();
        if (preview) preview.remove();
        // hover-only chrome (× button, resize handle) needs :hover rules, so use a stylesheet
        if (!document.getElementById('gm-yt-caption-hider-style')) {
            const style = document.createElement('style');
            style.id = 'gm-yt-caption-hider-style';
            style.textContent = `
                #gm-yt-caption-hider {
                    resize: none;
                    transition: border-color .2s, box-shadow .2s;
                }
                #gm-yt-caption-hider:hover {
                    resize: both;
                    border-color: rgba(255, 255, 255, 0.35) !important;
                    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
                }
                #gm-yt-caption-hider .gm-close {
                    opacity: 0;
                    transition: opacity .2s, background .2s;
                }
                #gm-yt-caption-hider:hover .gm-close { opacity: 1; }
                #gm-yt-caption-hider .gm-close:hover {
                    background: rgba(255, 255, 255, 0.25);
                }
                #gm-yt-caption-hider .gm-news-text:hover { color: #fff; }
            `;
            document.head.appendChild(style);
        }
        overlay = document.createElement('div');
        overlay.id = 'gm-yt-caption-hider';
        Object.assign(overlay.style, {
            position: 'absolute',
            background: 'linear-gradient(180deg, #35353c, #26262c)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            borderRadius: '8px',
            zIndex: 60,
            cursor: 'move',
            boxSizing: 'border-box',
            overflow: 'hidden',
            minWidth: '60px',
            minHeight: '15px',
        });

        const closeBtn = document.createElement('div');
        closeBtn.className = 'gm-close';
        closeBtn.textContent = '×';
        Object.assign(closeBtn.style, {
            position: 'absolute',
            top: '50%',
            right: '6px',
            transform: 'translateY(-50%)',
            width: '16px',
            height: '16px',
            borderRadius: '50%',
            background: 'rgba(255, 255, 255, 0.12)',
            color: '#eee',
            fontSize: '12px',
            lineHeight: '16px',
            textAlign: 'center',
            cursor: 'pointer',
            userSelect: 'none',
            fontFamily: 'Roboto, sans-serif',
        });
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeOverlay();
        });
        overlay.appendChild(closeBtn);
        overlay.closeBtn = closeBtn;

        const newsEl = document.createElement('div');
        newsEl.className = 'gm-news';
        Object.assign(newsEl.style, {
            position: 'absolute',
            inset: '0 28px 0 10px', // right gap reserves room for the × button
            display: 'flex',
            alignItems: 'center',
            color: '#ccc',
            fontSize: '14px',
            fontFamily: 'Roboto, sans-serif',
            letterSpacing: '0.2px',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            cursor: 'move',
            userSelect: 'none',
        });
        const newsIcon = document.createElement('img');
        Object.assign(newsIcon.style, {
            width: '14px',
            height: '14px',
            marginRight: '6px',
            borderRadius: '3px',
            flex: 'none',
            display: 'none',
        });
        const newsText = document.createElement('span');
        newsText.className = 'gm-news-text';
        Object.assign(newsText.style, {
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            cursor: 'pointer',
            transition: 'color .2s',
        });
        // open the headline on a plain click, but let click-and-drag still move the overlay
        let downAt;
        newsText.addEventListener('mousedown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
        newsText.addEventListener('click', (e) => {
            const moved = downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5;
            if (!moved && newsEl.dataset.url) GM_openInTab(newsEl.dataset.url, { active: true });
        });
        const newsDate = document.createElement('span');
        Object.assign(newsDate.style, {
            marginLeft: '8px',
            color: '#999',
            fontSize: '12px',
            flex: 'none',
        });
        newsEl.append(newsIcon, newsText, newsDate);
        overlay.appendChild(newsEl);

        preview = document.createElement('div');
        preview.className = 'gm-preview';
        Object.assign(preview.style, {
            position: 'absolute',
            display: 'none',
            maxWidth: '360px',
            padding: '10px 12px',
            background: 'linear-gradient(180deg, #3a3a42, #2a2a30)',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            borderRadius: '8px',
            boxShadow: '0 6px 24px rgba(0, 0, 0, 0.7)',
            color: '#ddd',
            fontSize: '14px',
            fontFamily: 'Roboto, sans-serif',
            lineHeight: '1.45',
            zIndex: 61,
            pointerEvents: 'none',
        });
        const previewTitle = document.createElement('div');
        Object.assign(previewTitle.style, { fontWeight: '500', color: '#fff', marginBottom: '4px' });
        const previewMeta = document.createElement('div');
        Object.assign(previewMeta.style, { color: '#9a9aa2', fontSize: '12px', marginBottom: '4px' });
        const previewDesc = document.createElement('div');
        const previewUrl = document.createElement('div');
        Object.assign(previewUrl.style, {
            color: '#8ab4f8',
            fontSize: '11px',
            marginTop: '4px',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
        });
        preview.append(previewTitle, previewMeta, previewDesc, previewUrl);
        player.appendChild(preview);

        const showPreview = () => {
            const item = currentItem();
            if (!item) return;
            previewTitle.textContent = item.title;
            const exact = item.date && !isNaN(new Date(item.date))
                ? new Date(item.date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
            previewMeta.textContent = [
                hostOf(item.url),
                item.tag,
                [formatDate(item.date), exact && `(${exact})`].filter(Boolean).join(' '),
                item.author && `via ${item.author}`,
                item.points != null && `${item.points} pts on HN`,
                item.comments != null && `${item.comments} comments`,
            ].filter(Boolean).join(' · ');
            previewDesc.textContent = item.desc || '';
            previewDesc.style.display = item.desc ? '' : 'none';
            previewUrl.textContent = item.url;
            preview.style.display = 'block';
            const pRect = player.getBoundingClientRect();
            const oRect = overlay.getBoundingClientRect();
            preview.style.left = clamp(oRect.left - pRect.left, 0, pRect.width - preview.offsetWidth) + 'px';
            // above the bar if it fits, otherwise below
            const above = oRect.top - pRect.top - preview.offsetHeight - 8;
            preview.style.top = (above >= 0 ? above : oRect.bottom - pRect.top + 8) + 'px';
        };
        newsEl.addEventListener('mouseenter', showPreview);
        newsEl.addEventListener('mouseleave', () => { preview.style.display = 'none'; });

        // The old ☰ "preview all" popover lived here; the sidebar and home feed now show
        // the same full list, so the bar keeps only the single-item hover preview.
        showNewsHeadline(newsEl, newsIcon, newsText, newsDate, showPreview);

        overlay.addEventListener('mousedown', startDrag);

        restoreTab = document.createElement('div');
        restoreTab.textContent = '📰';
        restoreTab.title = 'Show StudyTube bar';
        Object.assign(restoreTab.style, {
            position: 'absolute',
            top: '8px',
            right: '8px',
            padding: '4px 7px',
            background: 'rgba(10, 10, 13, 0.8)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            color: '#fff',
            fontSize: '12px',
            fontFamily: 'Roboto, sans-serif',
            borderRadius: '8px',
            cursor: 'pointer',
            zIndex: 60,
            display: 'none',
            userSelect: 'none',
        });
        restoreTab.addEventListener('click', reopenOverlay);

        player.appendChild(overlay);
        player.appendChild(restoreTab);
        applyPos(loadPos());
        applyHiddenState(loadHidden());
    }

    let newsItems = [];
    let newsFetching = false; // one in-flight fetch shared by the bar and the home feed

    // one row shape, shared by the hover "preview all" panel and the sidebar news zone
    function buildNewsRow(item, isLive) {
        const row = document.createElement('div');
        row.className = 'gm-news-list-row';
        Object.assign(row.style, {
            display: 'flex',
            alignItems: 'flex-start',
            gap: '7px',
            padding: '6px 8px',
            borderRadius: '6px',
            cursor: 'pointer',
            transition: 'background .15s, border-color .15s',
        });
        // both surfaces style the live row from CSS via [data-live], so the sidebar's
        // themed highlight isn't fighting an inline background
        if (isLive) row.dataset.live = '1';
        const ico = document.createElement('img');
        ico.src = item.icon;
        Object.assign(ico.style, {
            width: '14px', height: '14px', marginTop: '2px',
            borderRadius: '3px', flex: 'none',
        });
        const body = document.createElement('div');
        Object.assign(body.style, { minWidth: '0', flex: '1' });
        const title = document.createElement('div');
        title.className = 'gm-news-list-title';
        title.textContent = item.title;
        // colors come from CSS so the same row reads correctly on the dark in-player
        // panel and in the sidebar, which follows YouTube's light/dark theme
        Object.assign(title.style, { transition: 'color .15s' });
        const meta = document.createElement('div');
        meta.className = 'gm-row-meta';
        meta.textContent = [hostOf(item.url), item.tag, formatDate(item.date)]
            .filter(Boolean).join(' · ');
        // sizes are set in CSS per surface: the sidebar runs larger than the in-player panel
        Object.assign(meta.style, { marginTop: '2px' });
        body.append(title, meta);
        row.append(ico, body);
        row.addEventListener('click', () => GM_openInTab(item.url, { active: true }));
        attachRowPreview(row, item);
        return row;
    }

    // ── hover preview for panel news rows ────────────────────────────────────
    // The in-player bar has its own preview anchored to the player; panel rows need one
    // that follows the cursor, since the panel scrolls and lives outside the player.
    let rowPreview;

    function ensureRowPreview() {
        if (rowPreview && document.body.contains(rowPreview)) return rowPreview;
        rowPreview = document.createElement('div');
        rowPreview.id = 'gm-row-preview';
        rowPreview.className = 'gm-feed-panel'; // inherit the panel's theme tokens
        const t = document.createElement('div');
        t.className = 'gm-rp-title';
        const m = document.createElement('div');
        m.className = 'gm-rp-meta';
        const d = document.createElement('div');
        d.className = 'gm-rp-desc';
        const u = document.createElement('div');
        u.className = 'gm-rp-url';
        rowPreview.append(t, m, d, u);
        document.body.appendChild(rowPreview);
        rowPreview.refs = { t, m, d, u };
        return rowPreview;
    }

    function attachRowPreview(row, item) {
        const show = (e) => {
            const pv = ensureRowPreview();
            const { t, m, d, u } = pv.refs;
            t.textContent = item.title;
            const exact = item.date && !isNaN(new Date(item.date))
                ? new Date(item.date).toLocaleDateString(undefined,
                    { year: 'numeric', month: 'short', day: 'numeric' })
                : '';
            m.textContent = [hostOf(item.url), item.tag, formatDate(item.date), exact && `(${exact})`]
                .filter(Boolean).join(' · ');
            d.textContent = item.desc || '';
            d.style.display = item.desc ? '' : 'none';
            u.textContent = item.url;
            pv.style.display = 'block';
            place(e);
        };
        // fixed positioning, so viewport coords are what we want; flip when near an edge
        const place = (e) => {
            const pv = rowPreview;
            if (!pv) return;
            const pad = 12;
            const w = pv.offsetWidth;
            const h = pv.offsetHeight;
            let left = e.clientX + 16;
            let top = e.clientY + 16;
            if (left + w + pad > innerWidth) left = e.clientX - w - 16;
            if (top + h + pad > innerHeight) top = e.clientY - h - 16;
            pv.style.left = Math.max(pad, left) + 'px';
            pv.style.top = Math.max(pad, top) + 'px';
        };
        const hide = () => { if (rowPreview) rowPreview.style.display = 'none'; };
        row.addEventListener('mouseenter', show);
        row.addEventListener('mousemove', place);
        row.addEventListener('mouseleave', hide);
        // a click navigates away; leave nothing floating behind
        row.addEventListener('click', hide);
    }

    // The item shown in the in-player bar, highlighted in the list so the two agree.
    function currentItem() {
        return newsItems.length ? newsItems[0] : null;
    }

    // GM_xmlhttpRequest bypasses CORS, so any @connect-listed source works here
    function gmFetch(url) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                onload: (res) => resolve(res.responseText),
                onerror: () => resolve(null),
            });
        });
    }

    // YouTube enforces Trusted Types CSP; DOMParser.parseFromString rejects plain strings without a policy
    let ttPolicy;
    try {
        ttPolicy = window.trustedTypes?.createPolicy('gmYtCaptionHider', { createHTML: (s) => s });
    } catch { /* policy name already taken or creation disallowed */ }

    function parseFeed(xml, icon, limit) {
        if (!xml) return [];
        const doc = new DOMParser().parseFromString(ttPolicy ? ttPolicy.createHTML(xml) : xml, 'text/xml');
        // RSS uses <item><link>text</link>, Atom uses <entry><link href> or <id>
        return [...doc.querySelectorAll('item, entry')].slice(0, limit).map(e => ({
            icon,
            title: e.querySelector('title')?.textContent.replace(/\s+/g, ' ').trim(),
            url: e.querySelector('link')?.getAttribute('href')
                || e.querySelector('link')?.textContent.trim()
                || e.querySelector('id')?.textContent.trim(),
            date: e.querySelector('pubDate, published, updated')?.textContent.trim(),
            desc: stripHtml(e.querySelector('description, summary, content')?.textContent),
            author: e.getElementsByTagName('dc:creator')[0]?.textContent.trim()
                || e.querySelector('author > name, author')?.textContent.trim(),
        })).filter(i => i.title && i.url);
    }

    function parseHtml(htmlText) {
        return new DOMParser().parseFromString(ttPolicy ? ttPolicy.createHTML(htmlText) : htmlText, 'text/html');
    }

    // anthropic.com/research is a Next.js page, but its publication list is present in the static HTML
    function parseAnthropicResearch(htmlText, icon, limit) {
        if (!htmlText) return [];
        const doc = parseHtml(htmlText);
        const seen = new Set();
        const items = [];
        for (const a of doc.querySelectorAll('a[href^="/research/"]')) {
            const href = a.getAttribute('href');
            if (href.startsWith('/research/team/') || seen.has(href)) continue;
            const title = a.querySelector('[class*="title"], h3, h2')?.textContent.replace(/\s+/g, ' ').trim();
            if (!title) continue;
            seen.add(href);
            items.push({
                icon,
                title,
                url: 'https://www.anthropic.com' + href,
                date: a.querySelector('time')?.textContent.trim(),
                desc: stripHtml(a.querySelector('p, [class*="description"], [class*="excerpt"]')?.textContent),
                tag: a.querySelector('[class*="subject"]')?.textContent.trim(), // research area, e.g. Interpretability
            });
            if (items.length >= limit) break;
        }
        return items;
    }

    // deepmind.google/research/publications/ is server-rendered, newest first
    function parseDeepMindPubs(htmlText, icon, limit) {
        if (!htmlText) return [];
        const doc = parseHtml(htmlText);
        return [...doc.querySelectorAll('a[href*="/research/publications/"]')]
            .filter(a => /\/research\/publications\/\d+/.test(a.getAttribute('href') || ''))
            .slice(0, limit)
            .map(a => ({
                icon,
                title: a.querySelector('.list-group__description')?.textContent.replace(/\s+/g, ' ').trim(),
                url: a.href,
                date: a.querySelector('.list-group__date')?.textContent.trim(),
                tag: 'Publication',
            }))
            .filter(i => i.title && i.url);
    }

    // OpenAI has no research-only feed; heuristically keep research/engineering posts from the news RSS
    const OAI_RESEARCH = /research|model|benchmark|eval|interpret|align|safety|reasoning|training|scal|agent|engineer|infrastructur|technical|capabilit|gpt|codex|sora/i;
    function filterOpenAIResearch(items, limit) {
        return items.filter(i => OAI_RESEARCH.test(i.title + ' ' + (i.desc || ''))
            && !/customer|partner|deal|brings|business|enterprise adoption/i.test(i.title)).slice(0, limit);
    }

    // ── PowerChat (optional semantic filter; needs Midway session) ──────────
    const POWERCHAT_URL = 'https://prod-pdx.yinliy.people.amazon.dev/chatOnPage';
    const PC_CACHE_KEY = 'gmStudyTubePcVerdicts';
    const PC_CACHE_TTL = 24 * 60 * 60 * 1000;

    function powerChatRequest(message) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: `${POWERCHAT_URL}?c=StudyTube&v=${encodeURIComponent(GM_info?.script?.version || 'unknown')}`,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({
                    'Time Zone': Intl.DateTimeFormat().resolvedOptions().timeZone,
                    'Page Context': [{ Url: location.href, 'Current Page': true, Title: 'StudyTube', Content: '' }],
                    'Chat History': [],
                    'Message': message,
                }),
                withCredentials: true,
                timeout: 20000,
                onload: (r) => {
                    try {
                        const completion = JSON.parse(r.responseText).completion;
                        resolve(completion.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim());
                    } catch (e) { reject(e); }
                },
                onerror: reject,
                ontimeout: () => reject(new Error('timeout')),
            });
        });
    }

    function loadPcCache() {
        try {
            const c = JSON.parse(localStorage.getItem(PC_CACHE_KEY));
            if (c && Date.now() - c.at < PC_CACHE_TTL) return c.verdicts;
        } catch { /* corrupt cache */ }
        return {};
    }

    // Ask PowerChat which items are genuine research/engineering work; returns {url: boolean}.
    // Verdicts are cached for 24h so repeated fetch cycles don't re-ask about the same items.
    async function powerChatVerdicts(items) {
        const cached = loadPcCache();
        const unknown = items.filter(i => !(i.url in cached));
        if (unknown.length) {
            const payload = JSON.stringify(unknown.map(i => ({ url: i.url, title: i.title, desc: (i.desc || '').slice(0, 120) })));
            const answer = await powerChatRequest(
                `You are filtering an AI-news feed for someone studying AI explainability/interpretability and agents.
Keep only items that describe research findings or engineering/technical work (papers, model releases, methods, benchmarks, safety/alignment/interpretability work, technical deep dives).
Drop marketing, customer stories, partnerships, hiring, policy, and business announcements.

Items: ${payload}

Return ONLY a JSON object mapping each url to true (keep) or false (drop), no prose.`);
            Object.assign(cached, JSON.parse(answer));
            localStorage.setItem(PC_CACHE_KEY, JSON.stringify({ at: Date.now(), verdicts: cached }));
        }
        return cached;
    }

    // Prune the live rotation with PowerChat verdicts; on any failure keep the regex-filtered list.
    async function refineNewsWithPowerChat() {
        try {
            const verdicts = await powerChatVerdicts(newsItems);
            const kept = newsItems.filter(i => verdicts[i.url] !== false);
            if (kept.length >= 3 && kept.length < newsItems.length) {
                console.info(`[StudyTube] PowerChat pruned ${newsItems.length - kept.length}/${newsItems.length} items`);
                newsItems = kept;
            }
        } catch (e) {
            console.info('[StudyTube] PowerChat filter unavailable, keeping heuristic results:', e.message);
        }
    }

    async function fetchAllNews() {
        const icon = (domain) => `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
        const sources = [
            // Anthropic has no RSS feed; scrape its research listing page instead.
            // Limits are generous because the 7-day filter below prunes most of what comes back.
            gmFetch('https://www.anthropic.com/research').then(x => parseAnthropicResearch(x, icon('anthropic.com'), 30)),
            gmFetch('https://openai.com/news/rss.xml').then(x => filterOpenAIResearch(parseFeed(x, icon('openai.com'), 60), 20)),
            gmFetch('https://deepmind.google/research/publications/').then(x => parseDeepMindPubs(x, icon('deepmind.google'), 30)),
        ];
        // drop low-signal headlines with fewer than 5 words, and anything older than 7 days
        const results = (await Promise.all(sources))
            .map(r => r.filter(i => i.title.split(/\s+/).length >= 5 && isRecent(i.date)));
        // Newest first, across all sources. This replaces a round-robin interleave: with a
        // 7-day window the point is "what's new", and source order was arbitrary anyway.
        // Undated items can't reach here — isRecent() already requires a parsable date.
        return results.flat().sort((a, b) => new Date(b.date) - new Date(a.date));
    }

    function stripHtml(s) {
        return s ? s.replace(/<[^>]+>/g, ' ')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ').trim().slice(0, 240) : '';
    }

    function hostOf(url) {
        try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
    }

    // keep the feed current: anything older than a week (or with no usable date) is dropped
    function isRecent(raw) {
        const d = new Date(raw);
        if (isNaN(d)) return false;
        const days = (Date.now() - d.getTime()) / 86400000;
        return days <= NEWS_MAX_AGE_DAYS;
    }

    function formatDate(raw) {
        const d = new Date(raw);
        if (isNaN(d)) return '';
        const days = Math.floor((Date.now() - d.getTime()) / 86400000);
        if (days <= 0) return 'today';
        if (days === 1) return '1 day ago';
        return `${days} days ago`;
    }

    // Shows ONE headline — the newest — and leaves it there. This used to rotate through
    // the list every 30s, which moved a click target under the cursor, swapped the hover
    // preview mid-read, and re-rendered the whole panel on each tick. The panel already
    // lists every item, so the bar has no reason to cycle.
    function showNewsHeadline(el, iconEl, textEl, dateEl, refreshPreview) {
        const show = () => {
            if (!newsItems.length) return;
            const item = newsItems[0]; // sorted newest-first by fetchAllNews()
            iconEl.src = item.icon;
            iconEl.style.display = 'block';
            textEl.textContent = item.title;
            dateEl.textContent = item.date ? formatDate(item.date) : '';
            el.dataset.url = item.url;
            if (el.matches(':hover')) refreshPreview();
            renderSidebar();
        };
        if (newsItems.length) {
            show();
        } else if (newsFetching) {
            // the home feed already started a fetch; primeNews() re-renders when it lands
            textEl.textContent = 'Loading AI news…';
        } else {
            textEl.textContent = 'Loading AI news…';
            newsFetching = true;
            fetchAllNews().then(items => {
                newsItems = items;
                if (!items.length) textEl.textContent = `No AI news in the last ${NEWS_MAX_AGE_DAYS} days`;
                show();
                renderSidebar();
                // async; no-ops without Midway
                refineNewsWithPowerChat().then(renderSidebar);
            }).finally(() => { newsFetching = false; });
        }
    }

    // The home page has no player, so the in-player bar never runs there and would leave
    // the feed stuck on "Loading AI news…". Fetch once, independently, guarded so the bar
    // and the home feed can't both kick off a fetch.
    function primeNews() {
        if (newsFetching || newsItems.length) return;
        newsFetching = true;
        fetchAllNews().then(items => {
            newsItems = items;
            renderSidebar();
            return refineNewsWithPowerChat().then(renderSidebar);
        }).finally(() => { newsFetching = false; });
    }

    // ── Gmail (optional; silently absent when not signed in) ─────────────────
    let mailItems = [];  // what the panel shows: unread from the feed + remembered read
    let mailState = 'idle'; // idle | loading | ok | signedout | error
    let mailTimer;

    // Archive of every message this script has seen, so read mail survives leaving the
    // unread feed. Shared via GM storage, so YouTube and Google agree on what's read.
    function loadSeenMail() {
        try {
            const raw = gmStore ? GM_getValue(MAIL_SEEN_KEY, null) : localStorage.getItem(MAIL_SEEN_KEY);
            const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return Array.isArray(list) ? list : [];
        } catch { return []; } // corrupt blob: start over rather than break the panel
    }

    function saveSeenMail(list) {
        // prune by age first, then cap, so an old backlog can't crowd out recent mail
        const cutoff = Date.now() - MAIL_SEEN_TTL_DAYS * 86400000;
        const kept = list
            .filter(m => !m.date || new Date(m.date).getTime() > cutoff || isNaN(new Date(m.date)))
            .sort((a, b) => mailTime(b) - mailTime(a))
            .slice(0, MAIL_SEEN_MAX);
        const json = JSON.stringify(kept);
        if (gmStore) GM_setValue(MAIL_SEEN_KEY, json);
        else localStorage.setItem(MAIL_SEEN_KEY, json);
        return kept;
    }

    function mailTime(m) {
        const t = new Date(m.date).getTime();
        return isNaN(t) ? 0 : t;
    }

    // Gmail's feed has no stable id element, but its link carries a message_id; fall back
    // to sender+subject+date so entries without one still dedupe.
    function mailKey(m) {
        const id = (m.url || '').match(/message_id=([^&]+)/);
        return id ? id[1] : `${m.from}|${m.title}|${m.date}`;
    }

    // Merge this poll's unread list into the archive:
    //  - still in the feed  -> unread
    //  - in the archive but gone from the feed -> read (or archived/deleted)
    // Returns the combined list, newest first.
    function mergeMail(unread) {
        const archive = loadSeenMail();
        const byKey = new Map();
        // remembered messages first, all provisionally read...
        archive.forEach(m => byKey.set(mailKey(m), { ...m, unread: false }));
        // ...then this poll's unread entries override, so state always follows the feed
        unread.forEach(m => byKey.set(mailKey(m), { ...m, unread: true }));
        const merged = [...byKey.values()].sort((a, b) => mailTime(b) - mailTime(a));
        return saveSeenMail(merged);
    }

    // withCredentials sends the Google cookies; a 401 just means "not signed in"
    function fetchGmail() {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: GMAIL_FEED,
                withCredentials: true,
                timeout: 15000,
                // distinguish "not signed in" (401/403) from a transport failure
                onload: (r) => resolve(r.status === 200 ? { body: r.responseText } : { status: r.status }),
                onerror: () => resolve({ status: 0 }),
                ontimeout: () => resolve({ status: 0 }),
            });
        });
    }

    function parseGmail(xml) {
        if (!xml) return null;
        const doc = new DOMParser().parseFromString(ttPolicy ? ttPolicy.createHTML(xml) : xml, 'text/xml');
        if (doc.querySelector('parsererror')) return null;
        const entries = [...doc.querySelectorAll('entry')].map(e => ({
            title: e.querySelector('title')?.textContent.replace(/\s+/g, ' ').trim() || '(no subject)',
            summary: e.querySelector('summary')?.textContent.replace(/\s+/g, ' ').trim() || '',
            date: e.querySelector('issued, modified')?.textContent.trim(),
            from: e.querySelector('author > name')?.textContent.trim()
                || e.querySelector('author > email')?.textContent.trim() || '',
            // the feed's link is an href attribute pointing at the message in Gmail
            url: e.querySelector('link')?.getAttribute('href') || 'https://mail.google.com/mail/u/0/#inbox',
        }));
        return { entries };
    }

    async function refreshMail() {
        if (mailState === 'idle') mailState = 'loading';
        const res = await fetchGmail();
        const parsed = res.body ? parseGmail(res.body) : null;
        if (parsed) {
            mailState = 'ok';
            mailItems = mergeMail(parsed.entries);
        } else {
            // 401/403 means no Google session; anything else is a transport/parse problem
            mailState = (res.status === 401 || res.status === 403) ? 'signedout' : 'error';
            // Keep whatever was already read: the fetch failing says nothing about the
            // archive, and dropping it would blank a panel that had useful history.
            // Everything shows as read, since the feed can't confirm otherwise.
            mailItems = loadSeenMail().map(m => ({ ...m, unread: false }));
        }
        renderSidebar();
    }

    function startMailPolling() {
        clearInterval(mailTimer);
        refreshMail();
        mailTimer = setInterval(refreshMail, GMAIL_POLL_MS);
    }

    function buildMailRow(item) {
        const row = document.createElement('div');
        row.className = 'gm-news-list-row gm-mail-row';
        // read rows are dimmed and un-bolded via CSS, so unread still stands out
        if (!item.unread) row.dataset.read = '1';
        Object.assign(row.style, {
            display: 'flex',
            alignItems: 'flex-start',
            gap: '7px',
            padding: '6px 8px',
            borderRadius: '6px',
            cursor: 'pointer',
            transition: 'background .15s',
        });
        const ico = document.createElement('div');
        // not .gm-row-meta: that class means secondary *text*, and borrowing it here made
        // the dot's 10px/accent styling indistinguishable from a real meta line
        ico.className = 'gm-mail-icon';
        // Filled dot for unread, hollow for read. The two envelope glyphs (✉/✉︎) render
        // near-identically in most fonts, so they'd leave the state resting on color alone.
        ico.textContent = item.unread ? '●' : '○';
        ico.title = item.unread ? 'Unread' : 'Read';
        Object.assign(ico.style, {
            width: '18px', minWidth: '18px', lineHeight: '24px',
            flex: 'none', textAlign: 'center', // size comes from CSS

        });
        const body = document.createElement('div');
        Object.assign(body.style, { minWidth: '0', flex: '1' });

        const top = document.createElement('div');
        Object.assign(top.style, { display: 'flex', gap: '8px', alignItems: 'baseline' });
        const from = document.createElement('div');
        from.className = 'gm-news-list-title';
        from.textContent = item.from || '(unknown sender)';
        // weight comes from CSS, not inline: an inline value would outrank the
        // [data-read] rule that un-bolds read senders
        Object.assign(from.style, {
            flex: '1',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        });
        const when = document.createElement('div');
        when.className = 'gm-row-meta';
        when.textContent = shortAge(item.date);
        Object.assign(when.style, { fontSize: '13px', flex: 'none' });
        top.append(from, when);

        // the sender line is the emphasized one, so keep the subject one step down
        const subject = document.createElement('div');
        subject.className = 'gm-row-meta';
        subject.textContent = item.title;
        Object.assign(subject.style, {
            fontSize: '15px',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        });
        const snippet = document.createElement('div');
        snippet.className = 'gm-row-meta';
        snippet.textContent = item.summary;
        // no extra opacity here: it pushed the snippet under 4.5:1 in light mode
        Object.assign(snippet.style, {
            fontSize: '13px', marginTop: '1px',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            display: item.summary ? '' : 'none',
        });
        body.append(top, subject, snippet);
        row.append(ico, body);
        row.addEventListener('click', () => GM_openInTab(item.url, { active: true }));
        return row;
    }

    // compact ages for mail rows, which are denser than news rows
    function shortAge(raw) {
        const d = new Date(raw);
        if (isNaN(d)) return '';
        const mins = Math.floor((Date.now() - d.getTime()) / 60000);
        if (mins < 1) return 'now';
        if (mins < 60) return `${mins}m`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h`;
        return `${Math.floor(hrs / 24)}d`;
    }

    // Settings live in GM storage, not localStorage: GM storage is shared across every
    // site the script runs on (and syncs between tabs), so keywords and the calendar URL
    // apply on both YouTube and Google instead of being trapped per-origin. Falls back to
    // localStorage when the GM_* grants are unavailable (e.g. a stripped userscript host).
    const gmStore = typeof GM_setValue === 'function' && typeof GM_getValue === 'function';

    // ── Calendar: today + tomorrow, read from an iCal (.ics) URL ─────────────
    // Google killed the cookie-authenticated calendar feed, so unlike Gmail this section
    // can't ride YouTube's existing session. It reads an iCal URL instead, which the user
    // pastes once (Calendar → settings → "Secret address in iCal format", or any public
    // .ics). Stored in GM storage so it is shared across both hosts.
    let calItems = [];
    let calState = 'idle'; // idle | unset | loading | ok | error
    let calTimer;

    function loadIcsUrl() {
        const v = gmStore ? GM_getValue(CAL_ICS_KEY, '') : localStorage.getItem(CAL_ICS_KEY);
        return (v || '').trim();
    }

    function saveIcsUrl(url) {
        if (gmStore) GM_setValue(CAL_ICS_KEY, url);
        else localStorage.setItem(CAL_ICS_KEY, url);
    }

    // ── minimal iCalendar parsing ────────────────────────────────────────────
    // Folded lines continue with a leading space or tab (RFC 5545 §3.1).
    function unfoldIcs(text) {
        return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
    }

    function unescapeIcsText(s) {
        return (s || '')
            .replace(/\\n/gi, ' ').replace(/\\,/g, ',')
            .replace(/\\;/g, ';').replace(/\\\\/g, '\\')
            .replace(/\s+/g, ' ').trim();
    }

    // "DTSTART;TZID=America/Los_Angeles:20260802T140000" -> {name, params, value}
    function parseIcsLine(line) {
        const colon = line.indexOf(':');
        if (colon < 0) return null;
        const head = line.slice(0, colon);
        const value = line.slice(colon + 1);
        const [name, ...rest] = head.split(';');
        const params = {};
        rest.forEach(p => {
            const eq = p.indexOf('=');
            if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
        });
        return { name: name.toUpperCase(), params, value };
    }

    // How far the named zone is ahead of UTC at that instant, via Intl rather than a
    // timezone table — this is what makes TZID events land at the right local hour.
    function tzOffsetMs(tz, utcMs) {
        try {
            const parts = new Intl.DateTimeFormat('en-US', {
                timeZone: tz, hour12: false,
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
            }).formatToParts(new Date(utcMs)).reduce((a, p) => (a[p.type] = p.value, a), {});
            const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
                +parts.hour % 24, +parts.minute, +parts.second);
            return asUtc - utcMs;
        } catch { return null; } // unknown zone -> caller falls back to local time
    }

    // A wall-clock time written in `tz` -> the UTC instant it names. Applied twice because
    // the offset itself depends on the instant (DST boundaries).
    function wallTimeToUtc(y, mo, d, h, mi, s, tz) {
        const naive = Date.UTC(y, mo, d, h, mi, s);
        const off = tzOffsetMs(tz, naive);
        if (off === null) return new Date(y, mo, d, h, mi, s).getTime(); // local time
        return naive - tzOffsetMs(tz, naive - off);
    }

    // Returns {ms, allDay}. Value is either YYYYMMDD or YYYYMMDDThhmmss[Z].
    function parseIcsDate(value, params) {
        const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
        if (!m) return null;
        const [, y, mo, d, h, mi, s, z] = m;
        const allDay = params.VALUE === 'DATE' || h === undefined;
        if (allDay) {
            // all-day dates are floating: treat them as local midnight so "today" matches
            return { ms: new Date(+y, +mo - 1, +d).getTime(), allDay: true };
        }
        if (z) return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), allDay: false };
        if (params.TZID) return { ms: wallTimeToUtc(+y, +mo - 1, +d, +h, +mi, +s, params.TZID), allDay: false };
        return { ms: new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime(), allDay: false };
    }

    // "PT1H30M" / "P1D" -> ms
    function parseIcsDuration(v) {
        const m = (v || '').match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
        if (!m) return null;
        const [, w, d, h, mi, s] = m.map(x => (x ? +x : 0));
        return ((w * 7 + d) * 86400 + h * 3600 + mi * 60 + s) * 1000;
    }

    function parseIcs(text) {
        if (!text || !/BEGIN:VCALENDAR/i.test(text)) return null;
        const events = [];
        let cur = null;
        let depth = 0; // VALARM / nested components must not be read as event props
        for (const line of unfoldIcs(text)) {
            const p = parseIcsLine(line);
            if (!p) continue;
            if (p.name === 'BEGIN') {
                if (p.value === 'VEVENT') { cur = { exdates: [] }; depth = 0; }
                else if (cur) depth++;
                continue;
            }
            if (p.name === 'END') {
                if (p.value === 'VEVENT') {
                    if (cur && cur.start) events.push(cur);
                    cur = null;
                } else if (depth > 0) depth--;
                continue;
            }
            if (!cur || depth > 0) continue;
            switch (p.name) {
                case 'SUMMARY': cur.title = unescapeIcsText(p.value); break;
                case 'LOCATION': cur.location = unescapeIcsText(p.value); break;
                case 'STATUS': cur.status = p.value.toUpperCase(); break;
                case 'DTSTART': cur.start = parseIcsDate(p.value, p.params); break;
                case 'DTEND': cur.end = parseIcsDate(p.value, p.params); break;
                case 'DURATION': cur.duration = parseIcsDuration(p.value); break;
                case 'RRULE': cur.rrule = p.value; break;
                case 'RECURRENCE-ID': {
                    const r = parseIcsDate(p.value, p.params);
                    if (r) cur.recurrenceId = r.ms;
                    break;
                }
                case 'UID': cur.uid = p.value; break;
                case 'EXDATE':
                    p.value.split(',').forEach(v => {
                        const d = parseIcsDate(v.trim(), p.params);
                        if (d) cur.exdates.push(d.ms);
                    });
                    break;
                default: break;
            }
        }
        return events;
    }

    const ICS_DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

    function parseRrule(rrule) {
        const out = {};
        rrule.split(';').forEach(part => {
            const eq = part.indexOf('=');
            if (eq > 0) out[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
        });
        return out;
    }

    // Expand one VEVENT into the occurrences that touch [winStart, winEnd).
    // Supports FREQ=DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, BYDAY (weekly), COUNT,
    // UNTIL and EXDATE — i.e. ordinary repeating meetings. Positional monthly rules
    // ("3rd Tuesday") fall back to repeating on the DTSTART day of the month.
    function expandEvent(ev, winStart, winEnd) {
        const durMs = ev.duration != null ? ev.duration
            : (ev.end ? ev.end.ms - ev.start.ms : (ev.start.allDay ? 86400000 : 3600000));
        const hits = [];
        const push = (startMs) => {
            if (ev.exdates.some(x => Math.abs(x - startMs) < 60000)) return;
            const endMs = startMs + durMs;
            if (endMs > winStart && startMs < winEnd) {
                hits.push({
                    title: ev.title || '(no title)',
                    location: ev.location || '',
                    start: startMs,
                    end: endMs,
                    allDay: ev.start.allDay,
                });
            }
        };
        if (!ev.rrule) { push(ev.start.ms); return hits; }

        const r = parseRrule(ev.rrule);
        const interval = Math.max(1, parseInt(r.INTERVAL, 10) || 1);
        const untilParsed = r.UNTIL ? parseIcsDate(r.UNTIL, {}) : null;
        const until = untilParsed ? untilParsed.ms : Infinity;
        const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
        const hardStop = Math.min(winEnd, until);

        const first = new Date(ev.start.ms);
        let emitted = 0;
        const step = (base, n) => {
            const d = new Date(base);
            switch ((r.FREQ || '').toUpperCase()) {
                case 'DAILY': d.setDate(d.getDate() + n * interval); break;
                case 'WEEKLY': d.setDate(d.getDate() + n * 7 * interval); break;
                case 'MONTHLY': d.setMonth(d.getMonth() + n * interval); break;
                case 'YEARLY': d.setFullYear(d.getFullYear() + n * interval); break;
                default: return null;
            }
            return d;
        };
        if (!step(ev.start.ms, 0)) { push(ev.start.ms); return hits; }

        // weekly rules can name several weekdays per week; offsets are from the week's base
        const byDays = (r.FREQ || '').toUpperCase() === 'WEEKLY' && r.BYDAY
            ? r.BYDAY.split(',').map(d => ICS_DAYS[d.trim().slice(-2).toUpperCase()])
                .filter(d => d !== undefined)
            : null;

        // 2000 periods covers a decade of weekly meetings and years of daily ones without
        // ever letting a malformed rule spin forever
        for (let n = 0; n < 2000; n++) {
            const base = step(ev.start.ms, n);
            if (!base) break;
            if (base.getTime() > hardStop && emitted) break;
            if (base.getTime() > hardStop && base.getTime() > winEnd) break;
            const slots = [];
            if (byDays) {
                byDays.forEach(dow => {
                    const d = new Date(base);
                    d.setDate(d.getDate() - ((d.getDay() - dow + 7) % 7) + (dow >= d.getDay() ? 0 : 7));
                    // align to the week containing `base`, starting Sunday
                    const weekStart = new Date(base);
                    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
                    const slot = new Date(weekStart);
                    slot.setDate(slot.getDate() + dow);
                    slot.setHours(first.getHours(), first.getMinutes(), first.getSeconds(), 0);
                    if (slot.getTime() >= ev.start.ms) slots.push(slot.getTime());
                });
            } else {
                slots.push(base.getTime());
            }
            for (const s of slots.sort((a, b) => a - b)) {
                if (emitted >= count) return hits;
                if (s > until) return hits;
                emitted++;
                push(s);
            }
            if (base.getTime() > winEnd) break;
        }
        return hits;
    }

    function startOfToday() {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    }

    function refreshCalendar() {
        const url = loadIcsUrl();
        if (!url) {
            calState = 'unset';
            calItems = [];
            renderSidebar();
            return Promise.resolve();
        }
        if (calState === 'idle') calState = 'loading';
        return gmFetch(url).then(text => {
            const events = parseIcs(text);
            if (!events) {
                calState = 'error';
                calItems = [];
            } else {
                const winStart = startOfToday();
                const winEnd = winStart + CAL_DAYS * 86400000;
                // A RECURRENCE-ID event is a moved/edited single instance; keep it and drop
                // the series' own occurrence at that original time.
                const overrides = new Set(events.filter(e => e.recurrenceId)
                    .map(e => `${e.uid}|${e.recurrenceId}`));
                calItems = events
                    .filter(e => e.status !== 'CANCELLED')
                    .flatMap(e => expandEvent(e, winStart, winEnd)
                        .filter(h => e.recurrenceId || !overrides.has(`${e.uid}|${h.start}`)))
                    .sort((a, b) => (a.allDay === b.allDay ? a.start - b.start : (a.allDay ? -1 : 1)));
                calState = 'ok';
            }
            renderSidebar();
        });
    }

    function startCalendarPolling() {
        clearInterval(calTimer);
        refreshCalendar();
        calTimer = setInterval(refreshCalendar, CAL_POLL_MS);
    }

    function timeOfDay(ms) {
        return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }

    function buildCalRow(item) {
        const row = document.createElement('div');
        row.className = 'gm-news-list-row gm-cal-row';
        Object.assign(row.style, {
            display: 'flex', alignItems: 'flex-start', gap: '7px',
            padding: '6px 8px', borderRadius: '6px', cursor: 'pointer',
            transition: 'background .15s',
        });
        const now = Date.now();
        // Only timed events get the now/past treatment. An all-day event technically
        // spans "now" all day, so highlighting it would mean a permanent highlight that
        // says nothing about what's imminent.
        if (!item.allDay) {
            if (item.start <= now && item.end > now) row.dataset.live = '1';
            else if (item.end <= now) row.dataset.past = '1';
        }

        const when = document.createElement('div');
        when.className = 'gm-cal-when';
        when.textContent = item.allDay ? 'all day' : timeOfDay(item.start);
        Object.assign(when.style, {
            width: '62px', minWidth: '62px', flex: 'none', fontVariantNumeric: 'tabular-nums',
        });
        const body = document.createElement('div');
        Object.assign(body.style, { minWidth: '0', flex: '1' });
        const title = document.createElement('div');
        title.className = 'gm-news-list-title';
        title.textContent = item.title;
        Object.assign(title.style, {
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        });
        const meta = document.createElement('div');
        meta.className = 'gm-row-meta';
        meta.textContent = [
            !item.allDay && `${timeOfDay(item.start)} – ${timeOfDay(item.end)}`,
            item.location,
        ].filter(Boolean).join(' · ');
        Object.assign(meta.style, {
            marginTop: '1px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            display: meta.textContent ? '' : 'none',
        });
        body.append(title, meta);
        row.append(when, body);
        row.addEventListener('click', () => GM_openInTab(
            `https://calendar.google.com/calendar/r/day/${new Date(item.start).getFullYear()}/${new Date(item.start).getMonth() + 1}/${new Date(item.start).getDate()}`,
            { active: true }));
        return row;
    }

    function buildDayLabel(text, count) {
        const d = document.createElement('div');
        d.className = 'gm-cal-day';
        d.textContent = count ? `${text} · ${count}` : `${text} · nothing scheduled`;
        Object.assign(d.style, {
            padding: '6px 8px 2px', fontSize: '13px', fontWeight: '500',
            letterSpacing: '0.3px', textTransform: 'uppercase',
        });
        return d;
    }

    // ── sidebar news zone: takes over YouTube's right column from related videos ──
    let sidebar, sidebarPanel, homePanel;
    const panels = []; // every mounted feed panel; all re-render together

    function loadMailFilter() {
        // undefined/null means never set -> use the default;
        // '' means the user cleared it on purpose and that choice is remembered
        const stored = gmStore
            ? GM_getValue(MAIL_FILTER_KEY, null)
            : localStorage.getItem(MAIL_FILTER_KEY);
        return stored === null || stored === undefined ? DEFAULT_MAIL_FILTER : String(stored);
    }

    function saveMailFilter(q) {
        if (gmStore) GM_setValue(MAIL_FILTER_KEY, q);
        else localStorage.setItem(MAIL_FILTER_KEY, q);
    }

    // migrate a filter set by an older version before GM storage was used
    function migrateMailFilter() {
        if (!gmStore) return;
        const legacy = localStorage.getItem(MAIL_FILTER_KEY);
        if (legacy !== null && GM_getValue(MAIL_FILTER_KEY, null) === null) {
            GM_setValue(MAIL_FILTER_KEY, legacy);
        }
        localStorage.removeItem(MAIL_FILTER_KEY);
    }

    // Matches across sender, subject and snippet. The query is a keyword list:
    //   "airbnb, amazon"     -> keep mail mentioning EITHER (comma = OR)
    //   "airbnb receipt"     -> both words must appear (space = AND within one keyword)
    //   "airbnb receipt, ups" -> (airbnb AND receipt) OR ups
    function parseMailFilter(query) {
        return query.toLowerCase().split(',')
            .map(group => group.split(/\s+/).filter(Boolean))
            .filter(group => group.length);
    }

    // Canonical "a, b, c" form for the stored keyword list: trim each entry, drop empties,
    // collapse inner runs of whitespace, and drop case-insensitive duplicates while keeping
    // the first spelling typed. Matching already tolerates messy input; this is so the
    // saved value stays tidy when it is read back into the field on the other host.
    function normalizeMailFilter(query) {
        const seen = new Set();
        return query.split(',')
            .map(part => part.trim().replace(/\s+/g, ' '))
            .filter(part => {
                if (!part) return false;
                const key = part.toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .join(', ');
    }

    function matchesMailFilter(item, query) {
        const groups = parseMailFilter(query);
        if (!groups.length) return true;
        const hay = `${item.from} ${item.title} ${item.summary}`.toLowerCase();
        return groups.some(terms => terms.every(t => hay.includes(t)));
    }

    function loadSidebarOn() {
        return localStorage.getItem(SIDEBAR_KEY) !== '0'; // on by default
    }

    function applyRelatedHidden(hidden) {
        document.documentElement.classList.toggle('gm-hide-related', hidden);
    }

    // Measure the real background rather than trusting html[dark]: YouTube sets that
    // attribute, but assuming its absence means "light" paints near-black text on a dark
    // card whenever the attribute is late, renamed, or missing.
    function detectLightTheme() {
        const candidates = [
            getComputedStyle(document.documentElement)
                .getPropertyValue('--yt-spec-general-background-a').trim(),
            getComputedStyle(document.body).backgroundColor,
            getComputedStyle(document.documentElement).backgroundColor,
        ];
        for (const probe of candidates) {
            const m = (probe || '').match(/[\d.]+/g);
            if (!m || m.length < 3) continue;
            // a fully transparent surface says nothing about the theme — keep looking
            if (m.length > 3 && Number(m[3]) === 0) continue;
            const [r, g, b] = m.map(Number);
            return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 128; // light if bright
        }
        // nothing measurable: trust YouTube's attribute, and assume light elsewhere
        return IS_YT ? !document.documentElement.hasAttribute('dark') : true;
    }

    function applyThemeClass() {
        document.documentElement.classList.toggle('gm-light', detectLightTheme());
        // lets the stylesheet target Google-only colors without leaking into YouTube
        document.documentElement.classList.toggle('gm-google', IS_GOOGLE);
    }

    // title + count (+ optional trailing control) header shared by all sections.
    // reserveRight leaves room for the panel-level toggle pinned over this row's corner;
    // it has to be inline because the padding below is inline and would outrank CSS.
    function buildSectionHead(titleText, trailing, reserveRight) {
        const head = document.createElement('div');
        Object.assign(head.style, {
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: `2px ${reserveRight ? reserveRight + 'px' : '6px'} 8px 6px`,
        });
        const heading = document.createElement('div');
        heading.className = 'gm-section-head';
        heading.textContent = titleText;
        Object.assign(heading.style, { fontSize: '17px', fontWeight: '500', flex: '1' });
        const count = document.createElement('span');
        count.className = 'gm-section-count';
        Object.assign(count.style, { fontSize: '13px' });
        head.append(heading, count);
        if (trailing) head.appendChild(trailing);
        return { head, count };
    }

    // Builds one StudyTube feed panel (Calendar + Inbox + AI news). Two live at once: the
    // watch-page sidebar and the home-page feed, so nothing here may touch module-level
    // singletons -- each panel keeps its own element refs and registers itself in `panels`.
    // opts.wide relaxes the scroll caps for the roomy home layout.
    // opts.toggle is the {label, title, onClick} for the panel-level control, or null.
    function buildPanel(opts = {}) {
        const panel = document.createElement('div');
        panel.className = 'gm-feed-panel';
        if (opts.id) panel.id = opts.id;
        Object.assign(panel.style, {
            position: 'relative', // anchors the pinned toggle below
            marginBottom: '16px',
            padding: opts.wide ? '14px 16px' : '10px',
            border: '1px solid',
            borderRadius: '12px',
            fontFamily: 'Roboto, sans-serif',
            fontSize: '15px', // base size for both sections; rows scale off this
            lineHeight: '1.45',
        });

        // Panel-level control (e.g. "Videos" to bring back related videos), pinned to the
        // panel's top-right. It used to sit in the AI-news section header, which put a
        // whole-panel action inside one section and buried it mid-panel.
        let toggle = null;
        if (opts.toggle) {
            toggle = document.createElement('button');
            toggle.className = 'gm-side-btn gm-panel-toggle';
            toggle.textContent = opts.toggle.label;
            toggle.title = opts.toggle.title;
            toggle.addEventListener('click', opts.toggle.onClick);
            panel.appendChild(toggle);
        }

        // ── Calendar first: an appointment in 20 minutes outranks any unread mail ──
        const calSection = document.createElement('div');
        calSection.className = 'gm-cal-section';
        // 88px clears the pinned toggle in the panel's top-right corner
        const calHead = buildSectionHead('Today & tomorrow', null, opts.toggle ? 88 : 0);
        calSection.appendChild(calHead.head);
        // Built once and kept outside calBody, which renderCalendarInto() wipes on every
        // poll — same reason the mail filter lives in its header.
        const calSetupEl = buildIcsSetup();
        calSection.appendChild(calSetupEl);
        const calBodyEl = document.createElement('div');
        Object.assign(calBodyEl.style, {
            maxHeight: opts.wide ? '34vh' : '30vh', overflowY: 'auto',
        });
        calSection.appendChild(calBodyEl);
        panel.appendChild(calSection);

        // ── Inbox second: mail is time-sensitive, news is browsable ──
        const mailHead = buildSectionHead('Unread inbox');
        mailHead.head.classList.add('gm-mail-section');
        const mailSection = document.createElement('div');
        mailSection.className = 'gm-divider gm-mail-section-wrap';
        Object.assign(mailSection.style, {
            marginTop: '10px', paddingTop: '8px', borderTop: '1px solid',
        });
        mailSection.appendChild(mailHead.head);
        panel.appendChild(mailSection);

        // The input lives in the header, never inside mailBody: renderMail() wipes the
        // body on every poll, which would kill focus mid-typing.
        const filter = document.createElement('input');
        filter.className = 'gm-filter';
        filter.type = 'search';
        filter.placeholder = 'Keywords, comma-separated — e.g. airbnb, amazon';
        filter.value = loadMailFilter();
        filter.spellcheck = false;
        Object.assign(filter.style, {
            width: '100%',
            boxSizing: 'border-box',
            margin: '0 0 6px',
            padding: '5px 9px',
            border: '1px solid',
            borderRadius: '999px',
            background: 'transparent',
            fontFamily: 'inherit',
            fontSize: '14px',
            // no inline outline: the :focus ring is set in CSS, and an inline value here
            // would outrank it
        });
        const applyFilter = (value) => {
            saveMailFilter(value);
            // every panel re-renders, and their inputs sync, so both views agree
            panels.forEach(p => {
                if (p.filter !== filter) p.filter.value = value;
                renderMailInto(p);
            });
        };
        // Saved on every keystroke, so nothing is lost if the tab closes mid-edit.
        filter.addEventListener('input', () => applyFilter(filter.value));
        // Tidy up to canonical "a, b, c" only once the edit is finished. Doing this on
        // input would fight the typist: the trailing comma in "airbnb," would be stripped
        // before the next keyword could be typed.
        const tidy = () => {
            const clean = normalizeMailFilter(filter.value);
            if (clean === filter.value) return;
            filter.value = clean;
            applyFilter(clean);
        };
        filter.addEventListener('change', tidy); // fires on blur and on native search-commit
        filter.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') tidy();
            // Esc clears the filter without leaving the field
            if (e.key === 'Escape') {
                e.stopPropagation();
                filter.value = '';
                applyFilter('');
            }
        });
        // typing here must not reach YouTube's single-key shortcuts (k/j/l/f…)
        ['keydown', 'keyup', 'keypress'].forEach(t =>
            filter.addEventListener(t, e => e.stopPropagation()));
        mailSection.appendChild(filter);

        const mailBodyEl = document.createElement('div');
        // named, not found positionally: elements have been inserted between the filter and
        // this body more than once, silently breaking anything anchored off nextElementSibling
        mailBodyEl.className = 'gm-mail-body';
        Object.assign(mailBodyEl.style, {
            maxHeight: opts.wide ? '40vh' : '34vh', overflowY: 'auto',
        });
        mailSection.appendChild(mailBodyEl);

        // ── AI news second, separated by a rule ──
        const newsSection = document.createElement('div');
        newsSection.className = 'gm-divider gm-news-section';
        Object.assign(newsSection.style, {
            marginTop: '10px',
            paddingTop: '8px',
            borderTop: '1px solid',
        });

        const newsHead = buildSectionHead('AI research news');
        newsSection.appendChild(newsHead.head);

        const newsBodyEl = document.createElement('div');
        Object.assign(newsBodyEl.style, {
            maxHeight: opts.wide ? '52vh' : '46vh', overflowY: 'auto',
        });
        newsSection.appendChild(newsBodyEl);
        panel.appendChild(newsSection);

        const rec = {
            el: panel, filter,
            calBody: calBodyEl, calCount: calHead.count,
            calSetup: calSetupEl, calInput: calSetupEl.querySelector('.gm-ics-input'),
            calHint: calSetupEl.querySelector('.gm-ics-hint'),
            mailBody: mailBodyEl, mailCount: mailHead.count,
            newsBody: newsBodyEl, newsCount: newsHead.count,
            toggleBtn: toggle,
        };
        // deferred background refreshes land as soon as the cursor leaves this panel
        panel.addEventListener('mouseleave', flushDeferredRender);
        panels.push(rec);
        return rec;
    }

    function buildSidebar() {
        const rec = buildPanel({
            id: 'gm-news-sidebar',
            toggle: {
                label: 'Videos',
                title: 'Show related videos instead',
                onClick: () => {
                    localStorage.setItem(SIDEBAR_KEY, loadSidebarOn() ? '0' : '1');
                    applySidebarState();
                },
            },
        });
        sidebar = rec.el;
        sidebarPanel = rec;
        return sidebar;
    }

    // re-render every mounted panel (watch sidebar and/or home feed)
    // Re-rendering wipes and rebuilds every row, which destroys the element under the
    // cursor: an open hover preview dies and a click can land on a row that just moved.
    // A background refresh therefore waits until the pointer leaves the panel; anything
    // the user asked for (typing a keyword, toggling a section) still renders at once.
    let renderDeferred = false;

    function pointerInsidePanel() {
        return panels.some(p => p.el.matches(':hover'));
    }

    function renderSidebar(opts = {}) {
        if (!opts.force && pointerInsidePanel()) {
            renderDeferred = true; // flushed by the mouseleave handler below
            return;
        }
        renderDeferred = false;
        panels.forEach(renderPanel);
    }

    // when the cursor leaves a panel, apply whatever arrived while it was hovering
    function flushDeferredRender() {
        if (renderDeferred && !pointerInsidePanel()) renderSidebar({ force: true });
    }

    function renderPanel(p) {
        const body = p.newsBody;
        body.textContent = '';
        p.newsCount.textContent = newsItems.length
            ? `last ${NEWS_MAX_AGE_DAYS} days · ${newsItems.length}` : '';
        if (!newsItems.length) {
            const empty = document.createElement('div');
            empty.className = 'gm-note';
            empty.textContent = 'Loading AI news…';
            Object.assign(empty.style, { padding: '8px 6px' });
            body.appendChild(empty);
        } else {
            const live = currentItem();
            newsItems.forEach(item => body.appendChild(buildNewsRow(item, item === live)));
        }
        // each section is independent; a failure in one must not blank the others
        renderCalendarInto(p);
        renderMailInto(p);
    }

    function renderCalendarInto(p) {
        const body = p.calBody;
        body.textContent = '';
        const note = (text) => {
            const d = document.createElement('div');
            d.className = 'gm-note';
            d.textContent = text;
            Object.assign(d.style, { padding: '6px 8px', fontSize: '14px' });
            return d;
        };
        // The setup field shows while unconfigured or broken, and hides once events flow;
        // it is never re-created here, so typing a long URL survives a poll landing.
        const needsSetup = calState === 'unset' || calState === 'error';
        p.calSetup.style.display = needsSetup ? '' : 'none';
        p.calHint.style.display = calState === 'error' ? 'none' : '';
        if (document.activeElement !== p.calInput) p.calInput.value = loadIcsUrl();
        if (calState === 'unset') {
            p.calCount.textContent = '';
            return;
        }
        if (calState === 'idle' || calState === 'loading') {
            p.calCount.textContent = '';
            body.appendChild(note('Loading calendar…'));
            return;
        }
        if (calState === 'error') {
            p.calCount.textContent = '';
            body.appendChild(note("Couldn't read that calendar feed — check the iCal URL"));
            return;
        }
        const dayStart = startOfToday();
        const groups = [
            { label: 'Today', items: calItems.filter(i => i.start < dayStart + 86400000) },
            { label: 'Tomorrow', items: calItems.filter(i => i.start >= dayStart + 86400000) },
        ];
        p.calCount.textContent = calItems.length ? String(calItems.length) : '';
        groups.forEach(g => {
            body.appendChild(buildDayLabel(g.label, g.items.length));
            g.items.forEach(i => body.appendChild(buildCalRow(i)));
        });
    }

    // One-time setup row. The iCal URL is a bearer credential, so the copy says so and the
    // field is a password input — a shoulder-surfer or a screenshare shouldn't leak it.
    function buildIcsSetup() {
        const wrap = document.createElement('div');
        Object.assign(wrap.style, { padding: '4px 8px 8px' });
        const hint = document.createElement('div');
        hint.className = 'gm-note gm-ics-hint';
        hint.textContent = 'Paste a calendar iCal URL to show today and tomorrow. '
            + 'Google Calendar → Settings → your calendar → “Secret address in iCal format”. '
            + 'Treat it like a password: anyone with the link can read that calendar.';
        Object.assign(hint.style, { fontSize: '13px', marginBottom: '6px', whiteSpace: 'normal' });
        wrap.appendChild(hint);
        const inp = document.createElement('input');
        // deliberately NOT .gm-filter: that class means the keyword field, and sharing it
        // would make `.gm-filter` ambiguous within a panel
        inp.className = 'gm-ics-input';
        inp.type = 'password'; // it is a secret URL, not a navigable link
        inp.autocomplete = 'off';
        inp.placeholder = 'https://calendar.google.com/calendar/ical/…/basic.ics';
        inp.value = loadIcsUrl();
        inp.spellcheck = false;
        Object.assign(inp.style, {
            width: '100%', boxSizing: 'border-box', margin: '0',
            padding: '5px 9px', border: '1px solid', borderRadius: '999px',
            background: 'transparent', fontFamily: 'inherit', fontSize: '13px',
            // outline intentionally unset here; see the :focus rule in ensurePanelStyles
        });
        const commit = () => {
            const v = inp.value.trim();
            if (v === loadIcsUrl()) return;
            saveIcsUrl(v);
            // keep the other panel's field in step, the way the keyword filter does
            panels.forEach(p => { if (p.calInput && p.calInput !== inp) p.calInput.value = v; });
            calState = 'idle';
            calItems = [];
            startCalendarPolling();
        };
        inp.addEventListener('change', commit);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
        // never let the URL reach YouTube's or Google's own key handlers
        ['keydown', 'keyup', 'keypress'].forEach(t =>
            inp.addEventListener(t, e => e.stopPropagation()));
        wrap.appendChild(inp);
        return wrap;
    }

    function renderMailInto(p) {
        const mailBody = p.mailBody;
        const mailCount = p.mailCount;
        mailBody.textContent = '';
        // Nothing to filter until mail is loaded, but a stale query must stay visible so it
        // isn't silently dropped mid-fetch — and so a keyword hiding everything can still
        // be cleared. mailItems includes read mail, so this survives an empty unread feed.
        p.filter.style.display = mailItems.length || p.filter.value ? '' : 'none';
        const note = (text) => {
            const d = document.createElement('div');
            d.className = 'gm-note';
            d.textContent = text;
            Object.assign(d.style, { padding: '6px 8px', fontSize: '14px' });
            return d;
        };
        if (mailState === 'loading' || mailState === 'idle') {
            mailCount.textContent = '';
            mailBody.appendChild(note('Checking Gmail…'));
            return;
        }
        // A failed fetch still shows the archive below the warning, so a filtered view
        // keeps its history instead of going blank.
        if (mailState === 'signedout' || mailState === 'error') {
            mailCount.textContent = '';
            const link = document.createElement('div');
            link.className = 'gm-link';
            link.textContent = mailState === 'signedout'
                ? 'Sign in to Gmail to show unread mail'
                : "Couldn't reach Gmail — open inbox";
            Object.assign(link.style, {
                padding: '6px 8px', fontSize: '14px', cursor: 'pointer',
            });
            link.addEventListener('click', () => GM_openInTab('https://mail.google.com/', { active: true }));
            mailBody.appendChild(link);
            if (!mailItems.length) return;
        }
        // "Inbox zero" only when nothing is filtered out; with a keyword active an empty
        // list means the filter matched nothing, which the branch below words correctly.
        if (!mailItems.length && !loadMailFilter().trim()) {
            mailCount.textContent = '';
            mailBody.appendChild(note('No unread mail 🎉'));
            return;
        }
        const query = loadMailFilter().trim();
        const shown = query ? mailItems.filter(i => matchesMailFilter(i, query)) : mailItems;
        const unread = shown.filter(i => i.unread).length;
        // Lead with the unread count, since that is the section's whole purpose, and add
        // the row total only when they differ (i.e. some listed mail has since been read).
        mailCount.textContent = shown.length
            ? (unread === shown.length ? `${unread} unread`
                : unread ? `${unread} unread · ${shown.length} shown`
                    : `${shown.length} since read`)
            : '';
        if (!shown.length) {
            // this section only ever saw unread mail, so scope the message to that rather
            // than implying the keyword matches nothing in Gmail at all
            mailBody.appendChild(note(`No unread mail matching “${query}”`));
            return;
        }
        shown.forEach(item => mailBody.appendChild(buildMailRow(item)));
    }

    function applySidebarState() {
        const on = loadSidebarOn();
        applyRelatedHidden(on);
        if (sidebar) {
            sidebar.style.display = on ? '' : 'none';
            // when related videos are back, leave a small affordance to switch news on again
            if (restoreNewsBtn) restoreNewsBtn.style.display = on ? 'none' : '';
        }
        if (on) renderSidebar();
    }

    let restoreNewsBtn;
    function buildRestoreNewsBtn() {
        restoreNewsBtn = document.createElement('button');
        restoreNewsBtn.className = 'gm-side-btn';
        restoreNewsBtn.textContent = '📰 AI research news';
        Object.assign(restoreNewsBtn.style, {
            display: 'none',
            width: '100%',
            marginBottom: '12px',
            padding: '7px 10px',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            background: 'transparent',
            color: 'var(--yt-spec-text-primary, #f1f1f1)',
            borderRadius: '999px',
            fontSize: '14px',
            fontFamily: 'Roboto, sans-serif',
            cursor: 'pointer',
        });
        restoreNewsBtn.addEventListener('click', () => {
            localStorage.setItem(SIDEBAR_KEY, '1');
            applySidebarState();
        });
        return restoreNewsBtn;
    }

    // shared by the watch sidebar and the home feed, so it can't live inside either mount
    function ensurePanelStyles() {
        if (!document.getElementById('gm-news-sidebar-style')) {
            const style = document.createElement('style');
            style.id = 'gm-news-sidebar-style';
            style.textContent = `
                /* #related is the usual wrapper; the renderer covers layouts where it isn't */
                html.gm-hide-related #secondary #related,
                html.gm-hide-related #secondary ytd-watch-next-secondary-results-renderer {
                    display: none !important;
                }
                /* Follow YouTube's own theme tokens so text stays readable in light and
                   dark mode; the hardcoded fallbacks cover the dark default. */
                .gm-feed-panel {
                    --gm-fg: var(--yt-spec-text-primary, #f1f1f1);
                    --gm-fg-dim: var(--yt-spec-text-secondary, #aaa);
                    --gm-title: #fff; /* dark mode: brightest ink; light mode overrides to near-black */
                    --gm-line: var(--yt-spec-10-percent-layer, rgba(255, 255, 255, 0.15));
                    /* ONE accent for all three sections. The zones were previously tinted
                       amber/green/blue, which made a single panel read as three unrelated
                       widgets; the headings already say which section you are in. */
                    --gm-accent: #7cc3ff;
                    --gm-hover: rgba(124, 195, 255, 0.14);
                    --gm-live: rgba(124, 195, 255, 0.1);
                    /* input fill, so editable text sits on its own surface rather than on
                       the panel's tint */
                    --gm-input-bg: rgba(255, 255, 255, 0.07);
                    background: var(--yt-spec-general-background-b, rgba(255, 255, 255, 0.04));
                    border-color: var(--gm-line) !important;
                    color: var(--gm-fg);
                }
                .gm-feed-panel .gm-row-meta { color: var(--gm-fg-dim); font-size: 13px; }
                .gm-feed-panel .gm-note { color: var(--gm-fg-dim); font-size: 14px; }
                /* ── ONE row treatment for all three sections ──
                   Calendar, Inbox and news rows previously each had their own accent,
                   title size and meta size. They now share this block; only the few
                   genuinely per-section bits (the time column, read/past dimming) differ. */
                .gm-feed-panel .gm-news-list-row,
                .gm-feed-panel .gm-cal-row,
                .gm-feed-panel .gm-mail-row {
                    padding: 8px;
                    border-left: 2px solid transparent;
                    padding-left: 8px;
                }
                /* one title style everywhere */
                .gm-feed-panel .gm-news-list-title {
                    font-size: 15px;
                    font-weight: 500;
                    color: var(--gm-title);
                    letter-spacing: 0.1px;
                }
                /* one secondary style everywhere */
                .gm-feed-panel .gm-row-meta { color: var(--gm-fg-dim); font-size: 13px; }
                /* one hover treatment everywhere */
                .gm-feed-panel .gm-news-list-row:hover,
                .gm-feed-panel .gm-cal-row:hover,
                .gm-feed-panel .gm-mail-row:hover {
                    border-left-color: var(--gm-accent);
                    background: var(--gm-hover);
                }
                .gm-feed-panel .gm-news-list-row:hover .gm-news-list-title,
                .gm-feed-panel .gm-cal-row:hover .gm-news-list-title,
                .gm-feed-panel .gm-mail-row:hover .gm-news-list-title {
                    color: var(--gm-accent);
                }
                /* one "current item" treatment: the live news headline, and a meeting
                   happening right now */
                .gm-feed-panel .gm-news-list-row[data-live="1"],
                .gm-feed-panel .gm-cal-row[data-live="1"] {
                    border-left-color: var(--gm-accent);
                    background: var(--gm-live);
                }
                /* one heading style: the section name carries no color of its own */
                .gm-feed-panel .gm-section-head { color: var(--gm-fg); }
                /* leading icon/marker column, shared by the envelope dot and the time */
                .gm-feed-panel .gm-mail-icon {
                    color: var(--gm-accent);
                    font-size: 10px; /* the ●/○ marker, not text */
                }
                .gm-feed-panel .gm-cal-when {
                    color: var(--gm-accent);
                    font-size: 13px;
                    font-weight: 500;
                }
                /* ── the only per-section differences, both about de-emphasis ── */
                /* read mail: legible, but stepped back so unread keeps priority */
                .gm-feed-panel .gm-mail-row[data-read="1"] .gm-news-list-title,
                .gm-feed-panel .gm-mail-row[data-read="1"] .gm-mail-icon {
                    font-weight: 400;
                    color: var(--gm-fg-dim);
                }
                /* a meeting that is already over */
                .gm-feed-panel .gm-cal-row[data-past="1"] .gm-news-list-title,
                .gm-feed-panel .gm-cal-row[data-past="1"] .gm-cal-when {
                    color: var(--gm-fg-dim);
                    font-weight: 400;
                }
                .gm-feed-panel .gm-cal-day { color: var(--gm-fg-dim); }
                .gm-feed-panel .gm-ics-input { margin-top: 2px; }
                html.gm-light .gm-feed-panel {
                    --gm-title: #030303; /* darker than --gm-fg's #0f0f0f */
                    --gm-accent: #1a63b8;
                    --gm-hover: rgba(26, 99, 184, 0.1);
                    --gm-live: rgba(26, 99, 184, 0.07);
                    --gm-input-bg: rgba(0, 0, 0, 0.05);
                }
                .gm-feed-panel .gm-section-head { color: var(--gm-fg); }
                .gm-feed-panel .gm-section-count { color: var(--gm-fg-dim); }
                .gm-feed-panel .gm-divider { border-color: var(--gm-line); }
                /* YouTube's own link blue, which differs between light and dark */
                .gm-feed-panel .gm-link { color: var(--gm-link, var(--yt-spec-call-to-action, #3ea6ff)); }
                .gm-feed-panel .gm-link:hover { text-decoration: underline; }
                .gm-feed-panel .gm-filter,
                .gm-feed-panel .gm-ics-input {
                    /* The strongest ink, not --gm-fg: this is text you are actively editing,
                       so it should read at least as clearly as the rows below it. The
                       transparent original also sat straight on the panel's tinted surface,
                       which left very little separation. */
                    color: var(--gm-title);
                    font-weight: 500;
                    background: var(--gm-input-bg) !important;
                    border-color: var(--gm-line);
                    /* Explicit, and not inherited: an ancestor caret-color (or a host page
                       that sets it to transparent) would otherwise hide the caret. */
                    caret-color: var(--gm-fg);
                    cursor: text;
                    /* both hosts set user-select: none on chunks of their chrome; an
                       inherited value can suppress the caret and text selection */
                    user-select: text;
                    -webkit-user-select: text;
                }
                /* Placeholder stays dim so it can't be mistaken for a real value, but it is
                   still measured against 4.5:1. */
                .gm-feed-panel .gm-filter::placeholder,
                .gm-feed-panel .gm-ics-input::placeholder {
                    color: var(--gm-fg-dim);
                    font-weight: 400;
                }
                /* The inline outline:none left focus signalled only by a faint border tint.
                   Give it a real ring, and thicken the caret so it is easy to spot. */
                .gm-feed-panel .gm-filter:focus,
                .gm-feed-panel .gm-ics-input:focus {
                    border-color: var(--yt-spec-call-to-action, #3ea6ff);
                    outline: 2px solid var(--yt-spec-call-to-action, #3ea6ff);
                    outline-offset: 1px;
                    caret-color: var(--yt-spec-call-to-action, #3ea6ff);
                }
                /* Panel-level control pinned to the top-right corner. Sits above the
                   sections rather than inside one, since it acts on the whole panel. */
                .gm-feed-panel .gm-panel-toggle {
                    position: absolute;
                    top: 8px;
                    right: 10px;
                    z-index: 2;
                    border: 1px solid;
                    background: var(--gm-input-bg);
                    border-radius: 999px;
                    padding: 3px 10px;
                    font-size: 13px;
                    font-family: inherit;
                    cursor: pointer;
                }
                .gm-side-btn {
                    color: var(--yt-spec-text-primary, #f1f1f1);
                    border-color: var(--yt-spec-10-percent-layer, rgba(255, 255, 255, 0.2));
                }
                .gm-side-btn:hover {
                    background: var(--yt-spec-badge-chip-background, rgba(255, 255, 255, 0.12)) !important;
                }
                /* ── home feed: docked as a right-hand column ──
                   The recommendation grid stays visible and keeps the left; the panel is
                   fixed to the right so it doesn't scroll away with the grid. The grid
                   gets right padding so videos never run underneath it. */
                html.gm-home-side #gm-home-feed {
                    position: fixed;
                    top: 70px; /* clears YouTube's masthead */
                    right: 16px;
                    width: var(--gm-home-width, 360px);
                    max-height: calc(100vh - 86px);
                    overflow-y: auto;
                    box-sizing: border-box;
                    margin: 0;
                    z-index: 2000;
                }
                html.gm-home-side ytd-browse[page-subtype="home"] {
                    padding-right: calc(var(--gm-home-width, 360px) + 32px);
                    box-sizing: border-box;
                }
                /* Below this the reserved column would leave too little room for a usable
                   grid, so the panel returns to the normal document flow at the top. */
                @media (max-width: 1100px) {
                    html.gm-home-side #gm-home-feed {
                        position: static;
                        width: auto;
                        max-width: 900px;
                        max-height: none;
                        margin: 8px auto 24px;
                    }
                    html.gm-home-side ytd-browse[page-subtype="home"] { padding-right: 0; }
                }
                /* ── hover preview for news rows ──
                   position: fixed so it escapes the panel's scroll container, and
                   pointer-events: none so it can never sit between cursor and row. */
                #gm-row-preview {
                    position: fixed;
                    display: none;
                    z-index: 2147483000;
                    box-sizing: border-box; /* so max-width is the real painted width */
                    max-width: 380px;
                    padding: 10px 12px;
                    border: 1px solid var(--gm-line);
                    border-radius: 10px;
                    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
                    font-family: Roboto, sans-serif;
                    font-size: 14px;
                    line-height: 1.45;
                    pointer-events: none;
                    /* opaque: a translucent card over dense text is unreadable */
                    background: var(--yt-spec-general-background-a, #1f1f23);
                    color: var(--gm-fg);
                }
                /* On YouTube the --yt-spec-* tokens drive this; only the background needs a
                   light-mode value, since the fallback above is dark. */
                html.gm-light #gm-row-preview { background: #fff; }
                #gm-row-preview .gm-rp-title {
                    font-weight: 500;
                    color: var(--gm-title);
                    margin-bottom: 3px;
                }
                #gm-row-preview .gm-rp-meta {
                    color: var(--gm-fg-dim);
                    font-size: 12px;
                    margin-bottom: 4px;
                }
                #gm-row-preview .gm-rp-desc { color: var(--gm-fg-dim); }
                #gm-row-preview .gm-rp-url {
                    color: var(--gm-link, var(--yt-spec-call-to-action, #3ea6ff));
                    font-size: 11px;
                    margin-top: 5px;
                    overflow-wrap: anywhere;
                }
                /* ── Google search results: the panel rides the right-hand column ──
                   Google ships no theme custom properties, so the panel needs its own
                   surface here rather than inheriting --yt-spec-*. */
                /* html.gm-google marks the Google host, so these tokens can't leak into the
                   YouTube panels, which must keep following --yt-spec-*. */
                html.gm-google #gm-google-panel,
                html.gm-google #gm-row-preview {
                    --gm-fg: #1f1f1f;
                    --gm-fg-dim: #4d5156;
                    --gm-title: #202124;
                    --gm-line: #dadce0;
                    /* Google defines no --yt-spec-call-to-action, so links would fall back
                       to the dark-mode blue (#3ea6ff) and land at 2.6:1 on this white card.
                       Google's own link blue clears 4.5:1. */
                    --gm-link: #1a0dab;
                    background: #fff;
                    color: var(--gm-fg);
                }
                #gm-google-panel {
                    width: 100%;
                    max-width: 380px;
                    box-sizing: border-box;
                }
                /* Google's dark mode, keyed off the measured surface (gm-light is absent)
                   rather than a Google-specific attribute, which it doesn't expose. */
                html.gm-google:not(.gm-light) #gm-google-panel,
                html.gm-google:not(.gm-light) #gm-row-preview {
                    --gm-fg: #e8eaed;
                    --gm-fg-dim: #9aa0a6;
                    --gm-title: #fff;
                    --gm-line: #3c4043;
                    --gm-link: #8ab4f8; /* Google's dark-mode link blue */
                    background: #202124;
                }
                #gm-google-host { margin: 0 0 16px; }
                /* on the Google home page there is no results rail; float it top-right */
                #gm-google-host.gm-float {
                    position: fixed;
                    top: 72px;
                    right: 20px;
                    width: 360px;
                    max-height: calc(100vh - 96px);
                    overflow-y: auto;
                    z-index: 900;
                }
            `;
            document.head.appendChild(style);
        }
    }

    function ensureSidebar() {
        if (!IS_YT || location.pathname !== '/watch') return;
        const inner = document.querySelector('#secondary-inner') || document.querySelector('#secondary');
        if (!inner) return;
        // already mounted — the fetch callbacks keep content fresh, and
        // re-rendering here would re-enter the MutationObserver that calls us
        if (sidebar && inner.contains(sidebar)) return;
        ensurePanelStyles();
        const panel = sidebar || buildSidebar();
        const restore = restoreNewsBtn || buildRestoreNewsBtn();
        inner.prepend(panel);
        inner.prepend(restore);
        applySidebarState();
        if (!mailTimer) startMailPolling();
        if (!calTimer) startCalendarPolling();
    }

    // ── home page: StudyTube feed instead of the recommendation grid ─────────
    function loadHomeFeedOn() {
        return localStorage.getItem(HOME_FEED_KEY) !== '0'; // on by default
    }

    function applyHomeFeedState() {
        const on = loadHomeFeedOn() && isHomePath();
        // gm-home-side docks the panel right and reserves grid space for it; the
        // recommendations stay visible, so there is nothing to "restore" anymore
        document.documentElement.classList.toggle('gm-home-side', on);
        if (homePanel) homePanel.el.style.display = on ? '' : 'none';
        if (homeRestoreBtn) homeRestoreBtn.style.display = on || !isHomePath() ? 'none' : '';
        if (on) renderSidebar();
    }

    function isHomePath() {
        return location.pathname === '/' || location.pathname === '/feed/explore';
    }

    let homeRestoreBtn;
    function ensureHomeFeed() {
        if (!IS_YT) return;
        // leaving home: drop the docking class so other pages keep their own layout
        if (!isHomePath()) {
            document.documentElement.classList.remove('gm-home-side');
            if (homePanel) homePanel.el.style.display = 'none';
            if (homeRestoreBtn) homeRestoreBtn.style.display = 'none';
            return;
        }
        const browse = document.querySelector('ytd-browse[page-subtype="home"]');
        if (!browse) return;
        // Mounted on ytd-browse rather than inside the grid: the panel is a fixed-position
        // sibling of the grid, so nesting it in the scrolling grid would fight the layout.
        const host = browse;
        if (homePanel && host.contains(homePanel.el)) return; // already mounted
        ensurePanelStyles();

        if (!homePanel) {
            homePanel = buildPanel({
                id: 'gm-home-feed',
                // narrow, not wide: it is a right-hand rail now, not a full-width feed
                toggle: {
                    label: 'Hide',
                    title: 'Hide the StudyTube panel',
                    onClick: () => {
                        localStorage.setItem(HOME_FEED_KEY, '0');
                        applyHomeFeedState();
                    },
                },
            });
        }
        if (!homeRestoreBtn) {
            homeRestoreBtn = document.createElement('button');
            homeRestoreBtn.className = 'gm-side-btn';
            homeRestoreBtn.id = 'gm-home-restore';
            homeRestoreBtn.textContent = '📰 StudyTube';
            // pinned top-right where the panel itself docks, so showing it again is where
            // you last saw it rather than centered over the grid
            Object.assign(homeRestoreBtn.style, {
                display: 'none',
                position: 'fixed',
                top: '70px',
                right: '16px',
                zIndex: '2000',
                padding: '8px 14px',
                border: '1px solid',
                background: 'var(--yt-spec-general-background-b, rgba(255,255,255,0.08))',
                borderRadius: '999px',
                fontSize: '14px',
                fontFamily: 'Roboto, sans-serif',
                cursor: 'pointer',
            });
            homeRestoreBtn.addEventListener('click', () => {
                localStorage.setItem(HOME_FEED_KEY, '1');
                applyHomeFeedState();
            });
        }
        host.prepend(homePanel.el);
        host.prepend(homeRestoreBtn);
        applyHomeFeedState();
        if (!mailTimer) startMailPolling();
        if (!calTimer) startCalendarPolling();
        if (!newsItems.length) primeNews();
    }

    // ── Google: the same panel, in the results page's right-hand column ──────
    let googlePanel, googleHost;

    function ensureGooglePanel() {
        if (!IS_GOOGLE) return;
        // Only the main search surface and the home page; leave Maps, Images, News,
        // Docs-style apps and every other Google product alone.
        const path = location.pathname;
        const onSearch = path === '/search';
        const onHome = path === '/' || path === '/webhp';
        if (!onSearch && !onHome) {
            if (googleHost) googleHost.style.display = 'none';
            return;
        }
        if (googleHost && document.body.contains(googleHost)) {
            googleHost.style.display = '';
            return; // already mounted
        }
        ensurePanelStyles();
        if (!googlePanel) googlePanel = buildPanel({ id: 'gm-google-panel' });
        if (!googleHost) {
            googleHost = document.createElement('div');
            googleHost.id = 'gm-google-host';
            googleHost.appendChild(googlePanel.el);
        }
        // #rhs is Google's knowledge-panel column; when it is absent (most queries and the
        // home page) the panel floats in the top-right instead of disturbing the results.
        const rhs = onSearch ? document.querySelector('#rhs') : null;
        googleHost.classList.toggle('gm-float', !rhs);
        (rhs || document.body).prepend(googleHost);
        googleHost.style.display = '';
        if (!mailTimer) startMailPolling();
        if (!calTimer) startCalendarPolling();
        if (!newsItems.length) primeNews();
    }

    function ensureOverlay() {
        if (!IS_YT) return;
        if (location.pathname !== '/watch') {
            if (overlay) overlay.style.visibility = 'hidden';
            if (restoreTab) restoreTab.style.visibility = 'hidden';
            if (preview) preview.style.display = 'none';
            return;
        }
        if (overlay) overlay.style.visibility = '';
        if (restoreTab) restoreTab.style.visibility = '';
        const currentPlayer = document.querySelector('#movie_player');
        if (!currentPlayer) return;

        if (overlay && player === currentPlayer && document.body.contains(overlay)) {
            return; // already attached to the live player
        }

        player = currentPlayer;
        if (getComputedStyle(player).position === 'static') {
            player.style.position = 'relative';
        }
        createOverlay();
    }

    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', endDrag);
    migrateMailFilter();

    // GM storage is shared, so a keyword edit in another tab should land here too
    if (typeof GM_addValueChangeListener === 'function') {
        GM_addValueChangeListener(MAIL_FILTER_KEY, (_key, _old, next, remote) => {
            if (!remote) return; // our own write already re-rendered
            panels.forEach(p => {
                if (document.activeElement !== p.filter) p.filter.value = next ?? '';
                renderMailInto(p);
            });
        });
    }

    // a calendar URL set on the other host should take effect here without a reload
    if (typeof GM_addValueChangeListener === 'function') {
        GM_addValueChangeListener(CAL_ICS_KEY, (_key, _old, _next, remote) => {
            if (!remote) return;
            calState = 'idle';
            calItems = [];
            startCalendarPolling();
        });
    }

    // Calendar rows carry now/past styling, so re-render on the minute even when nothing
    // fetches — otherwise a meeting stays "upcoming" until the next 10-minute poll.
    setInterval(() => { if (calState === 'ok') renderSidebar(); }, 60000);

    // re-checked on every pass so a theme switch mid-session repaints the panels
    const ensureAll = () => {
        applyThemeClass();
        ensureOverlay();
        ensureSidebar();
        ensureHomeFeed();
        ensureGooglePanel();
    };
    // YouTube's SPA navigation event; Google search does full page loads, but its results
    // are also swapped in place on some surfaces, which the observer below covers.
    document.addEventListener('yt-navigate-finish', ensureAll);

    new MutationObserver(ensureAll).observe(document.body, { childList: true, subtree: true });
    // A theme switch changes <html>'s attributes/inline style without necessarily touching
    // the body subtree, so the observer above can miss it and leave the panel painted for
    // the old theme. Watch <html> itself for that case.
    // 'class' is deliberately not watched: applyThemeClass toggles a class on this very
    // element, which would re-trigger the observer.
    new MutationObserver(applyThemeClass)
        .observe(document.documentElement, { attributes: true, attributeFilter: ['dark', 'style'] });
    ensureAll();
})();
