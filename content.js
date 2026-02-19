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

  // Get current scroll position
  function getScrollPosition() {
    return {
      scrollY: window.scrollY,
      scrollPercent: (window.scrollY / (document.body.scrollHeight - window.innerHeight)) * 100,
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

  // Restore scroll position from storage
  function restoreScrollPosition() {
    console.log('🔄 restoreScrollPosition called, isRestoring:', isRestoring, 'isTrackingActive:', isTrackingActive);
    if (isRestoring) {
      console.log('Already restoring, skipping');
      return;
    }

    // Check if extension context is still valid
    if (!isExtensionValid()) {
      console.warn('Extension context invalidated, skipping restore');
      return;
    }

    const key = getStorageKey(currentUrl);
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
        const currentScroll = window.scrollY;
        console.log('Current scroll:', currentScroll, 'Saved scroll:', saved.scrollY);
        if (currentScroll > saved.scrollY + 100) {
          console.log('Already scrolled past saved position, skipping restore');
          return;
        }

        console.log('✅ Restoring to saved position:', saved.scrollY, 'px', saved.scrollPercent.toFixed(1) + '%', 'saved at:', new Date(saved.timestamp).toLocaleTimeString());

        isRestoring = true;
        window.scrollTo({
          top: saved.scrollY,
          behavior: 'smooth'
        });

        // Reset restoring flag after scroll completes
        setTimeout(() => {
          isRestoring = false;
          console.log('Restore completed, isRestoring reset to false');
        }, 500);
      });
    } catch (error) {
      console.error('Failed to restore scroll position:', error);
    }
  }

  // Debounced scroll handler
  function handleScroll() {
    if (isRestoring) return;

    if (scrollTimeout) {
      clearTimeout(scrollTimeout);
    }

    scrollTimeout = setTimeout(() => {
      if (!isTrackingActive) return;

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
          if (isArticlePage()) {
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
          if (isArticlePage()) {
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
          if (isArticlePage()) {
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
          if (isArticlePage()) {
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

    // Set up scroll listener
    window.addEventListener('scroll', handleScroll, { passive: true });

    // Save position before page unload
    window.addEventListener('beforeunload', handlePageUnload);
    window.addEventListener('pagehide', handlePageUnload);

    // Restore position on load (after a delay to allow content to render)
    window.addEventListener('load', () => {
      setTimeout(restoreScrollPosition, 500);
    });

    // Also try to restore on DOMContentLoaded (for faster pages)
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(restoreScrollPosition, 300);
      });
    } else {
      setTimeout(restoreScrollPosition, 300);
    }

    // Set up URL change observer for SPAs
    observeUrlChanges();
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

    // First check if extension is enabled for this URL
    chrome.runtime.sendMessage(
      { action: 'get_extension_enabled', url: window.location.href },
      function(response) {
        if (chrome.runtime.lastError) {
          console.error('Error checking extension enabled state:', chrome.runtime.lastError);
          // Default to disabled if error
          proceedWithInit(false);
        } else {
          const isEnabled = response.enabled === true; // default to false if undefined
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