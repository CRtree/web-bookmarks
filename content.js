// Scroll Saver - Content Script (YouTube Channel only)

(function() {
  'use strict';

  // Forward console logs to background for aggregation
  const _csOriginalConsole = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console)
  };

  function _csForward(level, args) {
    chrome.runtime.sendMessage({
      action: 'store_log',
      source: 'content',
      level: level,
      message: args.join(' '),
      url: window.location.href,
      timestamp: Date.now()
    });
  }

  console.log = function(...args) {
    _csOriginalConsole.log(...args);
    _csForward('log', args);
  };
  console.error = function(...args) {
    _csOriginalConsole.error(...args);
    _csForward('error', args);
  };
  console.warn = function(...args) {
    _csOriginalConsole.warn(...args);
    _csForward('warn', args);
  };

  // State
  let currentUrl = window.location.href;
  let isRestoring = false;
  let isTrackingActive = false;
  // Whether the extension is enabled (channel was added) for the URL currently
  // loaded. Click-to-save must never run for a channel the user has not added.
  let isEnabledForUrl = false;
  let clickListenerAttached = false;
  // Dedupe pointerdown + click firing for the same video link in quick succession.
  let lastHandledVideoHref = null;
  let lastHandledVideoTime = 0;

  // Pages already restored in this document. Restore is requested from several
  // places (initial load, SPA navigation, history changes), so acting once stops a
  // second trigger from repeating the scroll or a second pre-scan reload. Cleared
  // on every navigation (see observeUrlChanges) so a later visit to the same URL
  // is handled again.
  const restoredThisDocument = new Set();

  // True once YouTube has changed the URL in this document (in-app navigation).
  // A hard page load starts with a clean, top-of-page DOM, so scanning it needs
  // no refresh. Reached by SPA navigation, the DOM is dirty (previous page's
  // cards, scroll position, in-flight renders) and the one reload is justified.
  let hasInAppNavigation = false;

  // YouTube video-ID scan state
  let ytScanTimer = null;
  let ytScanUserInterrupted = false;
  let ytScanLastHeight = 0;
  let ytScanStallCount = 0;
  let ytScanNoGrowthStreak = 0;
  let ytScanTotalStalls = 0;
  let ytScanInterruptHandler = null;

  // Normalize URL for storage (remove tracking parameters, etc.)
  function normalizeUrl(url) {
    try {
      const urlObj = new URL(url);

      // YouTube normalization: for channel pages, strip query params to normalize
      if (urlObj.hostname.includes('youtube.com') || urlObj.hostname.includes('youtu.be')) {
        if (urlObj.pathname.startsWith('/@')) {
          urlObj.search = '';
          urlObj.hash = '';
        }
      }

      return urlObj.toString();
    } catch (e) {
      console.warn('[SS:init] URL normalization failed, using original:', url, e);
      return url;
    }
  }

  // Check if extension context is still valid
  function isExtensionValid() {
    if (!chrome.runtime || !chrome.runtime.id) {
      console.warn('[SS:init] Extension context invalidated - runtime not available');
      return false;
    }
    if (!chrome.storage || !chrome.storage.local) {
      console.warn('[SS:init] Extension context invalidated - storage not available');
      return false;
    }
    return true;
  }

  // Query across shadow DOM boundaries (YouTube renders videos inside web components).
  function querySelectorAllDeep(selector, root) {
    root = root || document;
    if (!root.querySelectorAll) return [];
    const results = Array.from(root.querySelectorAll(selector));
    const shadowHosts = Array.from(root.querySelectorAll('*')).filter(el => el.shadowRoot);
    shadowHosts.forEach(host => {
      results.push(...querySelectorAllDeep(selector, host.shadowRoot));
    });
    return results;
  }

  // Find the video card container for a link, crossing shadow DOM if needed.
  function findVideoContainer(link) {
    // Include shorts card containers so scrolling onto a /shorts card targets the
    // whole card rather than a tiny anchor. Order matters: nearest match wins.
    const selectors = 'shorts-lockup-view-model, ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer';

    // Walk up, but at each DOM tree (light or shadow) find the NEAREST matching
    // ancestor before crossing a shadow boundary. Using closest() per level stops
    // at the immediate video card instead of skipping it and climbing to a
    // page-level ytd-rich-item-renderer wrapper.
    let node = link;
    while (node) {
      if (node.closest) {
        const match = node.closest(selectors);
        if (match) return match;
      }
      // No match in this tree — step up across the shadow boundary via the host.
      const root = node.getRootNode ? node.getRootNode() : null;
      if (!root || root === document || !root.host) break;
      node = root.host;
    }

    return link;
  }

  // Reset isRestoring (centralized for all restore exit paths)
  function finishRestore() {
    isRestoring = false;
    detachYTScanInterrupt();
    console.log('[SS:restore] Restore completed, isRestoring reset to false');
  }

  // ============================================================
  // YouTube Channel — Video-ID-Only Position Tracking
  // ============================================================

  function getYouTubeStorageKey(url) {
    const normalizedUrl = normalizeUrl(url);
    return `yt_position_${normalizedUrl}`;
  }

  // Display length, e.g. "3:32" or "1:12:00".
  const DURATION_RE = /^(?:\d{1,2}:)?\d{1,2}:\d{2}$/;

  // The badge YouTube paints over a thumbnail. Class names change between
  // releases, so it is tried first but never relied upon.
  const DURATION_BADGE_SEL =
    '.ytBadgeShapeText, ytd-thumbnail-overlay-time-status-renderer, [class*="time-status"]';

  // How many ancestor levels the rename-proof fallback may scan. Bounded so it
  // stays inside the card: at grid level a duration belongs to a different video.
  const DURATION_SCAN_DEPTH = 3;

  // Best-effort read of the clicked video's length, for the popup's thumbnail
  // badge. Returns null when nothing matches — the popup then omits the badge.
  // (Shorts cards carry no duration at all, so they never get one.)
  function readCardDuration(anchor) {
    try {
      let card = anchor;
      for (let depth = 0; depth < 8 && card && card.parentElement; depth++) {
        card = card.parentElement;

        const badge = card.querySelector(DURATION_BADGE_SEL);
        if (badge) {
          const text = (badge.textContent || '').trim();
          if (DURATION_RE.test(text)) return text;
        }

        // Fallback that survives a class rename: the duration is the only
        // childless element in the card whose entire text is a timestamp.
        // Matching a leaf's whole text keeps this exact — it cannot pick up a
        // time embedded in a title — and staying near the card stops it from
        // reaching a neighbouring video's badge in a grid container.
        if (depth < DURATION_SCAN_DEPTH) {
          for (const el of card.querySelectorAll('span, div, yt-formatted-string')) {
            if (el.children.length) continue;
            const text = (el.textContent || '').trim();
            if (DURATION_RE.test(text)) return text;
          }
        }
      }
    } catch (e) {
      console.warn('[SS:yt] Duration scrape failed:', e);
    }
    return null;
  }

  function saveYouTubePosition(videoId, type, duration) {
    if (!videoId || !isExtensionValid()) return;
    const key = getYouTubeStorageKey(currentUrl);
    // type is 'video' (default) or 'shorts'. Back-compat: entries written before
    // this field existed have no type, so the popup/DOM code treats it as 'video'.
    const data = { videoId, type: type || 'video', timestamp: Date.now() };
    // Optional, and purely additive: entries saved before this existed, or where
    // the scrape failed, just render without a duration badge.
    if (duration) data.duration = duration;
    chrome.storage.local.set({ [key]: data }, () => {
      if (chrome.runtime.lastError) {
        console.error('[SS:yt] Error saving YouTube position:', chrome.runtime.lastError);
      } else {
        console.log('[SS:yt] ✅ Saved videoId:', videoId, '(type=', data.type + ', duration=', (data.duration || 'n/a') + ')');
      }
    });
  }

  function removeYouTubePosition(url) {
    if (!isExtensionValid()) return;
    const key = getYouTubeStorageKey(url || currentUrl);
    chrome.storage.local.remove([key], () => {
      console.log('[SS:yt] Removed YouTube position:', key);
    });
  }

  // A card that is in the DOM but not laid out yet (hidden, or a collapsed
  // placeholder) measures 0 tall and sits at the top of the page. Trusting it
  // makes the restore scroll to 0 instead of scanning for the real card — which
  // is what happens when YouTube renders a channel tab's grid a frame or two
  // after an in-app navigation. Only a card with real height counts as found.
  function isRendered(link) {
    return findVideoContainer(link).getBoundingClientRect().height > 0;
  }

  function findVideoInDOM(videoId, type) {
    // Regular video cards link via /watch?v=<id>, shorts cards via /shorts/<id>.
    // Default to 'video' for back-compat with entries saved before the type field.
    const isShorts = type === 'shorts';
    let links = [];
    if (isShorts) {
      links = querySelectorAllDeep(`a[href*="/shorts/${videoId}"]`);
      if (links.length === 0) {
        // Fall back to watch links as a safety net (IDs share the same namespace).
        links = querySelectorAllDeep(`a[href*="/watch?v=${videoId}"]`);
      }
    } else {
      links = querySelectorAllDeep(`a[href*="/watch?v=${videoId}"]`);
      if (links.length === 0) {
        links = querySelectorAllDeep(`a[href*="/shorts/${videoId}"]`);
      }
    }
    // Skip matches that are present but not rendered yet; the caller then scans,
    // which is what triggers the grid to finish laying out.
    for (const link of links) {
      if (isRendered(link)) return link;
    }
    return null;
  }

  function scrollVideoIntoView(link) {
    const videoContainer = findVideoContainer(link);
    const rect = videoContainer.getBoundingClientRect();
    const targetScrollY = Math.max(0, window.scrollY + rect.top - 120);
    window.scrollTo({ top: targetScrollY, behavior: 'instant' });
    console.log('[SS:yt] ✅ Scrolled to video at scrollY:', targetScrollY);
  }

  // ---- Refresh before scan ----
  // Reported issue: scanning for the saved video on a page that was already open
  // (reached by YouTube's in-page navigation, or scrolled by an earlier scan)
  // produced repeated loading spinners, a scrambled card order, and extra
  // auto-scroll. A manual refresh fixes it, so in that dirty state we reload once
  // and scan the clean result.
  //
  // A hard page load is NOT dirty: it starts at the top with no previous cards.
  // Reloading it would make every visit do two page loads and add a long delay
  // before the restore, so `hasInAppNavigation` gates the refresh. Initial loads
  // scan directly; only in-app navigation pays for a reload.
  //
  // The marker lives in sessionStorage so it survives the reload. It is consumed
  // at the START of the next restore, before anything can bail out. A card already
  // on screen is scrolled to directly; every other dirty-navigation case gets
  // exactly one reload.
  //
  // Note this is NOT a "is the page still fresh?" guess — it never decides to
  // skip a needed reload. Its only time element is a TTL on the marker itself, so
  // a marker orphaned by an interrupted cycle (the user left before the
  // post-reload restore ran) is ignored rather than replayed much later. An
  // expired marker can only cause an extra reload, never a skipped one.
  const SCAN_RELOAD_TTL_MS = 60000;

  function restoreReloadKey(url) {
    return 'ss_scan_reload_' + normalizeUrl(url);
  }

  // Consume the marker and report whether this restore follows our own reload.
  // Call once per restore, before touching the DOM.
  function consumeScanReload(url) {
    try {
      const key = restoreReloadKey(url);
      const raw = sessionStorage.getItem(key);
      if (raw === null) return false;
      sessionStorage.removeItem(key);
      const markedAt = Number(raw);
      return Number.isFinite(markedAt) && (Date.now() - markedAt) < SCAN_RELOAD_TTL_MS;
    } catch (e) {
      return false;
    }
  }

  // Mark the URL and reload so the scan starts from a clean page. Returns false
  // only when sessionStorage is unavailable — then a reload could not be tracked
  // and the caller scans as-is rather than risk a loop.
  function reloadForScan(url) {
    try {
      sessionStorage.setItem(restoreReloadKey(url), String(Date.now()));
    } catch (e) {
      console.warn('[SS:yt] sessionStorage unavailable — scanning without refresh');
      return false;
    }
    console.log('[SS:yt] 🔄 Refreshing page before scan');
    window.location.reload();
    return true;
  }

  function showYouTubeToast(message) {
    const toast = document.createElement('div');
    toast.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;background:#333;color:#fff;padding:12px 20px;border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:350px;opacity:0;transition:opacity 0.3s;pointer-events:none;';
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 500);
    }, 5000);
  }

  function notifyVideoNotFound(videoId) {
    console.warn('[SS:yt] Video not found:', videoId, '(may have been removed, or saved from another tab such as Shorts/Live)');
    showYouTubeToast('Video not found in this tab — it may have been removed, or saved from Shorts/Live.');
  }

  function cleanupYTScan() {
    if (ytScanTimer) {
      clearTimeout(ytScanTimer);
      ytScanTimer = null;
    }
    ytScanLastHeight = 0;
    ytScanStallCount = 0;
    ytScanNoGrowthStreak = 0;
    ytScanTotalStalls = 0;
    detachYTScanInterrupt();
  }

  function attachYTScanInterrupt() {
    if (ytScanInterruptHandler) return;
    ytScanInterruptHandler = function(e) {
      if (!e.isTrusted) return;
      ytScanUserInterrupted = true;
      console.log('[SS:yt] Scan interrupted by user', e.type, 'event');
    };
    window.addEventListener('wheel', ytScanInterruptHandler, { passive: true });
    window.addEventListener('keydown', ytScanInterruptHandler, { passive: true });
    window.addEventListener('touchstart', ytScanInterruptHandler, { passive: true });
  }

  function detachYTScanInterrupt() {
    if (!ytScanInterruptHandler) return;
    window.removeEventListener('wheel', ytScanInterruptHandler);
    window.removeEventListener('keydown', ytScanInterruptHandler);
    window.removeEventListener('touchstart', ytScanInterruptHandler);
    ytScanInterruptHandler = null;
    ytScanUserInterrupted = false;
  }

  function progressiveScanForVideo(videoId, attempt, saved) {
    attempt = attempt || 0;
    // The old caps (60 attempts / 20 cumulative stalls) could abort a long
    // channel on a slow connection long before its end: a few slow lazy loads
    // accumulated stalls and the scan declared the channel finished. The attempt
    // cap is now only a safety net; the real end is a long run of consecutive
    // attempts with no height growth.
    const MAX_ATTEMPTS = 300;
    const MAX_CONSECUTIVE_NO_GROWTH = 15;
    const RETRY_DELAY = 1000;

    if (!isExtensionValid()) {
      cleanupYTScan();
      finishRestore();
      return;
    }

    // Always give the current DOM a chance before declaring failure: the last
    // lazy-loaded batch may contain the target even when the page height did not
    // change (cards can be recycled in place).
    const videoLink = findVideoInDOM(videoId, saved && saved.type);
    if (videoLink) {
      console.log('[SS:yt] ✅ Found video:', videoId, 'type=' + ((saved && saved.type) || 'video'));
      scrollVideoIntoView(videoLink);
      cleanupYTScan();
      finishRestore();
      return;
    }

    if (attempt >= MAX_ATTEMPTS) {
      console.log('[SS:yt] ABORT: max attempts reached, video not found');
      cleanupYTScan();
      notifyVideoNotFound(videoId);
      removeYouTubePosition();
      finishRestore();
      return;
    }

    if (ytScanNoGrowthStreak >= MAX_CONSECUTIVE_NO_GROWTH) {
      console.log('[SS:yt] Reached end of channel — video', videoId, 'not found');
      cleanupYTScan();
      notifyVideoNotFound(videoId);
      removeYouTubePosition();
      finishRestore();
      return;
    }

    const docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const maxScroll = Math.max(0, docHeight - window.innerHeight);

    window.scrollTo({ top: maxScroll, behavior: 'instant' });
    window.dispatchEvent(new Event('scroll', { bubbles: true }));

    const newHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    if (newHeight === ytScanLastHeight) {
      ytScanStallCount++;
      ytScanNoGrowthStreak++;
      ytScanTotalStalls++;
    } else {
      ytScanLastHeight = newHeight;
      ytScanStallCount = 0;
      ytScanNoGrowthStreak = 0;
    }

    if (ytScanStallCount >= 3 && window.scrollY < maxScroll - 100) {
      console.log('[SS:yt] Height stalled, wiggling to trigger lazy load');
      const wiggleUp = Math.max(0, window.scrollY - 300);
      window.scrollTo({ top: wiggleUp, behavior: 'instant' });
      window.dispatchEvent(new Event('scroll', { bubbles: true }));
      setTimeout(() => {
        window.scrollTo({ top: maxScroll, behavior: 'instant' });
        window.dispatchEvent(new Event('scroll', { bubbles: true }));
      }, 150);
      ytScanStallCount = 0;
    }

    console.log('[SS:yt] Scan attempt', attempt + 1, '/', MAX_ATTEMPTS,
      'page height', newHeight,
      'no-growth', ytScanNoGrowthStreak + '/' + MAX_CONSECUTIVE_NO_GROWTH,
      'total stalls', ytScanTotalStalls);

    if (ytScanUserInterrupted) {
      console.log('[SS:yt] ABORT: user interrupted scan');
      cleanupYTScan();
      finishRestore();
      return;
    }

    ytScanTimer = setTimeout(() => {
      progressiveScanForVideo(videoId, attempt + 1, saved);
    }, RETRY_DELAY);
  }

  function restoreYouTubePosition(urlOverride) {
    const targetUrl = urlOverride || currentUrl;
    console.log('[SS:yt] 🔄 restoreYouTubePosition called, url:', targetUrl);

    // While a pre-scan reload is pending, isRestoring stays true, so any further
    // trigger (there can be two per document) bails here instead of reloading again.
    if (isRestoring) {
      console.log('[SS:yt] Already restoring, skipping');
      return;
    }

    if (!isExtensionValid()) {
      console.warn('[SS:yt] Extension context invalidated, skipping restore');
      return;
    }

    isRestoring = true;
    cleanupYTScan();

    // Consume the "we already reloaded for this" marker first, before any early
    // return, so it cannot survive into a later navigation and skip a refresh.
    const scanReloaded = consumeScanReload(targetUrl);

    const key = getYouTubeStorageKey(targetUrl);
    console.log('[SS:yt] Looking for storage key:', key);

    try {
      chrome.storage.local.get([key], (result) => {
        if (chrome.runtime.lastError) {
          console.error('[SS:yt] Error reading YouTube position:', chrome.runtime.lastError);
          finishRestore();
          return;
        }

        // The page can navigate while the read is in flight. Acting now would
        // apply the previous page's video to the new page's DOM — and a failed
        // scan would remove the NEW page's saved position, not the old one.
        if (normalizeUrl(targetUrl) !== normalizeUrl(currentUrl)) {
          console.log('[SS:yt] Page changed mid-restore, abandoning:', targetUrl);
          finishRestore();
          return;
        }

        const saved = result[key];
        if (!saved || !saved.videoId) {
          console.log('[SS:yt] No saved videoId found');
          finishRestore();
          return;
        }

        console.log('[SS:yt] ✅ Found videoId:', saved.videoId, 'type=' + (saved.type || 'video'), 'saved at:', new Date(saved.timestamp).toLocaleTimeString());

        // Act once per page per document — otherwise a second trigger re-scrolls
        // or re-scans the page we just restored.
        const normalizedTarget = normalizeUrl(targetUrl);
        if (restoredThisDocument.has(normalizedTarget)) {
          console.log('[SS:yt] Already restored this page in this document, skipping');
          finishRestore();
          return;
        }
        restoredThisDocument.add(normalizedTarget);

        const videoLink = findVideoInDOM(saved.videoId, saved.type);
        if (videoLink) {
          console.log('[SS:yt] Video already in DOM, scrolling to it');
          scrollVideoIntoView(videoLink);
          finishRestore();
          return;
        }

        // The target is off-screen and must be scanned for. On a hard page load
        // the DOM is already clean, so scan immediately (no forced second load).
        // Only an in-app navigation carries stale state worth refreshing for.
        if (hasInAppNavigation && !scanReloaded) {
          if (reloadForScan(targetUrl)) {
            // Deliberately do NOT finishRestore(): keeping isRestoring true blocks
            // any second trigger until the reload unloads this document.
            return;
          }
        }

        console.log('[SS:yt] Starting progressive scan for video:', saved.videoId);
        attachYTScanInterrupt();
        progressiveScanForVideo(saved.videoId, 0, saved);
      });
    } catch (error) {
      console.error('[SS:yt] Failed to restore YouTube position:', error);
      finishRestore();
    }
  }

  // Save position immediately when a video is clicked on a YouTube channel page.
  // Uses capture phase so we run BEFORE YouTube's click handler SPA-navigates away.
  function handleVideoClick(event) {
    if (!isEnabledForUrl) {
      console.log('[SS:click] CLICK: ignored - extension not enabled for this channel');
      return;
    }

    if (!isYouTubeChannelPage()) {
      console.log('[SS:click] CLICK: ignored - not a YouTube channel page');
      return;
    }

    // Ignore non-primary buttons (middle/right). For keyboard-activated clicks
    // event.button is 0, so those still pass.
    if (typeof event.button === 'number' && event.button !== 0) {
      return;
    }

    const link = event.target.closest('a');
    if (!link) {
      console.log('[SS:click] CLICK: ignored - no <a> ancestor');
      return;
    }

    const href = link.getAttribute('href');

    // YouTube begins SPA navigation on pointerdown/mousedown (before the click
    // event), so we intercept those too. Dedupe so the follow-up click for the
    // same link doesn't re-run the whole save.
    if (href && href === lastHandledVideoHref && Date.now() - lastHandledVideoTime < 1500) {
      return;
    }

    console.log('[SS:click] CLICK: detected link href:', href, '(' + event.type + ')');

    // Accept both relative (/watch?v=..., /shorts/...) and absolute YouTube
    // watch/shorts links. Track which content type it is so the popup can build
    // the right URL and the restore scan searches the right card selector.
    let isVideoLink = false;
    let mediaType = null;
    if (href) {
      if (href.startsWith('/watch?v=')) {
        isVideoLink = true;
        mediaType = 'video';
      } else if (href.startsWith('https://www.youtube.com/watch?v=') ||
                 href.startsWith('http://www.youtube.com/watch?v=') ||
                 href.startsWith('https://youtube.com/watch?v=') ||
                 href.startsWith('http://youtube.com/watch?v=')) {
        isVideoLink = true;
        mediaType = 'video';
      } else if (href.startsWith('/shorts/')) {
        isVideoLink = true;
        mediaType = 'shorts';
      } else if (href.startsWith('https://www.youtube.com/shorts/') ||
                 href.startsWith('http://www.youtube.com/shorts/') ||
                 href.startsWith('https://youtube.com/shorts/') ||
                 href.startsWith('http://youtube.com/shorts/')) {
        isVideoLink = true;
        mediaType = 'shorts';
      }
    }

    if (!isVideoLink) {
      console.log('[SS:click] CLICK: ignored - not a /watch?v= or /shorts/ link');
      return;
    }

    // Mark this link as handled so the follow-up pointerup/click doesn't re-run.
    lastHandledVideoHref = href;
    lastHandledVideoTime = Date.now();

    // Extract the content ID so we can restore to it later. Regular videos carry
    // it in a query param (?v=...); shorts carry it as a path segment (/shorts/<id>).
    let videoId = null;
    if (mediaType === 'shorts') {
      const shortMatch = href.match(/\/shorts\/([^/?#]+)/);
      videoId = shortMatch ? shortMatch[1] : null;
    } else {
      const videoIdMatch = href.match(/[?&]v=([^&]+)/);
      videoId = videoIdMatch ? videoIdMatch[1] : null;
    }

    console.log('[SS:click] 🎬 Video link clicked:', href, 'videoId:', videoId, '(type=', mediaType + ')');

    // Save the content ID + type only — no scroll position. On restore, we scan
    // the channel for this card and scroll it back into view.
    saveYouTubePosition(videoId, mediaType, readCardDuration(link));
  }

  // Manage click-to-save listener lifecycle: attach only when the current URL is
  // an added (enabled) YouTube channel page. This keeps the listener off for
  // channels the user never added, so a stray click cannot create a stored entry.
  function ensureClickListener() {
    if (isYouTubeChannelPage() && isEnabledForUrl) {
      if (!clickListenerAttached) {
        // pointerdown fires BEFORE YouTube's SPA navigation, so it reliably
        // captures fast clicks; click is kept for keyboard activation.
        document.addEventListener('pointerdown', handleVideoClick, true);
        document.addEventListener('click', handleVideoClick, true);
        clickListenerAttached = true;
        console.log('[SS:click] 🖱️ Click interception attached for YouTube channel page');
      }
    } else {
      if (clickListenerAttached) {
        document.removeEventListener('pointerdown', handleVideoClick, true);
        document.removeEventListener('click', handleVideoClick, true);
        clickListenerAttached = false;
        console.log('[SS:click] 🖱️ Click interception removed (not a YouTube channel page)');
      }
    }
  }

  // Handle URL changes (for SPAs)
  function observeUrlChanges() {
    let lastUrl = window.location.href;

    // A navigation starts a fresh restore cycle. Clearing here lets the new page
    // be handled once even when it reuses a URL handled earlier in this document
    // (for example returning to the same channel from one of its videos).
    function handleUrlChange() {
      // Any restore or scan left running from the previous page is now moot: it
      // would either block this page's restore via isRestoring, or keep scanning
      // for the old video in the new page's DOM.
      cleanupYTScan();
      isRestoring = false;
      restoredThisDocument.clear();
      hasInAppNavigation = true;
      lastUrl = window.location.href;
      currentUrl = lastUrl;
      // Assume the new URL is not added until the re-check below says otherwise,
      // so a click during the async round-trip cannot save an entry for a channel
      // the user never added. refreshEnabledState re-enables it if it is added.
      isEnabledForUrl = false;
      ensureClickListener();
      // Re-read the enabled state for the new URL before touching the listener or
      // restoring: an SPA navigation can move between added and non-added
      // channels, and the click-to-save listener must follow that state.
      refreshEnabledState(function(isEnabled) {
        if (isEnabled && isYouTubeChannelPage()) {
          setTimeout(() => restoreYouTubePosition(), 2500);
        }
      });
    }

    // A route change is detected purely by comparing the URL, whatever triggered
    // it. This matters for YouTube: switching channel tabs only mutates shadow
    // DOM, which MutationObserver cannot see, so the observer alone misses it and
    // the stored video is never restored on an in-app tab switch.
    function maybeHandleUrlChange() {
      if (window.location.href !== lastUrl) handleUrlChange();
    }

    const observer = new MutationObserver(maybeHandleUrlChange);
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // YouTube fires this after each in-app navigation; the poll is the safety
    // net for SPAs (and shadow-DOM renders) that fire neither a mutation we can
    // see nor a popstate.
    document.addEventListener('yt-navigate-finish', maybeHandleUrlChange);
    setInterval(maybeHandleUrlChange, 1000);

    // Also listen to history API changes
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function(...args) {
      originalPushState.apply(this, args);
      setTimeout(maybeHandleUrlChange, 100);
    };

    history.replaceState = function(...args) {
      originalReplaceState.apply(this, args);
      setTimeout(maybeHandleUrlChange, 100);
    };

    // Listen to popstate (back/forward navigation)
    window.addEventListener('popstate', () => setTimeout(maybeHandleUrlChange, 100));
  }

  // Set up tracking for YouTube channel pages (video-ID-only)
  function setupYouTubeTracking() {
    if (isTrackingActive) return;
    isTrackingActive = true;

    console.log('[SS:init] Scroll Saver active for (YouTube channel):', document.title);

    // Click-to-save listener: intercept video clicks to save videoId
    ensureClickListener();

    const urlAtTrackStart = currentUrl;

    // YouTube channel pages need time for their video grid to render
    const delay = 3000;
    console.log('[SS:init] Scheduling restoreYouTubePosition in', delay, 'ms, url:', urlAtTrackStart);

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => restoreYouTubePosition(urlAtTrackStart), delay);
      });
    } else {
      setTimeout(() => restoreYouTubePosition(urlAtTrackStart), delay);
    }
  }

  // React to the current channel being added/removed from the popup while this
  // page stays open. Without this, clicking Add would not enable click-to-save
  // until the next navigation or reload, so the first video click would be lost.
  function watchEnabledSitesChanges() {
    if (!chrome.storage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener(function(changes, areaName) {
      if (areaName !== 'local' || !changes.enabled_sites) return;
      if (!isExtensionValid()) return;
      console.log('[SS:init] enabled_sites changed, re-evaluating for current URL');
      refreshEnabledState();
    });
  }

  // Read the enabled (added-channel) state for the current URL and apply it. Used
  // on init and after every SPA navigation, so the click listener and restore
  // always reflect the URL that is actually loaded.
  function refreshEnabledState(callback) {
    if (!isExtensionValid()) {
      proceedWithInit(false);
      if (callback) callback(false);
      return;
    }

    chrome.runtime.sendMessage(
      { action: 'get_extension_enabled', url: window.location.href },
      function(response) {
        if (chrome.runtime.lastError) {
          console.error('[SS:init] Error checking extension enabled state:', chrome.runtime.lastError);
          proceedWithInit(false);
          if (callback) callback(false);
          return;
        }
        const isEnabled = response && response.enabled === true;
        console.log('[SS:init] Extension enabled state for this URL:', isEnabled);
        proceedWithInit(isEnabled);
        if (callback) callback(isEnabled);
      }
    );
  }

  // Check if page is a YouTube channel page
  function isYouTubeChannelPage() {
    const hostname = window.location.hostname;
    const pathname = window.location.pathname;
    return (hostname.includes('youtube.com') || hostname.includes('youtu.be')) &&
           pathname.startsWith('/@');
  }

  // ---- Watch-page Prev / Next (same-origin Inner API fetch) ----
  //
  // YouTube's watch page calls /youtubei/v1/next with the channel's uploads
  // playlist (UU<channelId without "UC">). One request returns the current
  // video's absolute position plus a window of ~99 adjacent videos. That
  // playlist omits members-only videos and mixes in Shorts; a members-only video
  // is therefore skipped by design.
  //
  // This MUST run in the content script, not the service worker: a request from
  // the extension origin is rejected with HTTP 403 by YouTube's bot protection,
  // while a request from the page's own origin passes. The current WEB client
  // version comes from the page's ytcfg, so it never goes stale.
  const YT_NAV_FALLBACK = {
    // The public WEB key every YouTube page ships, used only if the page's
    // inline ytcfg cannot be read. Not a user secret.
    key: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    version: '2.20240101.00.00'
  };

  function readInnertubeConfig() {
    const cfg = { key: YT_NAV_FALLBACK.key, version: YT_NAV_FALLBACK.version };
    try {
      const scripts = document.querySelectorAll('script:not([src])');
      for (let i = 0; i < scripts.length; i++) {
        const text = scripts[i].textContent;
        if (!text) continue;
        if (!cfg.keyFound) {
          const k = text.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
          if (k) { cfg.key = k[1]; cfg.keyFound = true; }
        }
        if (!cfg.versionFound) {
          const v = text.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/);
          if (v) { cfg.version = v[1]; cfg.versionFound = true; }
        }
        if (cfg.keyFound && cfg.versionFound) break;
      }
    } catch (e) { /* keep fallbacks */ }
    return cfg;
  }

  function ytNavPanel(json) {
    const panel = json && json.contents && json.contents.twoColumnWatchNextResults
      && json.contents.twoColumnWatchNextResults.playlist
      && json.contents.twoColumnWatchNextResults.playlist.playlist;
    if (!panel || !Array.isArray(panel.contents)) return null;
    return panel;
  }

  function ytNavItem(item) {
    const title = (item.title && (item.title.simpleText
      || (item.title.runs || []).map(function(r) { return r.text; }).join(''))) || '';
    const thumbs = item.thumbnail && item.thumbnail.thumbnails;
    return {
      videoId: item.videoId,
      title: title,
      duration: (item.lengthText && item.lengthText.simpleText) || '',
      thumbnail: thumbs && thumbs.length ? thumbs[thumbs.length - 1].url : null
    };
  }

  function ytNavFetch(path, body, cfg) {
    return fetch('/youtubei/v1/' + path + '?key=' + encodeURIComponent(cfg.key) + '&prettyPrint=false', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-YouTube-Client-Name': '1',
        'X-YouTube-Client-Version': cfg.version,
        'X-Origin': 'https://www.youtube.com',
        'X-Youtube-Bootstrap-Logged-In': 'false',
        'X-Goog-Api-Format-Version': '1'
      },
      body: JSON.stringify(body)
    }).then(function(res) {
      if (!res.ok) throw new Error('YouTube API HTTP ' + res.status);
      return res.json();
    });
  }

  // Reduce an owner profile URL ("http://www.youtube.com/@handle") to its
  // https channel root, which is how stored positions are keyed.
  function normalizeChannelProfileUrl(raw) {
    if (!raw) return null;
    try {
      const u = new URL(raw.indexOf('http') === 0 ? raw : 'https://' + raw);
      if (!u.hostname.includes('youtube.com')) return null;
      const m = u.pathname.match(/^\/(@[^/]+|channel\/[A-Za-z0-9_-]+)/);
      if (!m) return null;
      return 'https://www.youtube.com/' + m[1];
    } catch (e) { return null; }
  }

  async function fetchWatchNav(videoId, listId) {
    const cfg = readInnertubeConfig();
    const context = { client: { clientName: 'WEB', clientVersion: cfg.version, hl: 'en', gl: 'US' } };
    // The cheap /player response (~10 KB) gives the channel id and the channel
    // page URL, needed both to find the channel's videos and to refresh its
    // stored position when the user navigates.
    const player = await ytNavFetch('player', { context: context, videoId: videoId }, cfg);
    const channelId = player && player.videoDetails && player.videoDetails.channelId;
    const channelUrl = normalizeChannelProfileUrl(
      player && player.microformat && player.microformat.playerMicroformatRenderer
        && player.microformat.playerMicroformatRenderer.ownerProfileUrl
    );

    // The channel's uploads playlist (or an explicit list=). One request returns
    // the video's position plus ~99 neighbours. It omits members-only videos and
    // mixes in Shorts, so both are skipped by design.
    let playlistId = listId;
    if (!playlistId) {
      if (!channelId) throw new Error('channel id unavailable');
      playlistId = 'UU' + channelId.slice(2);
    }
    const json = await ytNavFetch('next', { context: context, videoId: videoId, playlistId: playlistId }, cfg);
    const panel = ytNavPanel(json);
    if (!panel) throw new Error('no playlist panel');
    const items = panel.contents.map(function(c) {
      return c && c.playlistPanelVideoRenderer;
    }).filter(Boolean);
    let pos = -1;
    for (let i = 0; i < items.length; i++) { if (items[i].videoId === videoId) { pos = i; break; } }
    if (pos < 0) { for (let i = 0; i < items.length; i++) { if (items[i].selected) { pos = i; break; } } }
    if (pos < 0) throw new Error('current video not in playlist');
    const current = ytNavItem(items[pos]);
    // Guard against the "video not actually in this playlist" case, where
    // YouTube still returns a panel but the selected entry is not our video.
    if (current.videoId !== videoId) throw new Error('playlist mismatch');
    return {
      // Bump when the nav shape changes; the background ignores older caches.
      schema: 2,
      videoId: videoId,
      playlistId: playlistId,
      index: typeof panel.currentIndex === 'number' ? panel.currentIndex : null,
      current: current,
      // Channel identity, used to refresh the channel's stored position. Only
      // safe for the channel's own uploads list; an arbitrary list= may span
      // channels.
      channelId: channelId || null,
      channelUrl: channelUrl || null,
      channelUploads: !!(channelId && playlistId === 'UU' + channelId.slice(2)),
      // Items are ordered newest -> oldest, so the previous array entry is the
      // newer upload and the next entry is the older one.
      prev: pos > 0 ? ytNavItem(items[pos - 1]) : null,
      next: pos + 1 < items.length ? ytNavItem(items[pos + 1]) : null
    };
  }

  // The background proxies popup requests here so the fetch is same-origin.
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
      if (!request || request.action !== 'fetch_watch_nav') return;
      fetchWatchNav(request.videoId, request.listId)
        .then(function(nav) { sendResponse({ ok: true, nav: nav }); })
        .catch(function(err) {
          console.warn('[SS:nav] fetch failed:', err && err.message);
          sendResponse({ ok: false, error: (err && err.message) || 'fetch failed' });
        });
      return true; // async response
    });
  }

  // Initialize
  function init() {
    console.log('[SS:init] 🚀 Extension init called, document.readyState:', document.readyState, 'URL:', window.location.href);

    // Set up URL change observation IMMEDIATELY — before any async round-trips.
    // YouTube and other SPAs change the URL via pushState during boot.
    // If we wait, those URL changes slip past our hijack and currentUrl
    // gets out of sync with the storage key used when the position was saved.
    observeUrlChanges();

    // Keep the click-to-save listener in sync when the channel is added/removed
    // from the popup while this page stays open.
    watchEnabledSitesChanges();

    // First check if extension is enabled for this URL
    refreshEnabledState();
  }

  // Proceed with initialization based on extension enabled state
  function proceedWithInit(isExtensionEnabled) {
    isEnabledForUrl = isExtensionEnabled;

    if (!isExtensionEnabled) {
      console.log('[SS:init] ❌ Extension disabled for this URL, skipping video-ID tracking');
      // Remove a listener left over from a previously-enabled page so it cannot
      // save an entry for a channel that is not added.
      ensureClickListener();
      return;
    }

    // YouTube channel pages — video-ID-only tracking (only supported page type)
    if (isYouTubeChannelPage()) {
      console.log('[SS:init] ✅ YouTube channel page detected, starting video-ID tracking');
      setupYouTubeTracking();
      // setupYouTubeTracking is a no-op after the first channel page in this
      // document, so re-assert the listener for the newly-visited channel here.
      ensureClickListener();
      return;
    }

    console.log('[SS:init] Not a YouTube channel page, skipping tracking');
    ensureClickListener();
  }

  // Start the extension
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose debug functions to window for manual testing
  window.debugReadingPosition = {
    isYouTubeChannelPage,
    isTrackingActive: () => isTrackingActive,
    isEnabled: () => isEnabledForUrl,
    isRestoring: () => isRestoring,
    currentUrl: () => currentUrl,
    getYouTubeStorageKey,
    getStorageKey: getYouTubeStorageKey, // Back-compat alias for tests
    normalizeUrl,
    checkStorage: () => {
      if (!isExtensionValid()) {
        console.warn('[SS:debug] Extension context invalidated, cannot check storage');
        return;
      }
      const ytKey = getYouTubeStorageKey(currentUrl);
      chrome.storage.local.get([ytKey], (result) => {
        console.log('[SS:debug] YouTube storage check for key', ytKey, ':', result[ytKey] ? 'FOUND' : 'NOT FOUND');
        if (result[ytKey]) { console.log('[SS:debug] YouTube Position:', result[ytKey]); }
      });
    },
    // "Force" means ignore the once-per-navigation dedupe so a restore can be
    // re-run on demand (used by the live validation scripts).
    forceRestore: () => { restoredThisDocument.clear(); restoreYouTubePosition(); },
    forceYouTubeRestore: () => { restoredThisDocument.clear(); restoreYouTubePosition(); },
  };

  console.log('[SS:init] 📖 Scroll Saver (YouTube) loaded. Debug: window.debugReadingPosition');

})();
