// Scroll Saver - Content Script

(function() {
  'use strict';

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
  const CLICK_SAVE_PROTECT_MS = 500;
  let lastClickSaveUrl = null;
  let lastClickSaveExpiry = 0;
  let lastProgressiveHeight = 0;
  let progressiveStallCount = 0;
  let restoreCompletedAt = 0;
  const POST_RESTORE_COOLDOWN_MS = 3000;
  let clickListenerAttached = false;
  // Dedupe pointerdown + click firing for the same video link in quick succession.
  let lastHandledVideoHref = null;
  let lastHandledVideoTime = 0;

  // Progressive scroll state (for infinite-scroll / paginated pages)
  let progressiveScrollTimer = null;

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
      console.warn('URL normalization failed, using original:', url, e);
      return url;
    }
  }

  // Check if extension context is still valid
  function isExtensionValid() {
    // Check if runtime is still available
    if (!chrome.runtime || !chrome.runtime.id) {
      console.warn('Extension context invalidated - runtime not available');
      return false;
    }

    // Check if storage API is available
    if (!chrome.storage || !chrome.storage.local) {
      console.warn('Extension context invalidated - storage not available');
      return false;
    }

    return true;
  }

  // Generate storage key for current URL
  function getStorageKey(url) {
    const normalizedUrl = normalizeUrl(url);
    return `reading_position_${normalizedUrl}`;
  }

  // Secondary key holding the last clicked videoId for a channel URL. Kept
  // separate from the primary reading_position_ key so scroll saves can't
  // overwrite the videoId, and so it never shows up as a bookmark in the popup.
  function getClickVideoKey(url) {
    const normalizedUrl = normalizeUrl(url);
    return `click_video_${normalizedUrl}`;
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
      console.log('Not saving - at top:', position.scrollY, 'px', position.scrollPercent.toFixed(1) + '%');
      return;
    }

    // Don't save if we've already saved this position recently
    if (!force && Math.abs(position.scrollY - lastSavedPosition) < 50) {
      console.log('Not saving - similar to last saved:', position.scrollY, 'vs', lastSavedPosition);
      return;
    }

    // Check if extension context is still valid
    if (!isExtensionValid()) {
      console.warn('Extension context invalidated, skipping save');
      return;
    }

    const url = urlOverride || currentUrl;
    const key = getStorageKey(url);
    position.url = url; // Ensure position URL matches the storage key
    console.log('Saving to storage key:', key);

    try {
      chrome.storage.local.set({ [key]: position }, () => {
        if (chrome.runtime.lastError) {
          console.error('Error saving scroll position:', chrome.runtime.lastError);
        } else {
          lastSavedPosition = position.scrollY;
          console.log('✅ Saved scroll position:', position.scrollY, 'px', position.scrollPercent.toFixed(1) + '%', 'for:', document.title);
        }
      });
    } catch (error) {
      console.error('Failed to save scroll position:', error);
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

  // After position-based restore, try to scroll the exact saved video into view.
  function refineRestoreToVideo(saved, attempt) {
    attempt = attempt || 0;
    const MAX_REFINE_ATTEMPTS = 5;

    if (!saved || !saved.videoId) {
      console.log('No videoId stored, skipping refinement');
      return;
    }

    console.log('🔍 Refining restore to video:', saved.videoId, 'attempt', attempt + 1, '/', MAX_REFINE_ATTEMPTS);

    const links = querySelectorAllDeep(`a[href*="/watch?v=${saved.videoId}"]`);
    if (!links.length) {
      if (attempt < MAX_REFINE_ATTEMPTS - 1) {
        console.log('Video not found yet, retrying in 1s...');
        setTimeout(() => refineRestoreToVideo(saved, attempt + 1), 1000);
      } else {
        console.log('Video not found on page, keeping position-based restore');
      }
      return;
    }

    const link = links[0];
    const videoContainer = findVideoContainer(link);
    const rect = videoContainer.getBoundingClientRect();
    const targetScrollY = Math.max(0, window.scrollY + rect.top - 120);

    window.scrollTo({ top: targetScrollY, behavior: 'instant' });
    console.log('✅ Refined restore to video', saved.videoId, 'at scrollY:', targetScrollY,
      '(container top:', rect.top, ', current scroll:', window.scrollY, ')');
  }

  // Clean up progressive scroll timer
  function cleanupProgressiveScroll() {
    if (progressiveScrollTimer) {
      clearTimeout(progressiveScrollTimer);
      progressiveScrollTimer = null;
    }
    lastProgressiveHeight = 0;
    progressiveStallCount = 0;
  }

  // Scroll to a position incrementally, triggering pagination along the way
  function progressiveScrollToPosition(targetScrollY, attempt, saved) {
    attempt = attempt || 0;
    const MAX_ATTEMPTS = 120;
    const RETRY_DELAY = 1000;
    const container = getScrollContainer();
    const isCustomContainer = container && container !== document.body;

    if (attempt >= MAX_ATTEMPTS) {
      const currentY = isCustomContainer ? container.scrollTop : window.scrollY;
      console.log('Progressive scroll: max attempts reached at', currentY, 'target was', targetScrollY);
      cleanupProgressiveScroll();
      finishRestore();
      refineRestoreToVideo(saved);
      return;
    }

    if (!isExtensionValid()) {
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
    console.log('Progressive scroll attempt', attempt + 1, '/', MAX_ATTEMPTS,
      'scrolled to', currentY, 'target', targetScrollY,
      'page height', containerHeight);

    if (currentY >= targetScrollY - 100) {
      console.log('Progressive scroll: reached target at', currentY);
      cleanupProgressiveScroll();
      finishRestore();
      refineRestoreToVideo(saved);
      return;
    }

    // Detect stalled page growth. YouTube's infinite scroll sometimes ignores
    // synthetic scroll events; a small "wiggle" up and back down often triggers it.
    if (effectiveHeight === lastProgressiveHeight) {
      progressiveStallCount++;
    } else {
      lastProgressiveHeight = effectiveHeight;
      progressiveStallCount = 0;
    }

    if (progressiveStallCount >= 3) {
      console.log('Progressive scroll: height stalled at', containerHeight,
        'for', progressiveStallCount, 'attempts, wiggling to trigger lazy load');
      const wiggleUp = Math.max(0, currentY - 300);
      if (isCustomContainer) {
        container.scrollTo({ top: wiggleUp, behavior: 'instant' });
      } else {
        window.scrollTo({ top: wiggleUp, behavior: 'instant' });
      }
      // Scroll back down immediately so the next iteration doesn't lose progress.
      (isCustomContainer ? container : window).dispatchEvent(new Event('scroll', { bubbles: true }));
      setTimeout(() => {
        if (isCustomContainer) {
          container.scrollTo({ top: scrollTarget, behavior: 'instant' });
        } else {
          window.scrollTo({ top: scrollTarget, behavior: 'instant' });
        }
        (isCustomContainer ? container : window).dispatchEvent(new Event('scroll', { bubbles: true }));
      }, 150);
      // Reset stall count so we don't wiggle every single attempt.
      progressiveStallCount = 0;
    }

    // Dispatch a scroll event on the right element to trigger lazy loading
    (isCustomContainer ? container : window).dispatchEvent(new Event('scroll', { bubbles: true }));

    // Wait for content to load, then try again
    progressiveScrollTimer = setTimeout(() => {
      progressiveScrollToPosition(targetScrollY, attempt + 1, saved);
    }, RETRY_DELAY);
  }

  // Reset isRestoring (centralized for all restore exit paths)
  function finishRestore() {
    isRestoring = false;
    restoreCompletedAt = Date.now();
    console.log('Restore completed, isRestoring reset to false, 3s stability cooldown started');
  }

  // Restore scroll position from storage
  // urlOverride: skip the mutable global currentUrl — use this URL for storage key lookup
  function restoreScrollPosition(urlOverride) {
    const targetUrl = urlOverride || currentUrl;
    console.log('🔄 restoreScrollPosition called, url:', targetUrl, 'isRestoring:', isRestoring);
    if (isRestoring) {
      console.log('Already restoring, skipping');
      return;
    }

    // Check if extension context is still valid
    if (!isExtensionValid()) {
      console.warn('Extension context invalidated, skipping restore');
      return;
    }

    // Set isRestoring synchronously BEFORE any async work so concurrent calls
    // are blocked immediately. Previously it was set inside the async callback,
    // allowing multiple restoreScrollPosition calls to race through.
    isRestoring = true;
    cleanupProgressiveScroll(); // abort any stale progressive scroll before starting

    const key = getStorageKey(targetUrl);
    const clickKey = getClickVideoKey(targetUrl);
    console.log('Looking for storage key:', key);

    try {
      chrome.storage.local.get([key, clickKey], (result) => {
        if (chrome.runtime.lastError) {
          console.error('Error restoring scroll position:', chrome.runtime.lastError);
          finishRestore();
          return;
        }

        console.log('Storage result for key', key, ':', result[key] ? 'FOUND' : 'NOT FOUND');
        const saved = result[key];
        if (!saved || !saved.scrollY) {
          console.log('No saved position found or invalid data');
          finishRestore();
          return;
        }

        // Scroll saves fired during back-navigation re-render can strip the
        // videoId from the primary save. Recover it from the secondary key ONLY
        // when the saved position still matches the click-saved position — i.e.
        // the primary save really is that click, just missing its videoId. If the
        // user has since scrolled to a different spot (a genuine scroll save far
        // from the clicked video), we must NOT attach the stale videoId, or
        // refineRestoreToVideo would yank them back to an old video.
        const CLICK_VIDEO_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
        const CLICK_VIDEO_POS_TOLERANCE = 2000; // px; distinguishes re-render jitter from a real scroll-away
        const clickSave = result[clickKey];
        if (!saved.videoId && clickSave && clickSave.videoId &&
            (Date.now() - clickSave.timestamp < CLICK_VIDEO_MAX_AGE_MS) &&
            Math.abs(saved.scrollY - clickSave.scrollY) < CLICK_VIDEO_POS_TOLERANCE) {
          saved.videoId = clickSave.videoId;
          console.log('♻️ Recovered clicked videoId from secondary key:', saved.videoId);
        } else if (!saved.videoId && clickSave && clickSave.videoId) {
          console.log('Skipping stale click videoId — saved position',
            saved.scrollY, 'differs from click position', clickSave.scrollY);
        }

        // Determine current scroll relative to the saved position. On YouTube
        // back-navigation the page frequently loads a few hundred px BELOW the
        // saved position due to content re-rendering / layout shift. Previously
        // we skipped the restore entirely in that case, leaving the user past
        // the clicked video. Instead, scroll back UP to the saved position.
        const container = getScrollContainer();
        const isCustomContainer = container && container !== document.body;
        const currentScroll = isCustomContainer ? container.scrollTop : window.scrollY;
        console.log('Current scroll:', currentScroll, 'Saved scroll:', saved.scrollY);
        const startedAbove = currentScroll > saved.scrollY + 50;
        if (startedAbove) {
          console.log('Scrolled past saved position, scrolling up to restore');
        }

        console.log('✅ Restoring to saved position:', saved.scrollY, 'px', saved.scrollPercent.toFixed(1) + '%', 'saved at:', new Date(saved.timestamp).toLocaleTimeString());

        const effectiveHeight = isCustomContainer
          ? container.scrollHeight
          : Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        const maxScroll = effectiveHeight - (isCustomContainer ? container.clientHeight : window.innerHeight);
        const containerHeight = effectiveHeight;

        // Use progressive scroll for paginated/infinite-scroll pages
        // where the saved position is significantly beyond the current page height
        if (saved.scrollY > maxScroll + 500) {
          console.log('📜 Using progressive scroll — target', saved.scrollY, 'beyond current height', containerHeight);
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
              refineRestoreToVideo(saved);
              return;
            }
            scrollSettleChecks++;
            setTimeout(checkScrollSettled, 200);
          };
          setTimeout(checkScrollSettled, 500);
        }
      });
    } catch (error) {
      console.error('Failed to restore scroll position:', error);
      finishRestore();
    }
  }

  // Debounced scroll handler
  function handleScroll() {
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
    console.log('📝 Page unload event fired, isTrackingActive:', isTrackingActive);
    if (!isTrackingActive) {
      console.log('Not tracking active, skipping save on unload');
      return;
    }

    console.log('Saving final position on page unload');
    const position = getScrollPosition();
    saveScrollPosition(position);
  }

  // Save position immediately when a video is clicked on a YouTube channel page.
  // Uses capture phase so we run BEFORE YouTube's click handler SPA-navigates away.
  function handleVideoClick(event) {
    if (!isYouTubeChannelPage()) {
      console.log('CLICK: ignored - not a YouTube channel page');
      return;
    }

    // Ignore non-primary buttons (middle/right). For keyboard-activated clicks
    // event.button is 0, so those still pass.
    if (typeof event.button === 'number' && event.button !== 0) {
      return;
    }

    const link = event.target.closest('a');
    if (!link) {
      console.log('CLICK: ignored - no <a> ancestor');
      return;
    }

    const href = link.getAttribute('href');

    // YouTube begins SPA navigation on pointerdown/mousedown (before the click
    // event), so we intercept those too. Dedupe so the follow-up click for the
    // same link doesn't re-run the whole save.
    if (href && href === lastHandledVideoHref && Date.now() - lastHandledVideoTime < 1500) {
      return;
    }

    console.log('CLICK: detected link href:', href, '(' + event.type + ')');

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
      console.log('CLICK: ignored - not a /watch?v= link');
      return;
    }

    // Mark this link as handled so the follow-up pointerup/click doesn't re-run.
    lastHandledVideoHref = href;
    lastHandledVideoTime = Date.now();

    // Extract the video ID so we can refine the restore later.
    const videoIdMatch = href.match(/[?&]v=([^&]+)/);
    const videoId = videoIdMatch ? videoIdMatch[1] : null;

    // Find the video card container by walking up from the clicked link.
    // Use findVideoContainer which starts at the link itself — unlike
    // composedPath().find(), it never picks a far-ancestor ytd-rich-item-renderer
    // like the channel header.
    const videoContainer = findVideoContainer(link);

    const rect = videoContainer.getBoundingClientRect();
    const videoTop = rect.top + window.scrollY;
    const viewportTopMargin = 120; // leave space above the video when restored
    const targetScrollY = Math.max(0, videoTop - viewportTopMargin);

    const docHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.offsetHeight
    );
    const maxScroll = Math.max(0, docHeight - window.innerHeight);
    const targetScrollPercent = maxScroll > 0
      ? Math.min(100, Math.max(0, (targetScrollY / maxScroll) * 100))
      : 0;

    console.log('🎬 Video link clicked:', href);
    console.log('Saving channel scroll position aligned to clicked video top:', targetScrollY,
      '(video top:', videoTop, ', margin:', viewportTopMargin, ')');

    // Cancel any pending debounced scroll save so it can't overwrite this click save
    // after we navigate to the video page.
    if (scrollTimeout) {
      clearTimeout(scrollTimeout);
      scrollTimeout = null;
      console.log('Cancelled pending scroll debounce');
    }

    saveScrollPosition({
      scrollY: targetScrollY,
      scrollPercent: targetScrollPercent,
      timestamp: Date.now(),
      url: currentUrl,
      title: document.title,
      videoId: videoId
    }, currentUrl, true);

    // Persist the clicked videoId under a SEPARATE key so that scroll-save
    // events fired during back-navigation re-render (which carry no videoId)
    // can't overwrite it in the primary key. restoreScrollPosition reads this
    // back so refineRestoreToVideo can always re-align to the clicked video.
    if (videoId && isExtensionValid()) {
      const clickKey = getClickVideoKey(currentUrl);
      try {
        chrome.storage.local.set({
          [clickKey]: { videoId: videoId, scrollY: targetScrollY, timestamp: Date.now() }
        });
      } catch (error) {
        console.error('Failed to save clicked videoId:', error);
      }
    }

    // Mark this URL as recently click-saved so pushState/replaceState don't
    // overwrite it while scroll momentum is still moving the page.
    lastClickSaveUrl = currentUrl;
    lastClickSaveExpiry = Date.now() + CLICK_SAVE_PROTECT_MS;
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
        console.log('🖱️ Click interception attached for YouTube channel page');
      }
    } else {
      if (clickListenerAttached) {
        document.removeEventListener('pointerdown', handleVideoClick, true);
        document.removeEventListener('click', handleVideoClick, true);
        clickListenerAttached = false;
        console.log('🖱️ Click interception removed (not a YouTube channel page)');
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
          if (isArticlePage() || isYouTubeChannelPage()) {
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
      // Cancel any pending debounced scroll save before navigating away.
      if (scrollTimeout) {
        clearTimeout(scrollTimeout);
        scrollTimeout = null;
      }

      // If a click save just happened for this URL, don't overwrite it while
      // scroll momentum is still moving the page.
      const recentlyClickSaved = currentUrl === lastClickSaveUrl && Date.now() < lastClickSaveExpiry;
      if (recentlyClickSaved) {
        console.log('pushState save skipped: protected by recent click save');
      }

      // Save current position for the URL we are LEAVING before the URL changes.
      // (visibilitychange does NOT fire during SPA navigation — the tab stays visible.)
      if (isTrackingActive && !isRestoring && !recentlyClickSaved) {
        const position = getScrollPosition();
        saveScrollPosition(position, currentUrl);
      }

      originalPushState.apply(this, args);
      setTimeout(() => {
        if (window.location.href !== lastUrl) {
          lastUrl = window.location.href;
          currentUrl = lastUrl;
          ensureClickListener();
          if (isArticlePage() || isYouTubeChannelPage()) {
            const ytChannel = isYouTubeChannelPage();
            const restoreDelay = ytChannel ? 2500 : 500;
            setTimeout(() => restoreScrollPosition(), restoreDelay);
          }
        }
      }, 100);
    };

    history.replaceState = function(...args) {
      // Cancel any pending debounced scroll save before navigating away.
      if (scrollTimeout) {
        clearTimeout(scrollTimeout);
        scrollTimeout = null;
      }

      // If a click save just happened for this URL, don't overwrite it while
      // scroll momentum is still moving the page.
      const recentlyClickSaved = currentUrl === lastClickSaveUrl && Date.now() < lastClickSaveExpiry;
      if (recentlyClickSaved) {
        console.log('replaceState save skipped: protected by recent click save');
      }

      // Save current position for the URL we are LEAVING before the URL changes.
      if (isTrackingActive && !isRestoring && !recentlyClickSaved) {
        const position = getScrollPosition();
        saveScrollPosition(position, currentUrl);
      }

      originalReplaceState.apply(this, args);
      setTimeout(() => {
        if (window.location.href !== lastUrl) {
          lastUrl = window.location.href;
          currentUrl = lastUrl;
          ensureClickListener();
          if (isArticlePage() || isYouTubeChannelPage()) {
            const ytChannel = isYouTubeChannelPage();
            const restoreDelay = ytChannel ? 2500 : 500;
            setTimeout(() => restoreScrollPosition(), restoreDelay);
          }
        }
      }, 100);
    };

    // Listen to popstate (back/forward navigation)
    window.addEventListener('popstate', () => {
      // Cancel any pending debounced scroll save before navigating away.
      if (scrollTimeout) {
        clearTimeout(scrollTimeout);
        scrollTimeout = null;
      }

      // If a click save just happened for this URL, don't overwrite it while
      // scroll momentum is still moving the page.
      const recentlyClickSaved = currentUrl === lastClickSaveUrl && Date.now() < lastClickSaveExpiry;
      if (recentlyClickSaved) {
        console.log('popstate save skipped: protected by recent click save');
      }

      // Save the position for the page we are LEAVING.
      // popstate fires AFTER the URL has changed, but currentUrl still
      // holds the URL of the page we're navigating away from.
      if (isTrackingActive && !isRestoring && !recentlyClickSaved) {
        const position = getScrollPosition();
        saveScrollPosition(position, currentUrl);
      }

      setTimeout(() => {
        if (window.location.href !== lastUrl) {
          lastUrl = window.location.href;
          currentUrl = lastUrl;
          ensureClickListener();
          if (isArticlePage() || isYouTubeChannelPage()) {
            const ytChannel = isYouTubeChannelPage();
            const restoreDelay = ytChannel ? 2500 : 500;
            setTimeout(() => restoreScrollPosition(), restoreDelay);
          }
        }
      }, 100);
    });
  }

  // Set up tracking once article is detected
  function setupTracking() {
    if (isTrackingActive) return;
    isTrackingActive = true;

    console.log('Scroll Saver active for:', document.title);

    // Set up scroll listener on both window and YouTube's container
    window.addEventListener('scroll', handleScroll, { passive: true });
    const container = getScrollContainer();
    if (container && container !== document.body) {
      container.addEventListener('scroll', handleScroll, { passive: true });
      console.log('Scroll Saver: also listening on custom container:', container.tagName);
    }

    // Save position before page unload
    window.addEventListener('beforeunload', handlePageUnload);
    window.addEventListener('pagehide', handlePageUnload);

    // Save position on tab switch / app minimize
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && isTrackingActive && !isRestoring
          && Date.now() - restoreCompletedAt >= POST_RESTORE_COOLDOWN_MS) {
        console.log('Tab hidden, saving scroll position');
        saveScrollPosition(getScrollPosition());
      }
    });

    // Manage click-to-save listener: attach only on YouTube channel pages.
    ensureClickListener();

    // Capture currentUrl NOW so YouTube SPA URL changes after scheduling
    // won't cause the storage key to mismatch the saved position.
    const urlAtTrackStart = currentUrl;
    const ytChannel = isYouTubeChannelPage();

    // Restore position on load (after a delay to allow content to render)
    window.addEventListener('load', () => {
      setTimeout(() => restoreScrollPosition(urlAtTrackStart), 500);
    });

    // Also try to restore on DOMContentLoaded (for faster pages)
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => restoreScrollPosition(urlAtTrackStart), 300);
      });
    } else {
      // For pages that already loaded (common at document_idle):
      // YouTube channel pages need more time — their video grid
      // loads asynchronously via API calls after the page shell renders.
      const delay = ytChannel ? 3000 : 300;
      console.log('Scheduling restoreScrollPosition in', delay, 'ms, url:', urlAtTrackStart);
      setTimeout(() => restoreScrollPosition(urlAtTrackStart), delay);
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

  // Retry detection for SPAs
  function retryDetection() {
    if (isTrackingActive || retryCount >= MAX_RETRIES) return;

    retryCount++;
    console.log(`Retry ${retryCount}/${MAX_RETRIES} for article detection...`);

    if (isArticlePage()) {
      console.log('Article detected on retry, starting tracking');
      setupTracking();
    } else {
      // Schedule next retry
      setTimeout(retryDetection, RETRY_DELAY_MS);
    }
  }

  // Initialize with retry logic for SPAs
  function init() {
    console.log('🚀 Extension init called, document.readyState:', document.readyState, 'URL:', window.location.href);

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
          console.error('Error checking extension enabled state:', chrome.runtime.lastError);
          // Default to disabled if error
          proceedWithInit(false);
        } else {
          const isEnabled = response.enabled === true; // default to disabled if undefined
          console.log('Extension enabled state for this URL:', isEnabled);
          proceedWithInit(isEnabled);
        }
      }
    );
  }

  // Proceed with initialization based on extension enabled state
  function proceedWithInit(isExtensionEnabled) {
    if (!isExtensionEnabled) {
      console.log('❌ Extension disabled for this URL, skipping reading position tracking');
      return;
    }

    // Check if this page is worth tracking
    if (isArticlePage()) {
      console.log('✅ Article detected immediately, starting tracking');
      setupTracking();
      return;
    }

    console.log('Not an article page yet, checking if SPA...');

    // For social media SPAs, retry detection
    if (isSocialMediaSPA()) {
      console.log('🔍 Social media SPA detected, will retry article detection');
      retryDetection();
      return;
    }

    // For YouTube channel pages, start tracking immediately
    if (isYouTubeChannelPage()) {
      console.log('✅ YouTube channel page detected, starting tracking');
      setupTracking();
      return;
    }

    // For non-SPA pages, give up immediately
    console.log('❌ Not an article page, skipping reading position tracking');
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
    normalizeUrl,
    forceRetry: retryDetection,
    checkStorage: () => {
      if (!isExtensionValid()) {
        console.warn('Extension context invalidated, cannot check storage');
        return;
      }
      const key = getStorageKey(currentUrl);
      chrome.storage.local.get([key], (result) => {
        console.log('Storage check for key', key, ':', result[key] ? 'FOUND' : 'NOT FOUND');
        if (result[key]) {
          console.log('Position:', result[key]);
        }
      });
    },
    forceRestore: restoreScrollPosition,
    forceSave: () => {
      const position = getScrollPosition();
      saveScrollPosition(position);
    }
  };

  console.log('📖 Scroll Saver loaded. Debug: window.debugReadingPosition');

})();