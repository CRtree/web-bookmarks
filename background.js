// Scroll Saver - Background Service Worker
console.log('Background script loading...');

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

// Clean up old entries (older than 30 days)
function cleanupOldEntries() {
  // Check if storage API is available
  if (!chrome.storage || !chrome.storage.local) {
    console.warn('chrome.storage.local not available, skipping cleanup');
    return;
  }

  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  chrome.storage.local.get(null, (items) => {
    if (chrome.runtime.lastError) {
      console.error('Error cleaning up old entries:', chrome.runtime.lastError);
      return;
    }

    const now = Date.now();
    const toRemove = [];

    for (const [key, value] of Object.entries(items)) {
      if (key.startsWith('reading_position_')) {
        if (value.timestamp && now - value.timestamp > THIRTY_DAYS_MS) {
          toRemove.push(key);
        }
      }
    }

    if (toRemove.length > 0) {
      chrome.storage.local.remove(toRemove, () => {
        console.log(`Cleaned up ${toRemove.length} old reading positions`);
      });
    }
  });
}

// Handle messages from popup or content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Background: Received message:', request.action);

  if (request.action === 'ping') {
    console.log('Background: Ping received, responding...');
    sendResponse({ status: 'ok', timestamp: Date.now() });
    return true;
  }

  if (request.action === 'get_positions') {
    // Get all saved positions
    if (!chrome.storage || !chrome.storage.local) {
      console.error('chrome.storage.local not available');
      sendResponse({ positions: {} });
      return true;
    }
    console.log('get_positions: fetching all positions');
    chrome.storage.local.get(null, (items) => {
      console.log('get_positions: total storage items:', Object.keys(items).length);
      const positions = {};
      for (const [key, value] of Object.entries(items)) {
        if (key.startsWith('reading_position_')) {
          positions[key.replace('reading_position_', '')] = value;
        }
      }
      console.log('get_positions: reading positions found:', Object.keys(positions).length);
      sendResponse({ positions });
    });
    return true; // Will respond asynchronously
  }

  if (request.action === 'clear_position') {
    if (!chrome.storage || !chrome.storage.local) {
      console.error('chrome.storage.local not available');
      sendResponse({ success: false, error: 'Storage not available' });
      return true;
    }
    const { url } = request;
    const normalizedUrl = normalizeUrl(url);
    const key = `reading_position_${normalizedUrl}`;
    console.log('clear_position:', { url, normalizedUrl, key });
    chrome.storage.local.remove(key, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.action === 'clear_all') {
    if (!chrome.storage || !chrome.storage.local) {
      console.error('chrome.storage.local not available');
      sendResponse({ success: false, error: 'Storage not available' });
      return true;
    }

    try {
      chrome.storage.local.get(null, (items) => {
        if (chrome.runtime.lastError) {
          console.error('Error getting storage items:', chrome.runtime.lastError);
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
          return;
        }

        const toRemove = [];
        for (const key of Object.keys(items)) {
          if (key.startsWith('reading_position_')) {
            toRemove.push(key);
          }
        }

        if (toRemove.length === 0) {
          sendResponse({ success: true, count: 0 });
          return;
        }

        chrome.storage.local.remove(toRemove, () => {
          if (chrome.runtime.lastError) {
            console.error('Error removing storage items:', chrome.runtime.lastError);
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          sendResponse({ success: true, count: toRemove.length });
        });
      });
    } catch (error) {
      console.error('Unexpected error in clear_all:', error);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }

  if (request.action === 'get_current_tab_position') {
    // Get position for current active tab
    if (!chrome.tabs) {
      console.error('chrome.tabs API not available');
      sendResponse({ error: 'Tabs API not available' });
      return true;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) {
        sendResponse({ error: 'No active tab' });
        return;
      }
      const url = tabs[0].url;
      const normalizedUrl = normalizeUrl(url);
      const key = `reading_position_${normalizedUrl}`;
      console.log('get_current_tab_position:', { url, normalizedUrl, key });
      if (!chrome.storage || !chrome.storage.local) {
        console.error('chrome.storage.local not available');
        sendResponse({ error: 'Storage not available' });
        return;
      }
      chrome.storage.local.get([key], (result) => {
        console.log('get_current_tab_position result:', result[key] ? 'FOUND' : 'NOT FOUND');
        sendResponse({ position: result[key] });
      });
    });
    return true;
  }

  if (request.action === 'get_extension_enabled') {
    // Check if extension is enabled for a URL
    const { url } = request;
    const normalizedUrl = normalizeUrl(url);
    console.log('get_extension_enabled:', { url, normalizedUrl });

    if (!chrome.storage || !chrome.storage.local) {
      console.error('chrome.storage.local not available');
      sendResponse({ enabled: false }); // Default to disabled if storage not available
      return true;
    }

    chrome.storage.local.get(['enabled_sites'], (result) => {
      const enabledSites = result.enabled_sites || {};
      const isEnabled = !!enabledSites[normalizedUrl];
      console.log('get_extension_enabled result:', { isEnabled, enabled: !!enabledSites[normalizedUrl] });
      sendResponse({ enabled: isEnabled });
    });
    return true;
  }

  if (request.action === 'set_extension_enabled') {
    // Set extension enabled/disabled for a URL
    const { url, enabled } = request;
    const normalizedUrl = normalizeUrl(url);
    console.log('set_extension_enabled:', { url, normalizedUrl, enabled });

    if (!chrome.storage || !chrome.storage.local) {
      console.error('chrome.storage.local not available');
      sendResponse({ success: false, error: 'Storage not available' });
      return true;
    }

    chrome.storage.local.get(['enabled_sites'], (result) => {
      const enabledSites = result.enabled_sites || {};

      if (enabled) {
        enabledSites[normalizedUrl] = true;
      } else {
        delete enabledSites[normalizedUrl];
      }

      chrome.storage.local.set({ enabled_sites: enabledSites }, () => {
        console.log('set_extension_enabled: updated enabled_sites, count:', Object.keys(enabledSites).length);
        sendResponse({ success: true });
      });
    });
    return true;
  }
});

// Clean up old entries on install/startup
chrome.runtime.onInstalled.addListener(() => {
  console.log('Scroll Saver installed');
  cleanupOldEntries();
  migrateToEnabledSites();
});

function migrateToEnabledSites() {
  chrome.storage.local.get(null, (items) => {
    if (chrome.runtime.lastError) {
      console.error('Migration error:', chrome.runtime.lastError);
      return;
    }

    const enabledSites = items.enabled_sites || {};
    let migrated = 0;

    for (const key of Object.keys(items)) {
      if (key.startsWith('reading_position_')) {
        const normalizedUrl = key.slice('reading_position_'.length);
        if (!enabledSites[normalizedUrl]) {
          enabledSites[normalizedUrl] = true;
          migrated++;
        }
      }
    }

    if (migrated > 0) {
      chrome.storage.local.set({ enabled_sites: enabledSites }, () => {
        console.log(`Migration: added ${migrated} sites to enabled_sites`);
      });
    } else {
      console.log('Migration: no new sites to migrate');
    }
  });
}

// Clean up weekly
if (chrome.alarms) {
  chrome.alarms.create('cleanup', { periodInMinutes: 60 * 24 * 7 }); // weekly
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'cleanup') {
      cleanupOldEntries();
    }
  });
} else {
  console.warn('chrome.alarms API not available, skipping alarm creation');
}

// Initialize alarm on startup
chrome.runtime.onStartup.addListener(() => {
  console.log('Scroll Saver background script starting up');
  cleanupOldEntries();
});