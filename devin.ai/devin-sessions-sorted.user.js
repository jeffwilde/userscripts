// ==UserScript==
// @name         Devin Sessions, Sorted
// @namespace    https://github.com/jeffwilde/userscripts
// @version      3.0.7
// @description  Adds a filter that sorts Devin sessions in the sidebar by last updated, and adds some eye candy.
// @author       jeff@robo.ai
// @match        https://app.devin.ai/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = Object.freeze({
        VERSION: '3.0.7',
        PREEMPTIVE_STYLE_ID: 'devin-sort-preemptive',
        ANIMATION_DURATION: 300,
        DEBOUNCE_MS: 80,
        MIN_SPINNER_DURATION: 800,
        STORAGE_KEY: 'devin-sort-enabled',
        CONTAINER_ID: 'devin-sorted-list',
        STYLE_ID: 'devin-sort-styles',
        TOGGLE_ID: 'devin-sort-btn',
        MAX_STABLE_ITEMS: 200,
        STALE_THRESHOLD_MS: 60000,
        CHILD_INDENT_PX: 10,
        DOT_SIZE_MIN: 4,
        DOT_SIZE_MAX: 14,
        SIDEBAR_WIDTH_MIN: 150,
        SIDEBAR_WIDTH_MAX: 500,
    });

    // ── Fiber Utilities (pure functions, no state) ──────────────

    function fiberFromElement(el) {
        if (!el) return null;
        for (const key of Object.keys(el)) {
            if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
                return el[key];
            }
        }
        return null;
    }

    function isHostFiber(fiber) {
        return fiber && (fiber.tag === 5 || typeof fiber.type === 'string');
    }

    function fiberDisplayName(fiber) {
        if (!fiber || !fiber.type) return null;
        if (typeof fiber.type === 'string') return fiber.type;
        return fiber.type.displayName || fiber.type.name || null;
    }

    function fiberHostNode(fiber) {
        if (!fiber) return null;
        if (isHostFiber(fiber) && fiber.stateNode) return fiber.stateNode;
        let cur = fiber.child;
        while (cur) {
            if (isHostFiber(cur) && cur.stateNode) return cur.stateNode;
            cur = cur.child || cur.sibling;
        }
        return null;
    }

    // ── Pre-emptive CSS (makes virtualizer giant BEFORE React measures) ──
    //
    // Injected at document-start so the browser applies it during DOM
    // mutations, before the virtualizer's useLayoutEffect can measure.
    // Uses :has() to target the scroll container by its children pattern.

    if (localStorage.getItem(CONFIG.STORAGE_KEY) !== 'false') {
        const ps = document.createElement('style');
        ps.id = CONFIG.PREEMPTIVE_STYLE_ID;
        ps.textContent = `
            *:has(> * > [data-index] a[href*="/sessions/"]) {
                height: 100000px !important;
                max-height: 100000px !important;
                overflow-y: auto !important;
                position: absolute !important;
                clip-path: inset(100%) !important;
                opacity: 0 !important;
                pointer-events: none !important;
                z-index: -1 !important;
            }
        `;
        (document.head || document.documentElement).appendChild(ps);
    }

    // ── React DevTools Hook (runs before React loads) ───────────

    let _fiberRoot = null;
    let _hookSubscriber = null;
    let _hookPending = false;

    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__ || {
        renderers: new Map(),
        supportsFiber: true,
        inject() {},
        onCommitFiberRoot() {},
        onCommitFiberUnmount() {},
        onScheduleFiberRoot() {},
        onPostCommitFiberRoot() {},
    };
    if (!window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
        window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
    }

    const origPostCommit = hook.onPostCommitFiberRoot;
    hook.onPostCommitFiberRoot = function(rid, root) {
        if (origPostCommit) origPostCommit.call(this, rid, root);
        _fiberRoot = root;
        if (!_hookPending) {
            _hookPending = true;
            setTimeout(() => { _hookPending = false; _hookSubscriber?.(); }, CONFIG.DEBOUNCE_MS);
        }
    };

    // ── Time Parsing (pure functions) ───────────────────────────

    const TIME_PATTERN = /^(\d+)\s*(min|hr|hour|day|week|month|year)s?$|^(now|just now)$/i;
    const TIME_MULTIPLIERS = { min: 1, hr: 60, hour: 60, day: 1440, week: 10080, month: 43200, year: 525600 };

    function parseTime(text) {
        if (!text) return Infinity;
        const t = text.trim().toLowerCase();
        if (t === 'now' || t === 'just now') return 0;
        const m = t.match(/(\d+)\s*(min|hr|hour|day|week|month|year)/i);
        if (!m) return Infinity;
        return parseInt(m[1]) * (TIME_MULTIPLIERS[m[2].toLowerCase()] || Infinity);
    }

    function extractTimeFromItem(item) {
        const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
        let node;
        while (node = walker.nextNode()) {
            const text = node.textContent.trim();
            if (TIME_PATTERN.test(text)) return text;
        }
        return '';
    }

    // ── DOM Path Utilities (pure functions) ──────────────────────

    function getElementPath(el, root) {
        const path = [];
        let cur = el;
        while (cur && cur !== root) {
            const parent = cur.parentElement;
            if (!parent) break;
            path.unshift(Array.from(parent.children).indexOf(cur));
            cur = parent;
        }
        return path;
    }

    function followElementPath(root, path) {
        let cur = root;
        for (const idx of path) {
            if (!cur.children || idx >= cur.children.length) return null;
            cur = cur.children[idx];
        }
        return cur;
    }

    // ── Child Session Detection (pure) ──────────────────────────

    function isChildSession(item, baseLeft) {
        const link = item.querySelector('a[href*="/sessions/"]');
        if (!link) return false;

        if (link.getBoundingClientRect().left > baseLeft + CONFIG.CHILD_INDENT_PX) return true;

        for (let i = 0; i < item.children.length; i++) {
            const el = item.children[i];
            if (el.tagName !== 'DIV') continue;
            const s = getComputedStyle(el);
            if (s.borderLeftStyle === 'solid' && parseInt(s.borderLeftWidth) > 0) return true;
            for (let j = 0; j < el.children.length; j++) {
                const sub = el.children[j];
                if (sub.tagName !== 'DIV') continue;
                const ss = getComputedStyle(sub);
                if (ss.borderLeftStyle === 'solid' && parseInt(ss.borderLeftWidth) > 0) return true;
            }
        }
        return false;
    }

    function computeBaseLeft(items) {
        const counts = {};
        for (const item of items) {
            const link = item.querySelector('a[href*="/sessions/"]');
            if (!link) continue;
            const left = Math.round(link.getBoundingClientRect().left);
            counts[left] = (counts[left] || 0) + 1;
        }
        const entries = Object.entries(counts);
        if (entries.length === 0) return 0;
        return parseInt(entries.sort((a, b) => b[1] - a[1])[0][0]);
    }

    // ── Selection Detection (pure) ──────────────────────────────

    function isItemSelected(element, currentPathname) {
        const w = element.closest('.devin-stable-wrapper') || element;
        const url = w.dataset?.sessionUrl || w.getAttribute('href');
        if (url && currentPathname === url) return true;

        const inner = element.querySelector('[class*="hover:bg-"]') || element.firstElementChild;
        if (!inner) return false;
        const bg = getComputedStyle(inner).backgroundColor;
        if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
            const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
            if (m) return (m[4] !== undefined ? parseFloat(m[4]) : 1) > 0.05;
        }
        return false;
    }

    // ── Status Dot Detection (pure) ─────────────────────────────

    function findStatusDot(element) {
        const byAttr = element.querySelector('[data-status-dot], [role="status"]');
        if (byAttr) return byAttr;

        const byClass = element.querySelector('[class*="status-dot"], [class*="status-indicator"]');
        if (byClass) return byClass;

        for (const div of element.querySelectorAll('div')) {
            const s = getComputedStyle(div);
            const w = parseFloat(s.width), h = parseFloat(s.height);
            if (w >= CONFIG.DOT_SIZE_MIN && w <= CONFIG.DOT_SIZE_MAX &&
                h >= CONFIG.DOT_SIZE_MIN && h <= CONFIG.DOT_SIZE_MAX) {
                const br = s.borderRadius;
                if (br === '50%' || br === '9999px' || parseFloat(br) >= w / 2) {
                    if (s.backgroundColor && s.backgroundColor !== 'transparent' && s.backgroundColor !== 'rgba(0, 0, 0, 0)') {
                        return div;
                    }
                }
            }
        }
        return null;
    }

    // ── Phase 1: Lightweight Metadata Collection ────────────────
    // Runs on every React commit. NO cloning, NO getComputedStyle.

    function collectMetadata(container) {
        const items = container.querySelectorAll('[data-index]');
        if (items.length === 0) return null;

        const result = [];
        for (const item of items) {
            const link = item.querySelector('a[href*="/sessions/"]');
            if (!link) continue;
            result.push({
                url: link.getAttribute('href'),
                timeVal: parseTime(extractTimeFromItem(item)),
                itemRef: item,
            });
        }
        return result.length > 0 ? result : null;
    }

    function buildSnapshot(metadata) {
        return metadata.map(m => m.url + ':' + m.timeVal).join('|');
    }

    // ── Phase 2: Full Collection with Cloning & Sorting ─────────
    // Only called when snapshot changed. Does expensive work.

    function collectAndSortSessions(metadata) {
        const itemRefs = metadata.map(m => m.itemRef);
        const baseLeft = computeBaseLeft(itemRefs);

        const rawSessions = metadata.map((m, i) => ({
            url: m.url,
            timeVal: m.timeVal,
            element: m.itemRef.cloneNode(true),
            isChild: isChildSession(m.itemRef, baseLeft),
            originalIndex: i,
        }));

        return groupAndSort(rawSessions);
    }

    function groupAndSort(rawSessions) {
        const families = [];
        let currentFamily = null;

        for (const session of rawSessions) {
            if (session.isChild && currentFamily) {
                currentFamily.children.push(session);
                currentFamily.effectiveTime = Math.min(currentFamily.effectiveTime, session.timeVal);
            } else {
                if (currentFamily) families.push(currentFamily);
                currentFamily = { parent: session, children: [], effectiveTime: session.timeVal };
            }
        }
        if (currentFamily) families.push(currentFamily);

        families.sort((a, b) => a.effectiveTime - b.effectiveTime);

        const sorted = [];
        for (const f of families) {
            sorted.push({
                url: f.parent.url, timeVal: f.parent.timeVal,
                element: f.parent.element, familyId: f.parent.url, isChild: false,
            });
            const kids = [...f.children].sort((a, b) => a.timeVal - b.timeVal);
            for (const c of kids) {
                sorted.push({
                    url: c.url, timeVal: c.timeVal,
                    element: c.element, familyId: f.parent.url, isChild: true,
                });
            }
        }
        return sorted;
    }

    // ── Entry Point ─────────────────────────────────────────────

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function init() {

        // ── Mutable State ───────────────────────────────────────

        let sortEnabled = localStorage.getItem(CONFIG.STORAGE_KEY) !== 'false';
        let sortedContainer = null;
        let cachedSessionContainer = null;
        let cachedSidebarContainer = null;
        let loadingUrl = null;
        let loadingStartTime = 0;
        let lastSnapshot = '';
        let lastSelectedUrl = '';
        let initObserver = null;
        let buttonObserver = null;
        let virtualLoadTimer = null;
        let lastVirtualLoadContainer = null;

        const stableItems = new Map();
        let wrapperEl = null;
        let lastOrder = [];
        let isAnimating = false;
        let activeAnimations = [];

        _hookSubscriber = update;

        // ── Initialization (MutationObserver) ───────────────────

        (function waitForSessionList() {
            if (document.querySelector('[data-index] a[href*="/sessions/"]')) {
                update();
                watchForButtonRemoval();
                return;
            }
            initObserver = new MutationObserver(() => {
                if (document.querySelector('[data-index] a[href*="/sessions/"]')) {
                    initObserver.disconnect();
                    initObserver = null;
                    update();
                    watchForButtonRemoval();
                }
            });
            initObserver.observe(document.body, { childList: true, subtree: true });
        })();

        function watchForButtonRemoval() {
            if (buttonObserver) buttonObserver.disconnect();
            const row = getFilterRow();
            if (!row) return;
            const target = row.parentElement || row;
            buttonObserver = new MutationObserver(() => {
                if (!document.getElementById(CONFIG.TOGGLE_ID) && getFilterRow()) update();
            });
            buttonObserver.observe(target, { childList: true, subtree: true });
        }

        // ── DOM Detection ───────────────────────────────────────

        function findContainers() {
            if (cachedSessionContainer && document.body.contains(cachedSessionContainer)) {
                if (cachedSessionContainer.dataset.devinSortHidden === 'true' || cachedSidebarContainer) {
                    return cachedSessionContainer;
                }
            }

            const marked = document.querySelector('[data-devin-sort-hidden="true"]');
            if (marked) { cachedSessionContainer = marked; return marked; }

            const anchor = document.querySelector('[data-index] a[href*="/sessions/"]');
            if (!anchor) return null;

            const fiber = fiberFromElement(anchor);
            let cur = fiber;
            let sc = null, sb = null;

            while (cur) {
                const node = fiberHostNode(cur);
                if (node && node !== anchor) {
                    const s = getComputedStyle(node);
                    if (!sc && (s.overflowY === 'auto' || s.overflowY === 'scroll')) sc = node;
                    if (sc && node.contains(sc) && node !== sc) {
                        const r = node.getBoundingClientRect();
                        if (r.width > CONFIG.SIDEBAR_WIDTH_MIN && r.width < CONFIG.SIDEBAR_WIDTH_MAX) sb = node;
                    }
                }
                cur = cur.return;
            }

            if (sc) {
                cachedSessionContainer = sc;
                cachedSidebarContainer = sb;
            }
            return sc;
        }

        function getFilterRow() {
            const btn = document.querySelector('button[data-dd-action-name="Edit filter"]');
            if (btn) {
                let cur = fiberFromElement(btn);
                while (cur) {
                    const node = fiberHostNode(cur);
                    if (node && node.classList?.contains('scrollbar-hide')) return node;
                    cur = cur.return;
                }
            }
            return document.querySelector('.scrollbar-hide.flex-row');
        }

        // ── Stable Wrapper Lifecycle ────────────────────────────

        function ensureSortedContainer(originalContainer) {
            if (sortedContainer && document.body.contains(sortedContainer)) return sortedContainer;
            const el = document.createElement('div');
            el.id = CONFIG.CONTAINER_ID;
            el.className = originalContainer.className;
            el.style.cssText = 'overflow-y:auto; overflow-x:hidden; scrollbar-width:thin;';
            originalContainer.parentNode.insertBefore(el, originalContainer.nextSibling);
            sortedContainer = el;
            stableItems.clear();
            wrapperEl = null;
            lastOrder = [];
            return el;
        }

        function createStableWrapper(url) {
            const a = document.createElement('a');
            a.className = 'devin-stable-wrapper';
            a.href = url;
            a.dataset.sessionUrl = url;
            a.style.cssText = 'position:relative; width:100%; display:block; text-decoration:none; color:inherit;';

            a.addEventListener('click', (e) => {
                const clicked = e.target;
                const interactive = clicked.closest('button, [role="button"], a[href]:not(.devin-stable-wrapper)');

                if (interactive && interactive !== a) {
                    e.preventDefault();
                    e.stopPropagation();
                    proxyClickToOriginal(interactive, url, cachedSessionContainer);
                    return;
                }

                if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
                    e.preventDefault();
                    setLoadingSpinner(a, url);
                    history.pushState({}, '', url);
                    dispatchEvent(new PopStateEvent('popstate'));
                }
            });

            return a;
        }

        function updateWrapperContent(wrapper, sourceElement, url) {
            const content = sourceElement.cloneNode(true);
            content.style.position = 'relative';
            content.style.top = 'auto';
            content.style.left = 'auto';
            content.style.transform = '';
            content.removeAttribute('data-index');

            for (const link of content.querySelectorAll('a[href*="/sessions/"]')) {
                link.removeAttribute('href');
                link.style.cursor = 'pointer';
            }

            wrapper.replaceChildren(content);
            checkSpinnerState(wrapper, url);
        }

        function pruneStaleItems(activeUrls) {
            if (stableItems.size <= CONFIG.MAX_STABLE_ITEMS) return;
            const now = Date.now();
            for (const [url, data] of stableItems) {
                if (!activeUrls.has(url) && now - (data.lastSeen || 0) > CONFIG.STALE_THRESHOLD_MS) {
                    data.wrapper.remove();
                    stableItems.delete(url);
                }
            }
            if (stableItems.size > CONFIG.MAX_STABLE_ITEMS) {
                const entries = [...stableItems.entries()].sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0));
                for (let i = 0; i < entries.length - CONFIG.MAX_STABLE_ITEMS; i++) {
                    if (!activeUrls.has(entries[i][0])) {
                        entries[i][1].wrapper.remove();
                        stableItems.delete(entries[i][0]);
                    }
                }
            }
        }

        // ── Click Proxy ─────────────────────────────────────────

        function proxyClickToOriginal(clickedEl, sessionUrl, sessionContainer) {
            if (clickedEl.tagName === 'A' && clickedEl.href) {
                window.open(clickedEl.href, '_blank');
                return;
            }

            const origLink = sessionContainer?.querySelector(`a[href="${sessionUrl}"]`);
            if (!origLink) return;
            const origItem = origLink.closest('[data-index]') || origLink.parentElement;
            if (!origItem) return;

            let target = null;

            const ariaLabel = clickedEl.getAttribute('aria-label');
            if (ariaLabel) {
                target = origItem.querySelector(`[aria-label="${ariaLabel}"]`);
            }

            if (!target) {
                const wrapperRoot = clickedEl.closest('.devin-stable-wrapper');
                if (wrapperRoot) {
                    const contentRoot = wrapperRoot.firstElementChild;
                    if (contentRoot) {
                        target = followElementPath(origItem, getElementPath(clickedEl, contentRoot));
                    }
                }
            }

            if (!target && clickedEl.className) {
                try {
                    const sel = '.' + clickedEl.className.split(' ').filter(Boolean)
                        .map(c => c.replace(/([.:#[\]()>+~=|^$*])/g, '\\$1')).join('.');
                    if (sel !== '.') target = origItem.querySelector(sel);
                } catch (_) {}
            }

            if (target) {
                const opts = { bubbles: true, cancelable: true, view: window };
                target.dispatchEvent(new MouseEvent('mousedown', opts));
                target.dispatchEvent(new MouseEvent('mouseup', opts));
                target.dispatchEvent(new MouseEvent('click', opts));
            }
        }

        // ── FLIP Animation ──────────────────────────────────────

        function animateReorder(items) {
            if (isAnimating) return;
            isAnimating = true;
            activeAnimations = [];

            for (const { wrapper: w, deltaY } of items) {
                w.style.transition = 'none';
                w.style.transform = '';
                activeAnimations.push(
                    w.animate(
                        [{ transform: `translateY(${deltaY}px)` }, { transform: 'translateY(0)' }],
                        { duration: CONFIG.ANIMATION_DURATION, easing: 'cubic-bezier(0.4,0,0.2,1)', fill: 'forwards' }
                    )
                );
            }

            Promise.all(activeAnimations.map(a => a.finished)).then(() => {
                for (const { wrapper: w } of items) w.style.transform = '';
                activeAnimations = [];
                isAnimating = false;
            }).catch(() => { activeAnimations = []; isAnimating = false; });
        }

        // ── Renderer ────────────────────────────────────────────

        function renderSortedList(sessions, originalContainer) {
            ensureSortedContainer(originalContainer);

            const newOrder = sessions.map(s => s.url);

            const oldPositions = new Map();
            for (const [url, data] of stableItems) {
                if (data.wrapper && document.body.contains(data.wrapper)) {
                    oldPositions.set(url, data.wrapper.getBoundingClientRect().top);
                }
            }

            const orderChanged = lastOrder.length > 0 &&
                lastOrder.length === newOrder.length &&
                lastOrder.some((url, i) => url !== newOrder[i]);

            const canAnimate = oldPositions.size > 0 &&
                sessions.length === oldPositions.size &&
                sessions.every(s => oldPositions.has(s.url));

            if (isAnimating) {
                for (const s of sessions) {
                    const d = stableItems.get(s.url);
                    if (d) updateWrapperContent(d.wrapper, s.element, s.url);
                }
                return;
            }

            if (!wrapperEl) {
                wrapperEl = document.createElement('div');
                wrapperEl.style.cssText = 'position:relative; width:100%;';
                sortedContainer.appendChild(wrapperEl);
            }

            const activeUrls = new Set(newOrder);

            for (const s of sessions) {
                if (!stableItems.has(s.url)) {
                    const w = createStableWrapper(s.url);
                    updateWrapperContent(w, s.element, s.url);
                    stableItems.set(s.url, { wrapper: w, url: s.url, lastSeen: Date.now() });
                } else {
                    stableItems.get(s.url).lastSeen = Date.now();
                }
            }

            for (const [url, data] of stableItems) {
                if (!activeUrls.has(url)) { data.wrapper.remove(); stableItems.delete(url); }
            }
            pruneStaleItems(activeUrls);

            if (canAnimate && orderChanged) {
                for (const s of sessions) {
                    const d = stableItems.get(s.url);
                    if (d) wrapperEl.appendChild(d.wrapper);
                }
                const toAnimate = [];
                for (const s of sessions) {
                    const oldTop = oldPositions.get(s.url);
                    const d = stableItems.get(s.url);
                    if (oldTop !== undefined && d) {
                        const delta = oldTop - d.wrapper.getBoundingClientRect().top;
                        if (Math.abs(delta) > 1) toAnimate.push({ wrapper: d.wrapper, deltaY: delta });
                    }
                }
                if (toAnimate.length > 0) animateReorder(toAnimate);
            } else if (!canAnimate) {
                wrapperEl.replaceChildren();
                for (const s of sessions) {
                    const d = stableItems.get(s.url);
                    if (d) wrapperEl.appendChild(d.wrapper);
                }
            }

            for (const s of sessions) {
                const d = stableItems.get(s.url);
                if (d) updateWrapperContent(d.wrapper, s.element, s.url);
            }

            lastOrder = newOrder;
        }

        // ── Selective Visual Sync ───────────────────────────────
        // Fast path: snapshot unchanged. Only re-clones items whose
        // selection state changed (typically 0-2 items per update).

        function syncVisualState(metadata) {
            const currentUrl = window.location.pathname;
            const prevUrl = lastSelectedUrl;
            lastSelectedUrl = currentUrl;

            if (currentUrl === prevUrl && !loadingUrl) return;

            for (const m of metadata) {
                const isNewlySelected = m.url === currentUrl && m.url !== prevUrl;
                const isNewlyDeselected = m.url === prevUrl && m.url !== currentUrl;
                const isLoading = m.url === loadingUrl;

                if (!isNewlySelected && !isNewlyDeselected && !isLoading) continue;

                const data = stableItems.get(m.url);
                if (data && data.wrapper) {
                    updateWrapperContent(data.wrapper, m.itemRef, m.url);
                }
            }
        }

        // ── Spinner Management ──────────────────────────────────

        function positionSpinnerOnDot(wrapper) {
            const dot = findStatusDot(wrapper);
            if (!dot) return;
            const wr = wrapper.getBoundingClientRect();
            const dr = dot.getBoundingClientRect();
            wrapper.style.setProperty('--spinner-top', (dr.top - wr.top + dr.height / 2) + 'px');
            wrapper.style.setProperty('--spinner-left', (dr.left - wr.left + dr.width / 2) + 'px');
        }

        function setLoadingSpinner(wrapper, url) {
            clearLoadingSpinner();
            loadingUrl = url;
            loadingStartTime = Date.now();
            wrapper.dataset.loading = 'true';
            positionSpinnerOnDot(wrapper);
        }

        function clearLoadingSpinner() {
            for (const w of document.querySelectorAll('.devin-stable-wrapper[data-loading]')) {
                delete w.dataset.loading;
                w.style.removeProperty('--spinner-top');
                w.style.removeProperty('--spinner-left');
            }
            loadingUrl = null;
        }

        function fadeOutSpinner() {
            for (const w of document.querySelectorAll('.devin-stable-wrapper[data-loading="true"]')) {
                w.dataset.loading = 'fading';
                setTimeout(() => {
                    if (w.dataset.loading === 'fading') {
                        delete w.dataset.loading;
                        w.style.removeProperty('--spinner-top');
                        w.style.removeProperty('--spinner-left');
                    }
                }, 400);
            }
            loadingUrl = null;
        }

        function checkSpinnerState(wrapper, url) {
            if (loadingUrl !== url) return;
            positionSpinnerOnDot(wrapper);
            if (isItemSelected(wrapper, window.location.pathname)) {
                const elapsed = Date.now() - loadingStartTime;
                if (elapsed >= CONFIG.MIN_SPINNER_DURATION) {
                    fadeOutSpinner();
                } else {
                    setTimeout(() => {
                        if (loadingUrl === url) fadeOutSpinner();
                    }, CONFIG.MIN_SPINNER_DURATION - elapsed);
                }
            }
        }

        // ── CSS Styles ──────────────────────────────────────────

        function applyHideStyles(container) {
            let el = document.getElementById(CONFIG.STYLE_ID);
            if (!el) {
                el = document.createElement('style');
                el.id = CONFIG.STYLE_ID;
                document.head.appendChild(el);
            }
            container.dataset.devinSortHidden = 'true';
            triggerVirtualListLoad(container);

            el.textContent = `
                [data-devin-sort-hidden="true"] {
                    position: absolute !important;
                    clip-path: inset(100%) !important;
                    opacity: 0 !important;
                    pointer-events: none !important;
                    height: 100000px !important;
                    max-height: 100000px !important;
                    overflow-y: auto !important;
                    z-index: -1 !important;
                }
                [data-devin-sort-hidden="true"] * { pointer-events: none !important; }
                #${CONFIG.CONTAINER_ID} { display: block !important; flex: 1 !important; }

                @keyframes devin-spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                @keyframes devin-spin-out {
                    from { opacity: 1; }
                    to { opacity: 0; }
                }
                .devin-stable-wrapper[data-loading] { overflow: visible !important; }
                .devin-stable-wrapper[data-loading] > * { overflow: visible !important; }
                .devin-stable-wrapper[data-loading]::after {
                    content: '' !important; position: absolute !important;
                    top: var(--spinner-top, 50%) !important; left: var(--spinner-left, 50%) !important;
                    width: 18px !important; height: 18px !important;
                    margin-top: -9px !important; margin-left: -9px !important;
                    border-radius: 50% !important;
                    border: 2px solid rgba(255,255,255,0.15) !important;
                    border-top-color: #a5b4fc !important;
                    background: transparent !important;
                    animation: devin-spin 0.8s linear infinite !important;
                    box-sizing: border-box !important;
                    pointer-events: none !important; z-index: 100 !important;
                }
                .devin-stable-wrapper[data-loading="fading"]::after {
                    animation: devin-spin 0.8s linear infinite, devin-spin-out 0.4s ease-out forwards !important;
                }
            `;
        }

        function removeHideStyles() {
            document.getElementById(CONFIG.STYLE_ID)?.remove();
            document.getElementById(CONFIG.PREEMPTIVE_STYLE_ID)?.remove();
            document.querySelector('[data-devin-sort-hidden]')?.removeAttribute('data-devin-sort-hidden');
        }

        function triggerVirtualListLoad(container) {
            if (virtualLoadTimer && lastVirtualLoadContainer === container) return;
            if (virtualLoadTimer) clearTimeout(virtualLoadTimer);
            lastVirtualLoadContainer = container;

            // Phase 1: Synchronous scrolls — fires BEFORE el.textContent is set
            // in applyHideStyles, so container is still in its natural state.
            const scrollEvt = new Event('scroll', { bubbles: true });
            const origTop = container.scrollTop;
            container.scrollTop = 10000;
            container.dispatchEvent(scrollEvt);
            container.scrollTop = 50000;
            container.dispatchEvent(scrollEvt);
            container.scrollTop = 100000;
            container.dispatchEvent(scrollEvt);
            container.scrollTop = origTop;

            // Phase 2: Async polling — dimension toggling to trigger ResizeObserver
            const POLL_INTERVAL = 200;
            const MAX_STABLE = 10;
            let stableCount = 0;
            let lastItemCount = container.querySelectorAll('[data-index]').length;

            function nudge() {
                container.style.setProperty('height', '50000px', 'important');
                void container.offsetHeight;
                container.style.removeProperty('height');
                void container.offsetHeight;
                window.dispatchEvent(new Event('resize'));
            }

            function poll() {
                nudge();
                const count = container.querySelectorAll('[data-index]').length;
                if (count > lastItemCount) {
                    lastItemCount = count;
                    stableCount = 0;
                } else {
                    stableCount++;
                }
                if (stableCount >= MAX_STABLE) {
                    virtualLoadTimer = null;
                    return;
                }
                virtualLoadTimer = setTimeout(poll, POLL_INTERVAL);
            }

            requestAnimationFrame(() => {
                nudge();
                virtualLoadTimer = setTimeout(poll, POLL_INTERVAL);
            });
        }

        // ── Toggle Button ───────────────────────────────────────

        function createToggleButton() {
            const btn = document.createElement('div');
            btn.id = CONFIG.TOGGLE_ID;
            btn.className = 'flex items-center rounded-xl pl-2 pr-2 text-xs';
            btn.innerHTML = `
                <div style="display:flex;align-items:center;padding:4px 0;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <circle cx="12" cy="12" r="10"/>
                        <polyline points="12 6 12 12 16 14"/>
                    </svg>
                </div>
            `;
            styleToggleButton(btn, sortEnabled);
            btn.style.cursor = 'pointer';
            btn.style.marginRight = '4px';
            btn.style.flexShrink = '0';
            btn.style.zIndex = '30';
            btn.style.position = 'relative';
            btn.onclick = () => {
                sortEnabled = !sortEnabled;
                localStorage.setItem(CONFIG.STORAGE_KEY, String(sortEnabled));
                styleToggleButton(btn, sortEnabled);
                update();
            };
            return btn;
        }

        function styleToggleButton(btn, enabled) {
            btn.style.background = enabled ? '#312e81' : '#212121';
            btn.style.border = `1px solid ${enabled ? '#4338ca' : 'transparent'}`;
            btn.title = enabled ? 'Sorting by time (click to disable)' : 'Click to sort by time';
            const inner = btn.querySelector('div');
            if (inner) inner.style.color = enabled ? '#a5b4fc' : '#CBCBCB';
        }

        // ── Main Update (Two-Phase) ─────────────────────────────

        function update() {
            const sessionContainer = findContainers();

            if (!sessionContainer) {
                sortedContainer?.remove();
                sortedContainer = null;
                return;
            }

            const filterRow = getFilterRow();
            let btn = document.getElementById(CONFIG.TOGGLE_ID);
            if (filterRow && !btn) {
                btn = createToggleButton();
                const capsule = filterRow.querySelector('.border-input-dark');
                if (capsule) {
                    filterRow.insertBefore(btn, capsule);
                } else {
                    const grad = filterRow.querySelector('.to-dark-bg');
                    if (grad && grad.nextSibling) filterRow.insertBefore(btn, grad.nextSibling);
                    else filterRow.appendChild(btn);
                }
            }
            if (btn) styleToggleButton(btn, sortEnabled);

            if (!sortEnabled) {
                removeHideStyles();
                sortedContainer?.remove();
                sortedContainer = null;
                cachedSessionContainer = null;
                cachedSidebarContainer = null;
                if (virtualLoadTimer) { clearTimeout(virtualLoadTimer); virtualLoadTimer = null; }
                lastVirtualLoadContainer = null;
                lastSnapshot = '';
                lastSelectedUrl = '';
                return;
            }

            // Phase 1: lightweight metadata (no cloning, no getComputedStyle)
            const metadata = collectMetadata(sessionContainer);
            if (!metadata) return;

            const snapshot = buildSnapshot(metadata);

            // Fast path: nothing changed → selective visual sync (0-2 items re-cloned)
            if (snapshot === lastSnapshot && sortedContainer && document.body.contains(sortedContainer)) {
                syncVisualState(metadata);
                return;
            }

            // Slow path: snapshot changed → full clone + sort + render
            lastSnapshot = snapshot;
            lastSelectedUrl = window.location.pathname;
            applyHideStyles(sessionContainer);
            renderSortedList(collectAndSortSessions(metadata), sessionContainer);
        }

        // ── Cleanup ─────────────────────────────────────────────

        function cleanup() {
            document.getElementById(CONFIG.TOGGLE_ID)?.remove();
            document.getElementById(CONFIG.CONTAINER_ID)?.remove();
            removeHideStyles();
            sortedContainer = null;
            stableItems.clear();
            wrapperEl = null;
            _hookSubscriber = null;
            initObserver?.disconnect();
            initObserver = null;
            buttonObserver?.disconnect();
            buttonObserver = null;
            if (virtualLoadTimer) { clearTimeout(virtualLoadTimer); virtualLoadTimer = null; }
            lastVirtualLoadContainer = null;
            lastSnapshot = '';
            lastSelectedUrl = '';
        }

        // ── Debug (gated behind window.__DEVIN_SORT_DEBUG__) ────

        function testAnimation() {
            if (!window.__DEVIN_SORT_DEBUG__) return;
            if (!wrapperEl || stableItems.size < 2) return;
            const wrappers = Array.from(wrapperEl.children);
            const positions = wrappers.map(w => ({ wrapper: w, top: w.getBoundingClientRect().top }));
            wrappers.reverse();
            for (const w of wrappers) wrapperEl.appendChild(w);
            const toAnimate = [];
            for (const { wrapper: w, top } of positions) {
                const delta = top - w.getBoundingClientRect().top;
                if (Math.abs(delta) > 1) toAnimate.push({ wrapper: w, deltaY: delta });
            }
            if (toAnimate.length > 0) animateReorder(toAnimate);
            lastOrder = Array.from(wrapperEl.children).map(w => w.dataset.sessionUrl);
        }

        function testTransform() {
            if (!window.__DEVIN_SORT_DEBUG__) return;
            const list = document.getElementById(CONFIG.CONTAINER_ID);
            const w = list?.children[0];
            if (!w || w.children.length < 1) return;
            const el = w.children[0];
            el.style.setProperty('transition', 'transform 500ms ease-out, background-color 500ms ease-out', 'important');
            el.style.setProperty('transform', 'translateY(100px)', 'important');
            el.style.setProperty('background-color', 'rgba(255,0,0,0.5)', 'important');
            setTimeout(() => {
                el.style.setProperty('transform', 'translateY(0)', 'important');
                el.style.setProperty('background-color', '', 'important');
                setTimeout(() => {
                    el.style.removeProperty('transition');
                    el.style.removeProperty('transform');
                    el.style.removeProperty('background-color');
                }, 500);
            }, 1000);
        }

        // ── Public API ──────────────────────────────────────────

        window.DevinSort = {
            version: CONFIG.VERSION,
            get enabled() { return sortEnabled; },
            set enabled(v) {
                sortEnabled = v;
                localStorage.setItem(CONFIG.STORAGE_KEY, String(v));
                update();
            },
            toggle() {
                sortEnabled = !sortEnabled;
                localStorage.setItem(CONFIG.STORAGE_KEY, String(sortEnabled));
                update();
            },
            reload() { cleanup(); init(); },
            cleanup,
            testAnimation,
            testTransform,
            get fiberRoot() { return _fiberRoot; },
            get sessionContainer() { return cachedSessionContainer; },
            get sidebarContainer() { return cachedSidebarContainer; },
            get itemCount() { return stableItems.size; },
            findContainers() { return { sessionContainer: findContainers(), sidebarContainer: cachedSidebarContainer }; },
            getFiberFromElement: fiberFromElement,
            getDisplayName: fiberDisplayName,
            getHostNode: fiberHostNode,
        };
    }
})();
