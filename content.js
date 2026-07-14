// Scroll Saver - Content Script

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

  // Configuration
  const SCROLL_SAVE_DEBOUNCE_MS = 1000;
  const MIN_SCROLL_HEIGHT = 1500; // Minimum page height to consider worth saving
  const MIN_SCROLL_PERCENT = 5;   // Minimum scroll percent to save (avoid saving top)
  const ARTICLE_SELECTORS = [
    'article',
    'main',
    '[role="main"]',
    '.post',
    '.article',
    '.content',
    '.post-content',
    '.entry-content',
    '.blog-post',
    '.story',
    // Twitter/X specific selectors
    '[data-testid="tweet"]',
    'article[role="article"]',
    '[role="article"]'
  ];

  // State
  let currentUrl = window.location.href;
  let scrollTimeout = null;
  let isRestoring = false;
  let lastSavedPosition = 0;
  let isTrackingActive = false;
  let retryCount = 0;
  const MAX_RETRIES = 10;
  const RETRY_DELAY_MS = 1000;
  let lastProgressiveHeight = 0;
  let progressiveStallCount = 0;
  let totalHeightStalls = 0;
  let restoreCompletedAt = 0;
  const POST_RESTORE_COOLDOWN_MS = 3000;
  let clickListenerAttached = false;
  // Dedupe pointerdown + click firing for the same video link in quick succession.
  let lastHandledVideoHref = null;
  let lastHandledVideoTime = 0;

  // Progressive scroll state (for infinite-scroll / paginated pages)
  let progressiveScrollTimer = null;
  let userInterruptedProgressive = false;

  // YouTube video-ID scan state
  let ytScanTimer = null;
  let ytScanUserInterrupted = false;
  let ytScanLastHeight = 0;
  let ytScanStallCount = 0;
  let ytScanTotalStalls = 0;
  let ytScanInterruptHandler = null;

  // Normalize URL for storage (remove tracking parameters, etc.)
  function normalizeUrl(url) {
    try {
      const urlObj = new URL(url);

      // Twitter/X normalization
      if (urlObj.hostname.includes('x.com') || urlObj.hostname.includes('twitter.com')) {
        // Remove common tracking parameters
        const paramsToRemove = ['s', 't', 'utm_source', 'utm_medium', 'utm_campaign', 'ref_src', 'ref_url'];
        paramsToRemove.forEach(param => urlObj.searchParams.delete(param));

        // Keep only the path for tweet pages (remove fragments)
        if (urlObj.pathname.includes('/status/')) {
          urlObj.hash = '';
        }
      }

      // YouTube normalization
      if (urlObj.hostname.includes('youtube.com') || urlObj.hostname.includes('youtu.be')) {
        // For channel pages, strip query params to normalize
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
    // Check if runtime is still available
    if (!chrome.runtime || !chrome.runtime.id) {
      console.warn('[SS:init] Extension context invalidated - runtime not available');
      return false;
    }

    // Check if storage API is available
    if (!chrome.storage || !chrome.storage.local) {
      console.warn('[SS:init] Extension context invalidated - storage not available');
      return false;
    }

    return true;
  }

  // Generate storage key for current URL
  function getStorageKey(url) {
    const normalizedUrl = normalizeUrl(url);
    return `reading_position_${normalizedUrl}`;
  }

  // Check if page is likely an article/long content
  function isArticlePage() {
    // Check for article-specific elements
    for (const selector of ARTICLE_SELECTORS) {
      if (document.querySelector(selector)) {
        return true;
      }
    }

    // Check page length
    const bodyHeight = document.body.scrollHeight;
    const viewportHeight = window.innerHeight;
    const isLongPage = bodyHeight > viewportHeight * 2; // At least 2 viewports tall

    // Check for lots of text content
    const textLength = document.body.innerText.length;
    const isTextHeavy = textLength > 2000;

    return isLongPage || isTextHeavy;
  }

  // Get the element that actually scrolls
  function getScrollContainer() {
    return null; // null means use window/document.body
  }

  // Get scroll position using the correct scroll container
  function getScrollPosition() {
    const container = getScrollContainer();
    let maxScroll, scrollY;

    if (container && container !== document.body) {
      scrollY = container.scrollTop;
      maxScroll = container.scrollHeight - container.clientHeight;
    } else {
      scrollY = window.scrollY;
      const docHeight = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.offsetHeight
      );
      maxScroll = docHeight - window.innerHeight;
    }

    let scrollPercent;
    if (maxScroll > 0) {
      scrollPercent = Math.min(100, Math.max(0, (scrollY / maxScroll) * 100));
    } else {
      scrollPercent = 0;
    }
    return {
      scrollY: scrollY,
      scrollPercent: scrollPercent,
      timestamp: Date.now(),
      url: currentUrl,
      title: document.title
    };
  }

  // Save scroll position to storage
  // urlOverride: use this URL for the storage key instead of the mutable global currentUrl
  // force: if true, bypass the 50px duplicate guard (used for explicit user actions like clicks)
  function saveScrollPosition(position, urlOverride, force) {
    // Don't save if we're at the very top (or minimal scroll)
    if (position.scrollY < 100 && position.scrollPercent < MIN_SCROLL_PERCENT) {
      console.log('[SS:save] Not saving - at top:', position.scrollY, 'px', position.scrollPercent.toFixed(1) + '%');
      return;
    }

    // Don't save if we've already saved this position recently
    if (!force && Math.abs(position.scrollY - lastSavedPosition) < 50) {
      console.log('[SS:save] Not saving - similar to last saved:', position.scrollY, 'vs', lastSavedPosition);
      return;
    }

    // Check if extension context is still valid
    if (!isExtensionValid()) {
      console.warn('[SS:save] Extension context invalidated, skipping save');
      return;
    }

    const url = urlOverride || currentUrl;
    const key = getStorageKey(url);
    position.url = url; // Ensure position URL matches the storage key
    console.log('[SS:save] Saving to storage key:', key);

    try {
      chrome.storage.local.set({ [key]: position }, () => {
        if (chrome.runtime.lastError) {
          console.error('[SS:save] Error saving scroll position:', chrome.runtime.lastError);
        } else {
          lastSavedPosition = position.scrollY;
          console.log('[SS:save] ✅ Saved scroll position:', position.scrollY, 'px', position.scrollPercent.toFixed(1) + '%', 'for:', document.title);
        }
      });
    } catch (error) {
      console.error('[SS:save] Failed to save scroll position:', error);
    }
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
    const selectors = 'ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer';

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

  // Clean up progressive scroll timer
  function cleanupProgressiveScroll() {
    if (progressiveScrollTimer) {
      clearTimeout(progressiveScrollTimer);
      progressiveScrollTimer = null;
    }
    lastProgressiveHeight = 0;
    progressiveStallCount = 0;
    totalHeightStalls = 0;
    detachProgressiveInterrupt();
  }

  // User interaction during progressive scroll — abort immediately so the
  // user's manual PageDown/scroll doesn't fight the programmatic scrollTo().
  let progressiveInterruptHandler = null;
  function attachProgressiveInterrupt() {
    if (progressiveInterruptHandler) return;
    progressiveInterruptHandler = function(e) {
      // Ignore synthetic (non-trusted) events dispatched by our own code.
      if (!e.isTrusted) return;
      userInterruptedProgressive = true;
      console.log('[SS:prog] Progressive scroll interrupted by user', e.type, 'event');
    };
    window.addEventListener('wheel', progressiveInterruptHandler, { passive: true });
    window.addEventListener('keydown', progressiveInterruptHandler, { passive: true });
    window.addEventListener('touchstart', progressiveInterruptHandler, { passive: true });
  }
  function detachProgressiveInterrupt() {
    if (!progressiveInterruptHandler) return;
    window.removeEventListener('wheel', progressiveInterruptHandler);
    window.removeEventListener('keydown', progressiveInterruptHandler);
    window.removeEventListener('touchstart', progressiveInterruptHandler);
    progressiveInterruptHandler = null;
    userInterruptedProgressive = false;
  }

  // Scroll to a position incrementally, triggering pagination along the way
  function progressiveScrollToPosition(targetScrollY, attempt, saved) {
    attempt = attempt || 0;
    const MAX_ATTEMPTS = 60;
    const MAX_TOTAL_HEIGHT_STALLS = 20;
    const RETRY_DELAY = 1000;
    const container = getScrollContainer();
    const isCustomContainer = container && container !== document.body;

    if (attempt >= MAX_ATTEMPTS) {
      const currentY = isCustomContainer ? container.scrollTop : window.scrollY;
      console.log('[SS:prog] ABORT: max attempts (' + MAX_ATTEMPTS + ') reached at scrollY=' + currentY +
        ' target=' + targetScrollY + ' totalStalls=' + totalHeightStalls + '/' + MAX_TOTAL_HEIGHT_STALLS);
      cleanupProgressiveScroll();
      finishRestore();
      return;
    }

    if (!isExtensionValid()) {
      cleanupProgressiveScroll();
      finishRestore();
      return;
    }

    if (totalHeightStalls >= MAX_TOTAL_HEIGHT_STALLS) {
      const currentY = isCustomContainer ? container.scrollTop : window.scrollY;
      console.log('[SS:prog] ABORT: height stalled for ' + totalHeightStalls + '/' + MAX_TOTAL_HEIGHT_STALLS +
        ' attempts — scrollY=' + currentY + ' target=' + targetScrollY);
      cleanupProgressiveScroll();
      finishRestore();
      return;
    }

    const effectiveHeight = isCustomContainer
      ? container.scrollHeight
      : Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const maxScroll = Math.max(0, effectiveHeight - (isCustomContainer ? container.clientHeight : window.innerHeight));
    const scrollTarget = Math.min(targetScrollY, maxScroll);

    if (isCustomContainer) {
      container.scrollTo({ top: scrollTarget, behavior: 'instant' });
    } else {
      window.scrollTo({ top: scrollTarget, behavior: 'instant' });
    }

    const currentY = isCustomContainer ? container.scrollTop : window.scrollY;
    const containerHeight = effectiveHeight;
    console.log('[SS:prog] Progressive scroll attempt', attempt + 1, '/', MAX_ATTEMPTS,
      'scrolled to', currentY, 'target', targetScrollY,
      'page height', containerHeight,
      'stalls', totalHeightStalls + '/' + MAX_TOTAL_HEIGHT_STALLS);

    if (currentY >= targetScrollY - 100) {
      console.log('[SS:prog] ABORT: reached target at ' + currentY + ' (target=' + targetScrollY + ')');
      cleanupProgressiveScroll();
      finishRestore();
      return;
    }

    // Detect stalled page growth. YouTube's infinite scroll sometimes ignores
    // synthetic scroll events; a small "wiggle" up and back down often triggers it.
    if (effectiveHeight === lastProgressiveHeight) {
      progressiveStallCount++;
      totalHeightStalls++;
    } else {
      lastProgressiveHeight = effectiveHeight;
      progressiveStallCount = 0;
    }

    if (progressiveStallCount >= 3) {
      // Only wiggle if we haven't hit the actual bottom of the page yet.
      // When currentY is already at/near maxScroll, wiggling just produces
      // visual noise (rapid up-down that shows "multiple spinning circles").
      const atBottom = scrollTarget >= maxScroll - 100;
      if (!atBottom) {
        console.log('[SS:prog] Progressive scroll: height stalled at', containerHeight,
          'for', progressiveStallCount, 'attempts, wiggling to trigger lazy load');
        const wiggleUp = Math.max(0, currentY - 300);
        if (isCustomContainer) {
          container.scrollTo({ top: wiggleUp, behavior: 'instant' });
        } else {
          window.scrollTo({ top: wiggleUp, behavior: 'instant' });
        }
        (isCustomContainer ? container : window).dispatchEvent(new Event('scroll', { bubbles: true }));
        setTimeout(() => {
          if (isCustomContainer) {
            container.scrollTo({ top: scrollTarget, behavior: 'instant' });
          } else {
            window.scrollTo({ top: scrollTarget, behavior: 'instant' });
          }
          (isCustomContainer ? container : window).dispatchEvent(new Event('scroll', { bubbles: true }));
        }, 150);
      } else {
        console.log('[SS:prog] Progressive scroll: already at bottom (maxScroll=' + maxScroll +
          '), skipping wiggle');
      }
      // Reset stall count so we don't wiggle every single attempt.
      progressiveStallCount = 0;
    }

    // Dispatch a scroll event on the right element to trigger lazy loading
    (isCustomContainer ? container : window).dispatchEvent(new Event('scroll', { bubbles: true }));

    // User pressed a key, scrolled, or tapped — abort immediately.
    if (userInterruptedProgressive) {
      console.log('[SS:prog] ABORT: user interrupted, aborting (scrollY=' + currentY + ' target=' + targetScrollY + ')');
      cleanupProgressiveScroll();
      finishRestore();
      return;
    }

    // Wait for content to load, then try again
    progressiveScrollTimer = setTimeout(() => {
      progressiveScrollToPosition(targetScrollY, attempt + 1, saved);
    }, RETRY_DELAY);
  }

  // Reset isRestoring (centralized for all restore exit paths)
  function finishRestore() {
    isRestoring = false;
    restoreCompletedAt = Date.now();
    detachProgressiveInterrupt();
    detachYTScanInterrupt();
    console.log('[SS:restore] Restore completed, isRestoring reset to false, 3s stability cooldown started');
  }

  // ============================================================
  // YouTube Channel — Video-ID-Only Position Tracking
  // ============================================================

  function getYouTubeStorageKey(url) {
    const normalizedUrl = normalizeUrl(url);
    return `yt_position_${normalizedUrl}`;
  }

  function saveYouTubePosition(videoId) {
    if (!videoId || !isExtensionValid()) return;
    const key = getYouTubeStorageKey(currentUrl);
    const data = { videoId, timestamp: Date.now() };
    chrome.storage.local.set({ [key]: data }, () => {
      if (chrome.runtime.lastError) {
        console.error('[SS:yt] Error saving YouTube position:', chrome.runtime.lastError);
      } else {
        console.log('[SS:yt] ✅ Saved videoId:', videoId);
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

  function findVideoInDOM(videoId) {
    const links = querySelectorAllDeep(`a[href*="/watch?v=${videoId}"]`);
    return links.length > 0 ? links[0] : null;
  }

  function scrollVideoIntoView(link) {
    const videoContainer = findVideoContainer(link);
    const rect = videoContainer.getBoundingClientRect();
    const targetScrollY = Math.max(0, window.scrollY + rect.top - 120);
    window.scrollTo({ top: targetScrollY, behavior: 'instant' });
    console.log('[SS:yt] ✅ Scrolled to video at scrollY:', targetScrollY);
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
    console.warn('[SS:yt] Video not found:', videoId, '(may have been deleted or made private)');
    showYouTubeToast('Video not found — it may have been deleted or made private.');
  }

  function cleanupYTScan() {
    if (ytScanTimer) {
      clearTimeout(ytScanTimer);
      ytScanTimer = null;
    }
    ytScanLastHeight = 0;
    ytScanStallCount = 0;
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
    const MAX_ATTEMPTS = 60;
    const MAX_TOTAL_HEIGHT_STALLS = 20;
    const RETRY_DELAY = 1000;

    if (attempt >= MAX_ATTEMPTS) {
      console.log('[SS:yt] ABORT: max attempts reached, video not found');
      cleanupYTScan();
      notifyVideoNotFound(videoId);
      removeYouTubePosition();
      finishRestore();
      return;
    }

    if (!isExtensionValid()) {
      cleanupYTScan();
      finishRestore();
      return;
    }

    if (ytScanTotalStalls >= MAX_TOTAL_HEIGHT_STALLS) {
      console.log('[SS:yt] Reached end of channel — video', videoId, 'not found');
      cleanupYTScan();
      notifyVideoNotFound(videoId);
      removeYouTubePosition();
      finishRestore();
      return;
    }

    const videoLink = findVideoInDOM(videoId);
    if (videoLink) {
      console.log('[SS:yt] ✅ Found video:', videoId);
      scrollVideoIntoView(videoLink);
      cleanupYTScan();
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
      ytScanTotalStalls++;
    } else {
      ytScanLastHeight = newHeight;
      ytScanStallCount = 0;
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
      'stalls', ytScanTotalStalls + '/' + MAX_TOTAL_HEIGHT_STALLS);

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

    const key = getYouTubeStorageKey(targetUrl);
    console.log('[SS:yt] Looking for storage key:', key);

    try {
      chrome.storage.local.get([key], (result) => {
        if (chrome.runtime.lastError) {
          console.error('[SS:yt] Error reading YouTube position:', chrome.runtime.lastError);
          finishRestore();
          return;
        }

        const saved = result[key];
        if (!saved || !saved.videoId) {
          console.log('[SS:yt] No saved videoId found');
          finishRestore();
          return;
        }

        console.log('[SS:yt] ✅ Found videoId:', saved.videoId, 'saved at:', new Date(saved.timestamp).toLocaleTimeString());

        const videoLink = findVideoInDOM(saved.videoId);
        if (videoLink) {
          console.log('[SS:yt] Video already in DOM, scrolling to it');
          scrollVideoIntoView(videoLink);
          finishRestore();
          return;
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

  // Restore scroll position from storage (articles only)
  // urlOverride: skip the mutable global currentUrl — use this URL for storage key lookup
  function restoreScrollPosition(urlOverride) {
    const targetUrl = urlOverride || currentUrl;
    console.log('[SS:restore] 🔄 restoreScrollPosition called, url:', targetUrl, 'isRestoring:', isRestoring);
    if (isRestoring) {
      console.log('[SS:restore] Already restoring, skipping');
      return;
    }

    // Check if extension context is still valid
    if (!isExtensionValid()) {
      console.warn('[SS:restore] Extension context invalidated, skipping restore');
      return;
    }

    // Set isRestoring synchronously BEFORE any async work so concurrent calls
    // are blocked immediately. Previously it was set inside the async callback,
    // allowing multiple restoreScrollPosition calls to race through.
    isRestoring = true;
    cleanupProgressiveScroll(); // abort any stale progressive scroll before starting

    const key = getStorageKey(targetUrl);
    console.log('[SS:restore] Looking for storage key:', key);

    try {
      chrome.storage.local.get([key], (result) => {
        if (chrome.runtime.lastError) {
          console.error('[SS:restore] Error restoring scroll position:', chrome.runtime.lastError);
          finishRestore();
          return;
        }

        console.log('[SS:restore] Storage result for key', key, ':',
          result[key] ? 'FOUND scrollY=' + result[key].scrollY : 'NOT FOUND');
        const saved = result[key];
        if (!saved || !saved.scrollY) {
          console.log('[SS:restore] No saved position found or invalid data');
          finishRestore();
          return;
        }

        // Determine current scroll relative to the saved position. On YouTube
        // back-navigation the page frequently loads a few hundred px BELOW the
        // saved position due to content re-rendering / layout shift. Previously
        // we skipped the restore entirely in that case, leaving the user past
        // the clicked video. Instead, scroll back UP to the saved position.
        const container = getScrollContainer();
        const isCustomContainer = container && container !== document.body;
        const currentScroll = isCustomContainer ? container.scrollTop : window.scrollY;
        console.log('[SS:restore] Current scroll:', currentScroll, 'Saved scroll:', saved.scrollY);
        const startedAbove = currentScroll > saved.scrollY + 50;
        if (startedAbove) {
          console.log('[SS:restore] Scrolled past saved position, scrolling up to restore');
        }

        console.log('[SS:restore] ✅ Restoring to saved position:', saved.scrollY, 'px', saved.scrollPercent.toFixed(1) + '%', 'saved at:', new Date(saved.timestamp).toLocaleTimeString());

        const effectiveHeight = isCustomContainer
          ? container.scrollHeight
          : Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        const maxScroll = effectiveHeight - (isCustomContainer ? container.clientHeight : window.innerHeight);
        const containerHeight = effectiveHeight;

        // Use progressive scroll for paginated/infinite-scroll pages
        // where the saved position is significantly beyond the current page height
        if (saved.scrollY > maxScroll + 500) {
          console.log('[SS:prog] Progressive scroll start — target=' + saved.scrollY +
            ' currentHeight=' + containerHeight + ' gap=' + (saved.scrollY - containerHeight) +
            ' max=' + maxScroll + ' videoId=' + (saved.videoId || 'none') +
            ' maxAttempts=' + 60 + ' maxStalls=' + 20);
          attachProgressiveInterrupt();
          progressiveScrollToPosition(saved.scrollY, 0, saved);
        } else {
          if (isCustomContainer) {
            container.scrollTo({
              top: saved.scrollY,
              behavior: 'smooth'
            });
          } else {
            window.scrollTo({
              top: saved.scrollY,
              behavior: 'smooth'
            });
          }

          // Wait for smooth scroll to actually complete before re-enabling saves.
          // Direction-aware: when scrolling DOWN we settle once we reach at/near
          // the target from below; when scrolling UP (page loaded past target)
          // we settle once we come back down to at/near the target.
          let scrollSettleChecks = 0;
          const MAX_SCROLL_SETTLE_CHECKS = 75; // 15 seconds at 200ms intervals
          const checkScrollSettled = () => {
            const currentY = isCustomContainer ? container.scrollTop : window.scrollY;
            const reached = startedAbove
              ? currentY <= saved.scrollY + 50
              : currentY >= Math.max(saved.scrollY - 50, 0);
            if (reached || scrollSettleChecks >= MAX_SCROLL_SETTLE_CHECKS) {
              finishRestore();
              return;
            }
            scrollSettleChecks++;
            setTimeout(checkScrollSettled, 200);
          };
          setTimeout(checkScrollSettled, 500);
        }
      });
    } catch (error) {
      console.error('[SS:restore] Failed to restore scroll position:', error);
      finishRestore();
    }
  }

  // Debounced scroll handler
  function handleScroll() {
    if (isYouTubeChannelPage()) return;
    if (isRestoring) return;
    if (Date.now() - restoreCompletedAt < POST_RESTORE_COOLDOWN_MS) return;

    if (scrollTimeout) {
      clearTimeout(scrollTimeout);
    }

    // Capture the URL NOW — if the user navigates before the debounce fires,
    // we must save the position under this URL, not the destination URL.
    const urlAtScroll = currentUrl;

    scrollTimeout = setTimeout(() => {
      if (!isTrackingActive) return;
      if (isRestoring) return;
      if (Date.now() - restoreCompletedAt < POST_RESTORE_COOLDOWN_MS) return;

      const position = getScrollPosition();
      saveScrollPosition(position, urlAtScroll);
    }, SCROLL_SAVE_DEBOUNCE_MS);
  }

  // Handle page unload to save final position
  function handlePageUnload() {
    if (isYouTubeChannelPage()) return;
    console.log('[SS:save] 📝 Page unload event fired, isTrackingActive:', isTrackingActive);
    if (!isTrackingActive) {
      console.log('[SS:save] Not tracking active, skipping save on unload');
      return;
    }

    console.log('[SS:save] Saving final position on page unload');
    const position = getScrollPosition();
    saveScrollPosition(position);
  }

  // Save position immediately when a video is clicked on a YouTube channel page.
  // Uses capture phase so we run BEFORE YouTube's click handler SPA-navigates away.
  function handleVideoClick(event) {
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

    // Accept both relative (/watch?v=...) and absolute YouTube watch links.
    let isVideoLink = false;
    if (href) {
      if (href.startsWith('/watch?v=')) {
        isVideoLink = true;
      } else if (href.startsWith('https://www.youtube.com/watch?v=') ||
                 href.startsWith('http://www.youtube.com/watch?v=') ||
                 href.startsWith('https://youtube.com/watch?v=') ||
                 href.startsWith('http://youtube.com/watch?v=')) {
        isVideoLink = true;
      }
    }

    if (!isVideoLink) {
      console.log('[SS:click] CLICK: ignored - not a /watch?v= link');
      return;
    }

    // Mark this link as handled so the follow-up pointerup/click doesn't re-run.
    lastHandledVideoHref = href;
    lastHandledVideoTime = Date.now();

    // Extract the video ID so we can restore to this video later.
    const videoIdMatch = href.match(/[?&]v=([^&]+)/);
    const videoId = videoIdMatch ? videoIdMatch[1] : null;

    console.log('[SS:click] 🎬 Video link clicked:', href, 'videoId:', videoId);

    // Save videoId only — no scroll position. On restore, we scan the channel
    // for this video.
    saveYouTubePosition(videoId);
  }

  // Manage click-to-save listener lifecycle: attach only when on a YouTube channel page.
  function ensureClickListener() {
    if (isYouTubeChannelPage()) {
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

    // Observe DOM mutations that might indicate route change
    const observer = new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        currentUrl = lastUrl;
        ensureClickListener();
        const ytChannel = isYouTubeChannelPage();
        const restoreDelay = ytChannel ? 2500 : 1000;
        setTimeout(() => {
          if (ytChannel) {
            restoreYouTubePosition();
          } else if (isArticlePage()) {
            restoreScrollPosition();
          }
        }, restoreDelay);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Also listen to history API changes
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function(...args) {
      if (scrollTimeout) {
        clearTimeout(scrollTimeout);
        scrollTimeout = null;
      }

      const leavingUrl = currentUrl;

      // Save current position for the URL we are LEAVING (articles only).
      if (isTrackingActive && !isRestoring && !isYouTubeChannelUrl(leavingUrl)) {
        const position = getScrollPosition();
        saveScrollPosition(position, leavingUrl);
      }

      originalPushState.apply(this, args);
      setTimeout(() => {
        if (window.location.href !== lastUrl) {
          lastUrl = window.location.href;
          currentUrl = lastUrl;
          ensureClickListener();
          const ytChannel = isYouTubeChannelPage();
          const restoreDelay = ytChannel ? 2500 : 500;
          setTimeout(() => {
            if (ytChannel) {
              restoreYouTubePosition();
            } else if (isArticlePage()) {
              restoreScrollPosition();
            }
          }, restoreDelay);
        }
      }, 100);
    };

    history.replaceState = function(...args) {
      if (scrollTimeout) {
        clearTimeout(scrollTimeout);
        scrollTimeout = null;
      }

      const leavingUrl = currentUrl;

      // Save current position for the URL we are LEAVING (articles only).
      if (isTrackingActive && !isRestoring && !isYouTubeChannelUrl(leavingUrl)) {
        const position = getScrollPosition();
        saveScrollPosition(position, leavingUrl);
      }

      originalReplaceState.apply(this, args);
      setTimeout(() => {
        if (window.location.href !== lastUrl) {
          lastUrl = window.location.href;
          currentUrl = lastUrl;
          ensureClickListener();
          const ytChannel = isYouTubeChannelPage();
          const restoreDelay = ytChannel ? 2500 : 500;
          setTimeout(() => {
            if (ytChannel) {
              restoreYouTubePosition();
            } else if (isArticlePage()) {
              restoreScrollPosition();
            }
          }, restoreDelay);
        }
      }, 100);
    };

    // Listen to popstate (back/forward navigation)
    window.addEventListener('popstate', () => {
      if (scrollTimeout) {
        clearTimeout(scrollTimeout);
        scrollTimeout = null;
      }

      const leavingUrl = currentUrl;

      // Save the position for the page we are LEAVING (articles only).
      if (isTrackingActive && !isRestoring && !isYouTubeChannelUrl(leavingUrl)) {
        const position = getScrollPosition();
        saveScrollPosition(position, leavingUrl);
      }

      setTimeout(() => {
        if (window.location.href !== lastUrl) {
          lastUrl = window.location.href;
          currentUrl = lastUrl;
          ensureClickListener();
          const ytChannel = isYouTubeChannelPage();
          const restoreDelay = ytChannel ? 2500 : 500;
          setTimeout(() => {
            if (ytChannel) {
              restoreYouTubePosition();
            } else if (isArticlePage()) {
              restoreScrollPosition();
            }
          }, restoreDelay);
        }
      }, 100);
    });
  }

  // Set up tracking for article pages (scroll-position-based)
  function setupTracking() {
    if (isTrackingActive) return;
    isTrackingActive = true;

    console.log('[SS:init] Scroll Saver active for (article):', document.title);

    // Set up scroll listener on both window and custom container
    window.addEventListener('scroll', handleScroll, { passive: true });
    const container = getScrollContainer();
    if (container && container !== document.body) {
      container.addEventListener('scroll', handleScroll, { passive: true });
      console.log('[SS:init] Scroll Saver: also listening on custom container:', container.tagName);
    }

    // Save position before page unload
    window.addEventListener('beforeunload', handlePageUnload);
    window.addEventListener('pagehide', handlePageUnload);

    // Save position on tab switch / app minimize
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && isTrackingActive && !isRestoring
          && Date.now() - restoreCompletedAt >= POST_RESTORE_COOLDOWN_MS) {
        console.log('[SS:save] Tab hidden, saving scroll position');
        saveScrollPosition(getScrollPosition());
      }
    });

    // Manage click-to-save listener lifecycle (no-op for articles)
    ensureClickListener();

    const urlAtTrackStart = currentUrl;

    // Restore position on load (after a delay to allow content to render)
    window.addEventListener('load', () => {
      setTimeout(() => restoreScrollPosition(urlAtTrackStart), 500);
    });

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => restoreScrollPosition(urlAtTrackStart), 300);
      });
    } else {
      setTimeout(() => restoreScrollPosition(urlAtTrackStart), 300);
    }
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

  // Check if page is a social media SPA that loads content dynamically
  function isSocialMediaSPA() {
    const hostname = window.location.hostname;
    return hostname.includes('x.com') ||
           hostname.includes('twitter.com') ||
           hostname.includes('reddit.com') ||
           hostname.includes('linkedin.com') ||
           hostname.includes('facebook.com');
  }

  // Check if page is a YouTube channel page
  function isYouTubeChannelPage() {
    const hostname = window.location.hostname;
    const pathname = window.location.pathname;
    return (hostname.includes('youtube.com') || hostname.includes('youtu.be')) &&
           pathname.startsWith('/@');
  }

  // Check if a specific URL is a YouTube channel (uses URL param, not window.location)
  function isYouTubeChannelUrl(url) {
    try {
      const u = new URL(url, window.location.origin);
      return (u.hostname.includes('youtube.com') || u.hostname.includes('youtu.be')) &&
             u.pathname.startsWith('/@');
    } catch (e) {
      return false;
    }
  }

  // Retry detection for SPAs
  function retryDetection() {
    if (isTrackingActive || retryCount >= MAX_RETRIES) return;

    retryCount++;
    console.log('[SS:init] Retry ' + retryCount + '/' + MAX_RETRIES + ' for article detection...');

    if (isArticlePage()) {
      console.log('[SS:init] Article detected on retry, starting tracking');
      setupTracking();
    } else {
      // Schedule next retry
      setTimeout(retryDetection, RETRY_DELAY_MS);
    }
  }

  // Initialize with retry logic for SPAs
  function init() {
    console.log('[SS:init] 🚀 Extension init called, document.readyState:', document.readyState, 'URL:', window.location.href);

    // Set up URL change observation IMMEDIATELY — before any async round-trips.
    // YouTube and other SPAs change the URL via pushState during boot.
    // If we wait, those URL changes slip past our hijack and currentUrl
    // gets out of sync with the storage key used when the position was saved.
    observeUrlChanges();

    // First check if extension is enabled for this URL
    chrome.runtime.sendMessage(
      { action: 'get_extension_enabled', url: window.location.href },
      function(response) {
        if (chrome.runtime.lastError) {
          console.error('[SS:init] Error checking extension enabled state:', chrome.runtime.lastError);
          // Default to disabled if error
          proceedWithInit(false);
        } else {
          const isEnabled = response.enabled === true; // default to disabled if undefined
          console.log('[SS:init] Extension enabled state for this URL:', isEnabled);
          proceedWithInit(isEnabled);
        }
      }
    );
  }

  // Proceed with initialization based on extension enabled state
  function proceedWithInit(isExtensionEnabled) {
    if (!isExtensionEnabled) {
      console.log('[SS:init] ❌ Extension disabled for this URL, skipping reading position tracking');
      return;
    }

    // YouTube channel pages — video-ID-only tracking (separate from articles)
    if (isYouTubeChannelPage()) {
      console.log('[SS:init] ✅ YouTube channel page detected, starting video-ID tracking');
      setupYouTubeTracking();
      return;
    }

    // Check if this page is worth tracking
    if (isArticlePage()) {
      console.log('[SS:init] ✅ Article detected immediately, starting tracking');
      setupTracking();
      return;
    }

    console.log('[SS:init] Not an article page yet, checking if SPA...');

    // For social media SPAs, retry detection
    if (isSocialMediaSPA()) {
      console.log('[SS:init] 🔍 Social media SPA detected, will retry article detection');
      retryDetection();
      return;
    }

    // For non-SPA pages, give up immediately
    console.log('[SS:init] ❌ Not an article page, skipping reading position tracking');
  }

  // Start the extension
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose debug functions to window for manual testing
  window.debugReadingPosition = {
    isArticlePage,
    isYouTubeChannelPage,
    isTrackingActive: () => isTrackingActive,
    isRestoring: () => isRestoring,
    currentUrl: () => currentUrl,
    retryCount: () => retryCount,
    getStorageKey,
    getYouTubeStorageKey,
    normalizeUrl,
    forceRetry: retryDetection,
    checkStorage: () => {
      if (!isExtensionValid()) {
        console.warn('[SS:debug] Extension context invalidated, cannot check storage');
        return;
      }
      const key = getStorageKey(currentUrl);
      const ytKey = getYouTubeStorageKey(currentUrl);
      chrome.storage.local.get([key, ytKey], (result) => {
        console.log('[SS:debug] Storage check for key', key, ':', result[key] ? 'FOUND' : 'NOT FOUND');
        if (result[key]) { console.log('[SS:debug] Position:', result[key]); }
        console.log('[SS:debug] YouTube storage check for key', ytKey, ':', result[ytKey] ? 'FOUND' : 'NOT FOUND');
        if (result[ytKey]) { console.log('[SS:debug] YouTube Position:', result[ytKey]); }
      });
    },
    forceRestore: () => {
      if (isYouTubeChannelPage()) {
        restoreYouTubePosition();
      } else {
        restoreScrollPosition();
      }
    },
    forceYouTubeRestore: restoreYouTubePosition,
    forceSave: () => {
      if (isYouTubeChannelPage()) return;
      const position = getScrollPosition();
      saveScrollPosition(position);
    }
  };

  console.log('[SS:init] 📖 Scroll Saver loaded. Debug: window.debugReadingPosition');

})();