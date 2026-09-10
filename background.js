// Scroll Saver - Background Service Worker

// Log buffer for collecting logs from all contexts
const logBuffer = [];
const MAX_LOG_ENTRIES = 5000;

const _bgOriginalConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console)
};

function addLogEntry(level, message, source, url) {
  const entry = {
    timestamp: Date.now(),
    source: source || 'background',
    level: level,
    message: typeof message === 'string' ? message : JSON.stringify(message)
  };
  if (url) entry.url = url;
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_ENTRIES) {
    logBuffer.shift();
  }
}

console.log = function(...args) {
  _bgOriginalConsole.log(...args);
  addLogEntry('log', args.join(' '));
};
console.error = function(...args) {
  _bgOriginalConsole.error(...args);
  addLogEntry('error', args.join(' '));
};
console.warn = function(...args) {
  _bgOriginalConsole.warn(...args);
  addLogEntry('warn', args.join(' '));
};

console.log('Background script loading...');

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
    console.warn('URL normalization failed, using original:', url, e);
    return url;
  }
}

// Extract the channel root URL for any YouTube channel page (e.g. /@handle,
// /@handle/videos, /@handle/shorts). Returns null for non-channel URLs.
// This lets a channel be enabled once and apply to every tab under it.
function getChannelRootUrl(url) {
  try {
    const urlObj = new URL(url);
    if (urlObj.hostname.includes('youtube.com') || urlObj.hostname.includes('youtu.be')) {
      const match = urlObj.pathname.match(/^(\/@[^/]+)/);
      if (match) {
        return urlObj.origin + match[1];
      }
    }
  } catch (e) {}
  return null;
}

// The storage key used for enablement. Channel pages are enabled at their
// channel root so a single add covers /videos, /shorts, and all other tabs.
function getEnabledUrl(url) {
  const root = getChannelRootUrl(url);
  return root || normalizeUrl(url);
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
      if (key.startsWith('yt_position_')) {
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
        if (key.startsWith('yt_position_')) {
          const urlKey = key.replace('yt_position_', '');
          positions[urlKey] = value;
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
    const ytKey = `yt_position_${normalizedUrl}`;
    console.log('clear_position:', { url, normalizedUrl, ytKey });
    chrome.storage.local.remove([ytKey], () => {
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
          if (key.startsWith('yt_position_')) {
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
      const ytKey = `yt_position_${normalizedUrl}`;
      console.log('get_current_tab_position:', { url, normalizedUrl, ytKey });
      if (!chrome.storage || !chrome.storage.local) {
        console.error('chrome.storage.local not available');
        sendResponse({ error: 'Storage not available' });
        return;
      }
      chrome.storage.local.get([ytKey], (result) => {
        console.log('get_current_tab_position result:', result[ytKey] ? 'FOUND_YT' : 'NOT FOUND');
        sendResponse({ position: result[ytKey] || null });
      });
    });
    return true;
  }

  if (request.action === 'get_extension_enabled') {
    // Check if extension is enabled for a URL. Channel pages are enabled at their
    // channel root so a single add covers /videos, /shorts, and all other tabs.
    const { url } = request;
    const enabledUrl = getEnabledUrl(url);
    console.log('get_extension_enabled:', { url, enabledUrl });

    if (!chrome.storage || !chrome.storage.local) {
      console.error('chrome.storage.local not available');
      sendResponse({ enabled: false }); // Default to disabled if storage not available
      return true;
    }

    chrome.storage.local.get(['enabled_sites'], (result) => {
      const enabledSites = result.enabled_sites || {};
      const isEnabled = !!enabledSites[enabledUrl];
      console.log('get_extension_enabled result:', { isEnabled, enabled: !!enabledSites[enabledUrl] });
      sendResponse({ enabled: isEnabled });
    });
    return true;
  }

  if (request.action === 'set_extension_enabled') {
    // Set extension enabled/disabled for a URL. Channel pages toggle at their
    // channel root, so enabling/disabling applies to the whole channel.
    const { url, enabled } = request;
    const enabledUrl = getEnabledUrl(url);
    console.log('set_extension_enabled:', { url, enabledUrl, enabled });

    if (!chrome.storage || !chrome.storage.local) {
      console.error('chrome.storage.local not available');
      sendResponse({ success: false, error: 'Storage not available' });
      return true;
    }

    chrome.storage.local.get(['enabled_sites'], (result) => {
      const enabledSites = result.enabled_sites || {};

      if (enabled) {
        enabledSites[enabledUrl] = true;
      } else {
        delete enabledSites[enabledUrl];
      }

      chrome.storage.local.set({ enabled_sites: enabledSites }, () => {
        console.log('set_extension_enabled: updated enabled_sites, count:', Object.keys(enabledSites).length);
        sendResponse({ success: true });
      });
    });
    return true;
  }

  if (request.action === 'store_log') {
    addLogEntry(request.level, request.message, request.source, request.url);
    return false;
  }

  if (request.action === 'get_all_logs') {
    sendResponse({ logs: logBuffer.slice() });
    return false;
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

    // Compile existing data to the channel-prefix model: per-tab channel keys
    // (/@handle/videos, /@handle/shorts) collapse into one channel-root key so a
    // channel only needs to be added once. Channels that have a saved position
    // are auto-enabled at their root so existing saves keep working across tabs.
    const enabledSites = items.enabled_sites || {};
    const newEnabled = {};
    let changed = false;

    for (const [key] of Object.entries(enabledSites)) {
      const root = getChannelRootUrl(key);
      if (root) {
        if (key !== root) changed = true;
        newEnabled[root] = true;
      } else {
        newEnabled[key] = true;
      }
    }

    for (const key of Object.keys(items)) {
      if (key.startsWith('yt_position_')) {
        const url = key.slice('yt_position_'.length);
        const root = getChannelRootUrl(url);
        if (root && !newEnabled[root]) {
          newEnabled[root] = true;
          changed = true;
        }
      }
    }

    if (changed) {
      chrome.storage.local.set({ enabled_sites: newEnabled }, () => {
        console.log(`Migration: enabled_sites compiled to channel roots, count: ${Object.keys(newEnabled).length}`);
      });
    } else {
      console.log('Migration: enabled_sites already channel-aware');
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
  migrateToEnabledSites();
});