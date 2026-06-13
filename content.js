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
  let restoreCompletedAt = 0;
  let lastSavedPosition = 0;
  let isTrackingActive = false;
  let retryCount = 0;
  const MAX_RETRIES = 10;
  const RETRY_DELAY_MS = 1000;
  const POST_RESTORE_COOLDOWN_MS = 10000;

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
  function saveScrollPosition(position) {
    // Don't save if we're at the very top (or minimal scroll)
    if (position.scrollY < 100 && position.scrollPercent < MIN_SCROLL_PERCENT) {
      console.log('Not saving - at top:', position.scrollY, 'px', position.scrollPercent.toFixed(1) + '%');
      return;
    }

    // Don't save if we've already saved this position recently
    if (Math.abs(position.scrollY - lastSavedPosition) < 50) {
      console.log('Not saving - similar to last saved:', position.scrollY, 'vs', lastSavedPosition);
      return;
    }

    // Check if extension context is still valid
    if (!isExtensionValid()) {
      console.warn('Extension context invalidated, skipping save');
      return;
    }

    const key = getStorageKey(currentUrl);
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

  // Clean up progressive scroll timer
  function cleanupProgressiveScroll() {
    if (progressiveScrollTimer) {
      clearTimeout(progressiveScrollTimer);
      progressiveScrollTimer = null;
    }
  }

  // Scroll to a position incrementally, triggering pagination along the way
  function progressiveScrollToPosition(targetScrollY, attempt) {
    attempt = attempt || 0;
    const MAX_ATTEMPTS = 40;
    const RETRY_DELAY = 1000;
    const container = getScrollContainer();
    const isCustomContainer = container && container !== document.body;

    if (attempt >= MAX_ATTEMPTS) {
      const currentY = isCustomContainer ? container.scrollTop : window.scrollY;
      console.log('Progressive scroll: max attempts reached at', currentY, 'target was', targetScrollY);
      cleanupProgressiveScroll();
      isRestoring = false;
      restoreCompletedAt = Date.now();
      return;
    }

    if (!isExtensionValid()) {
      cleanupProgressiveScroll();
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
      isRestoring = false;
      restoreCompletedAt = Date.now();
      return;
    }

    // Dispatch a scroll event on the right element to trigger lazy loading
    (isCustomContainer ? container : window).dispatchEvent(new Event('scroll', { bubbles: true }));

    // Wait for content to load, then try again
    progressiveScrollTimer = setTimeout(() => {
      progressiveScrollToPosition(targetScrollY, attempt + 1);
    }, RETRY_DELAY);
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

    const key = getStorageKey(targetUrl);
    console.log('Looking for storage key:', key);

    try {
      chrome.storage.local.get([key], (result) => {
        if (chrome.runtime.lastError) {
          console.error('Error restoring scroll position:', chrome.runtime.lastError);
          return;
        }

        console.log('Storage result for key', key, ':', result[key] ? 'FOUND' : 'NOT FOUND');
        const saved = result[key];
        if (!saved || !saved.scrollY) {
          console.log('No saved position found or invalid data');
          return;
        }

        // Don't restore if we're already scrolled past the saved position
        const container = getScrollContainer();
        const isCustomContainer = container && container !== document.body;
        const currentScroll = isCustomContainer ? container.scrollTop : window.scrollY;
        console.log('Current scroll:', currentScroll, 'Saved scroll:', saved.scrollY);
        if (currentScroll > saved.scrollY + 100) {
          console.log('Already scrolled past saved position, skipping restore');
          return;
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
          isRestoring = true;
          progressiveScrollToPosition(saved.scrollY);
        } else {
          isRestoring = true;
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

          // Wait for smooth scroll to actually complete before re-enabling saves
          let scrollSettleChecks = 0;
          const MAX_SCROLL_SETTLE_CHECKS = 75; // 15 seconds at 200ms intervals
          const checkScrollSettled = () => {
            const currentY = isCustomContainer ? container.scrollTop : window.scrollY;
            if (currentY >= Math.max(saved.scrollY - 50, 0) || scrollSettleChecks >= MAX_SCROLL_SETTLE_CHECKS) {
              isRestoring = false;
              restoreCompletedAt = Date.now();
              console.log('Restore completed, isRestoring reset to false, cooldown started');
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
    }
  }

  // Debounced scroll handler
  function handleScroll() {
    if (isRestoring) return;
    if (Date.now() - restoreCompletedAt < POST_RESTORE_COOLDOWN_MS) return;

    if (scrollTimeout) {
      clearTimeout(scrollTimeout);
    }

    scrollTimeout = setTimeout(() => {
      if (!isTrackingActive) return;
      if (isRestoring) return;
      if (Date.now() - restoreCompletedAt < POST_RESTORE_COOLDOWN_MS) return;

      const position = getScrollPosition();
      saveScrollPosition(position);
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

  // Handle URL changes (for SPAs)
  function observeUrlChanges() {
    let lastUrl = window.location.href;

    // Observe DOM mutations that might indicate route change
    const observer = new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        currentUrl = lastUrl;
        setTimeout(() => {
          if (isArticlePage() || isYouTubeChannelPage()) {
            restoreScrollPosition();
          }
        }, 1000); // Wait for new content to load
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
      originalPushState.apply(this, args);
      setTimeout(() => {
        if (window.location.href !== lastUrl) {
          lastUrl = window.location.href;
          currentUrl = lastUrl;
          if (isArticlePage() || isYouTubeChannelPage()) {
            restoreScrollPosition();
          }
        }
      }, 100);
    };

    history.replaceState = function(...args) {
      originalReplaceState.apply(this, args);
      setTimeout(() => {
        if (window.location.href !== lastUrl) {
          lastUrl = window.location.href;
          currentUrl = lastUrl;
          if (isArticlePage() || isYouTubeChannelPage()) {
            restoreScrollPosition();
          }
        }
      }, 100);
    };

    // Listen to popstate (back/forward navigation)
    window.addEventListener('popstate', () => {
      setTimeout(() => {
        if (window.location.href !== lastUrl) {
          lastUrl = window.location.href;
          currentUrl = lastUrl;
          if (isArticlePage() || isYouTubeChannelPage()) {
            restoreScrollPosition();
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
      if (document.visibilityState === 'hidden' && isTrackingActive && !isRestoring && Date.now() - restoreCompletedAt >= POST_RESTORE_COOLDOWN_MS) {
        console.log('Tab hidden, saving scroll position');
        saveScrollPosition(getScrollPosition());
      }
    });

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