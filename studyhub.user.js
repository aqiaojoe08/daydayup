// ==UserScript==
// @name         StudyTube
// @namespace    yuliang.userscripts
// @version      1.14.0
// @description  Turns YouTube into a learning tool: covers burned-in captions with a movable overlay, streams AI-lab news (Anthropic, OpenAI, DeepMind), and hides the distracting Shorts shelf
// @author       yuliang
// @match        https://www.youtube.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      openai.com
// @connect      deepmind.google
// @connect      anthropic.com
// @connect      prod-pdx.yinliy.people.amazon.dev
// @downloadURL  https://github.com/aqiaojoe08/daydayup/raw/refs/heads/main/studyhub.user.js
// @updateURL    https://github.com/aqiaojoe08/daydayup/raw/refs/heads/main/studyhub.user.js
// ==/UserScript==
(function () {
    'use strict';

    const POS_KEY = 'gmYtCaptionHiderPos';
    const HIDE_KEY = 'gmYtCaptionHiderHidden';
    const DEFAULT_POS = { left: 20, top: 78, width: 60, height: 2 }; // percentages of player size
    const RESIZE_HANDLE = 16; // px, bottom-right corner reserved for CSS resize

    let overlay, restoreTab, preview, player, dragState, resizing;

    // hide the Shorts shelf on the home page (and Shorts entries elsewhere in feeds)
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
    new MutationObserver(retitle).observe(document.querySelector('title'), { childList: true });

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
            inset: '0 28px 0 10px',
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

        startNewsTicker(newsEl, newsIcon, newsText, newsDate, showPreview);

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
    let newsIdx = 0;
    let newsTimer;

    function currentItem() {
        // newsIdx already points past the item on display
        return newsItems.length ? newsItems[(newsIdx - 1 + newsItems.length) % newsItems.length] : null;
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
                `You are filtering an AI-news ticker for someone studying AI explainability/interpretability and agents.
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
                newsIdx = 0;
            }
        } catch (e) {
            console.info('[StudyTube] PowerChat filter unavailable, keeping heuristic results:', e.message);
        }
    }

    async function fetchAllNews() {
        const icon = (domain) => `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
        const sources = [
            // Anthropic has no RSS feed; scrape its research listing page instead
            gmFetch('https://www.anthropic.com/research').then(x => parseAnthropicResearch(x, icon('anthropic.com'), 8)),
            gmFetch('https://openai.com/news/rss.xml').then(x => filterOpenAIResearch(parseFeed(x, icon('openai.com'), 40), 8)),
            gmFetch('https://deepmind.google/research/publications/').then(x => parseDeepMindPubs(x, icon('deepmind.google'), 8)),
        ];
        // drop low-signal headlines with fewer than 5 words
        const results = (await Promise.all(sources))
            .map(r => r.filter(i => i.title.split(/\s+/).length >= 5));
        // interleave sources so one feed doesn't dominate the rotation
        const merged = [];
        for (let i = 0; merged.length < results.flat().length; i++) {
            results.forEach(r => r[i] && merged.push(r[i]));
        }
        return merged;
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

    function formatDate(raw) {
        const d = new Date(raw);
        if (isNaN(d)) return '';
        const days = Math.floor((Date.now() - d.getTime()) / 86400000);
        if (days <= 0) return 'today';
        if (days === 1) return '1 day ago';
        return `${days} days ago`;
    }

    function startNewsTicker(el, iconEl, textEl, dateEl, refreshPreview) {
        clearInterval(newsTimer);
        const show = () => {
            if (!newsItems.length) return;
            const item = newsItems[newsIdx % newsItems.length];
            iconEl.src = item.icon;
            iconEl.style.display = 'block';
            textEl.textContent = item.title;
            dateEl.textContent = item.date ? formatDate(item.date) : '';
            el.dataset.url = item.url;
            newsIdx++;
            if (el.matches(':hover')) refreshPreview();
        };
        if (newsItems.length) {
            show();
        } else {
            textEl.textContent = 'Loading AI news…';
            fetchAllNews().then(items => {
                newsItems = items;
                show();
                refineNewsWithPowerChat(); // async; silently no-ops without Midway
            });
        }
        newsTimer = setInterval(show, 30000);
    }

    function ensureOverlay() {
        if (location.pathname !== '/watch') {
            if (overlay) overlay.style.visibility = 'hidden';
            if (restoreTab) restoreTab.style.visibility = 'hidden';
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
    document.addEventListener('yt-navigate-finish', ensureOverlay);

    new MutationObserver(ensureOverlay).observe(document.body, { childList: true, subtree: true });
    ensureOverlay();
})();
