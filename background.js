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

// ---- Saved-position export / import ----
// The popup can export the stored list to a JSON file and read it back. Import
// re-validates every field here, so a malformed or hand-edited file cannot write
// arbitrary keys into storage.
function isValidPosition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const hasVideo = typeof value.videoId === 'string' && value.videoId.length > 0;
  const hasScroll = typeof value.scrollY === 'number' && isFinite(value.scrollY);
  return hasVideo || hasScroll;
}

// Keep only the fields the extension understands, coerced to safe types.
function sanitizePosition(value) {
  const out = {};
  const videoId = typeof value.videoId === 'string' ? value.videoId.trim().slice(0, 64) : '';
  if (videoId) {
    out.videoId = videoId;
    out.type = value.type === 'shorts' ? 'shorts' : 'video';
  }
  out.timestamp = typeof value.timestamp === 'number' && isFinite(value.timestamp)
    ? value.timestamp
    : Date.now();
  if (typeof value.duration === 'string' && /^(?:\d{1,2}:)?\d{1,2}:\d{2}$/.test(value.duration)) {
    out.duration = value.duration;
  }
  if (typeof value.scrollY === 'number' && isFinite(value.scrollY) && value.scrollY >= 0) {
    out.scrollY = Math.round(value.scrollY);
  }
  if (typeof value.title === 'string' && value.title.trim()) {
    out.title = value.title.trim().slice(0, 300);
  }
  return out;
}

// Only accept http(s) keys; normalize them the same way saves do so an imported
// entry lines up with the key the content script will look up on restore.
function normalizeImportedUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return normalizeUrl(trimmed);
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

// ---- Watch-page video navigation (Prev / Next in a channel's upload list) ----
//
// YouTube's watch page calls the internal endpoint /youtubei/v1/next with the
// channel's uploads playlist (UU<channelId without "UC">). One request returns the
// current video's absolute position in the playlist plus a window of ~99 adjacent
// videos (typically 20 before / 78 after). That is enough to offer Prev / Next
// without scrolling a long channel page.
//
// The fetch itself runs in the content script (same-origin with youtube.com): a
// request from the extension's service worker is rejected with HTTP 403 by
// YouTube's bot protection, while the page's own origin passes. This module only
// caches the result and proxies popup requests to the content script.
// The prefix and schema are versioned together: a nav cached by an earlier build
// may carry a stale channelUploads/channelUrl, which would make the popup skip
// the position refresh, so old entries must be ignored rather than reused.
const YT_NEXT_CACHE_PREFIX = 'yt_nav_';
const YT_NEXT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const WATCH_NAV_SCHEMA = 2;

// Extract the video id (and optional playlist id) from a watch URL. Regular
// videos only for now; Shorts pages are a separate surface handled later.
function parseYouTubeWatchUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    let videoId = null;
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      if (u.pathname === '/watch') videoId = u.searchParams.get('v');
    } else if (host === 'youtu.be') {
      videoId = u.pathname.slice(1).split('/')[0];
    }
    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
    return { videoId: videoId, listId: u.searchParams.get('list') || null };
  } catch (e) {
    return null;
  }
}

function watchNavCacheKey(videoId, listId) {
  return YT_NEXT_CACHE_PREFIX + videoId + (listId ? '--' + listId : '');
}

function getCachedWatchNavigation(videoId, listId, callback) {
  if (!chrome.storage || !chrome.storage.local) return callback(null);
  const key = watchNavCacheKey(videoId, listId);
  chrome.storage.local.get([key], (result) => {
    const entry = result && result[key];
    if (entry && entry.nav && entry.nav.schema === WATCH_NAV_SCHEMA
        && Date.now() - (entry.ts || 0) < YT_NEXT_CACHE_TTL_MS) {
      return callback(entry.nav);
    }
    callback(null);
  });
}

function cacheWatchNavigation(videoId, listId, nav) {
  if (!chrome.storage || !chrome.storage.local || !nav) return;
  chrome.storage.local.set({ [watchNavCacheKey(videoId, listId)]: { ts: Date.now(), nav: nav } });
}

// True only for the channel's "Videos" tab page, e.g.
// https://www.youtube.com/@handle/videos. Prev / Next walks the channel's
// uploads, so that tab is the page whose saved spot can safely follow along.
function isChannelVideosUrl(url, channelRoot) {
  if (!channelRoot) return false;
  try {
    const u = new URL(url);
    if (!u.hostname.includes('youtube.com')) return false;
    const base = channelRoot.replace(/\/+$/, '');
    const want = (base + '/videos').toLowerCase();
    const got = (u.origin + u.pathname.replace(/\/+$/, '')).toLowerCase();
    return got === want;
  } catch (e) {
    return false;
  }
}

// Move the channel's Videos-tab "resume video" to the video just navigated to,
// so the stored list follows a binge session instead of reopening the original
// video.
//
// Only the Videos tab is ever touched: Prev / Next walks exactly that list, so
// every target is guaranteed to exist on it. Home and Shorts show different
// lists, and a Videos-tab video may not be present on them — the next restore
// would then scan the whole page hunting for it and drop the position (the
// scroll-to-bottom bug). Called before the tab navigates, so the update is
// durable when the new page loads.
function updateChannelPosition(info, done) {
  if (!chrome.storage || !chrome.storage.local) return done && done();
  const targetRoot = getChannelRootUrl(info.channelUrl || '');
  if (!targetRoot) return done && done();
  chrome.storage.local.get(null, (items) => {
    if (chrome.runtime.lastError || !items) return done && done();
    const updates = {};
    for (const key of Object.keys(items)) {
      if (!key.startsWith('yt_position_')) continue;
      const value = items[key];
      if (!value) continue;
      const url = key.slice('yt_position_'.length);
      if (!isChannelVideosUrl(url, targetRoot)) continue;
      const next = Object.assign({}, value, {
        videoId: info.videoId,
        type: 'video',
        timestamp: Date.now()
      });
      if (info.duration) next.duration = info.duration;
      updates[key] = next;
    }
    if (Object.keys(updates).length === 0) return done && done();
    chrome.storage.local.set(updates, () => {
      console.log('watch_nav_goto: refreshed', Object.keys(updates).length, 'position(s)');
      done && done();
    });
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

  if (request.action === 'get_watch_nav') {
    // Prev / Next for the video open in the active tab. Cache-first so the
    // popup's 10s auto-refresh (and reopening the popup) is free.
    const info = request.videoId
      ? { videoId: request.videoId, listId: request.listId || null }
      : parseYouTubeWatchUrl(request.url);
    if (!info) {
      sendResponse({ ok: false, error: 'not a watch page' });
      return true;
    }
    getCachedWatchNavigation(info.videoId, info.listId, (cached) => {
      if (cached) {
        sendResponse({ ok: true, nav: cached, cached: true });
        return;
      }
      // Proxy to the tab's content script so the request is same-origin with
      // youtube.com (the service worker's own fetch gets HTTP 403).
      const askContentScript = (tabId) => {
        chrome.tabs.sendMessage(
          tabId,
          { action: 'fetch_watch_nav', videoId: info.videoId, listId: info.listId },
          (resp) => {
            if (chrome.runtime.lastError || !resp || !resp.ok || !resp.nav) {
              const reason = (chrome.runtime.lastError && chrome.runtime.lastError.message)
                || (resp && resp.error) || 'fetch failed';
              console.warn('get_watch_nav failed:', reason);
              sendResponse({ ok: false, error: reason });
              return;
            }
            cacheWatchNavigation(info.videoId, info.listId, resp.nav);
            sendResponse({ ok: true, nav: resp.nav });
          }
        );
      };
      if (typeof request.tabId === 'number') {
        askContentScript(request.tabId);
      } else {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (!tabs || !tabs[0]) {
            sendResponse({ ok: false, error: 'no active tab' });
            return;
          }
          askContentScript(tabs[0].id);
        });
      }
    });
    return true;
  }

  if (request.action === 'watch_nav_goto') {
    // Prev / Next click: refresh the channel's saved video, then navigate. Doing
    // both here (rather than in the popup) keeps the storage write from racing
    // the popup closing, and the popup navigating itself.
    const videoId = request.videoId;
    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      sendResponse({ ok: false, error: 'invalid video id' });
      return true;
    }
    const navigate = () => {
      if (typeof request.tabId !== 'number' || !chrome.tabs) {
        sendResponse({ ok: true, navigated: false });
        return;
      }
      chrome.tabs.update(request.tabId, { url: 'https://www.youtube.com/watch?v=' + videoId }, () => {
        sendResponse({ ok: true, navigated: true });
      });
    };
    console.log('watch_nav_goto:', JSON.stringify({
      videoId,
      fromVideoId: request.fromVideoId || null,
      channelUrl: request.channelUrl || null
    }));
    if (request.channelUrl) {
      updateChannelPosition({
        videoId: videoId,
        channelUrl: request.channelUrl,
        duration: request.duration
      }, navigate);
    } else {
      navigate();
    }
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

  if (request.action === 'import_positions') {
    // Always answer: an uncaught throw here closes the message port, which the
    // caller surfaces as "the message port closed before a response was received".
    try {
      if (!chrome.storage || !chrome.storage.local) {
        console.error('chrome.storage.local not available');
        sendResponse({ success: false, error: 'Storage not available' });
        return true;
      }

      // "merge" (default) upserts the supplied entries; "replace" also drops any
      // stored position the file does not mention.
      const mode = request.mode === 'replace' ? 'replace' : 'merge';
      const incoming = request.positions;
      const cleaned = {};
      let skipped = 0;

      if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
        for (const [url, value] of Object.entries(incoming)) {
          const normalized = normalizeImportedUrl(url);
          if (!normalized || !isValidPosition(value)) {
            skipped++;
            continue;
          }
          cleaned[`yt_position_${normalized}`] = sanitizePosition(value);
        }
      }

      const imported = Object.keys(cleaned).length;
      if (imported === 0) {
        sendResponse({ success: true, imported: 0, skipped, mode });
        return true;
      }

      chrome.storage.local.get(null, (items) => {
        if (chrome.runtime.lastError) {
          console.error('import_positions: read failed:', chrome.runtime.lastError);
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
          return;
        }

        const updates = Object.assign({}, cleaned);
        const toRemove = [];
        if (mode === 'replace') {
          for (const key of Object.keys(items)) {
            if (key.startsWith('yt_position_') && !cleaned[key]) toRemove.push(key);
          }
        }

        // Enable each imported channel at its root. Restore only runs on added
        // channels, so importing a position without this would save it but never
        // scroll back to it.
        const enabledSites = Object.assign({}, items.enabled_sites || {});
        for (const key of Object.keys(cleaned)) {
          const root = getChannelRootUrl(key.slice('yt_position_'.length));
          if (root) enabledSites[root] = true;
        }
        updates.enabled_sites = enabledSites;

        const commit = () => chrome.storage.local.set(updates, () => {
          if (chrome.runtime.lastError) {
            console.error('import_positions: write failed:', chrome.runtime.lastError);
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          console.log('import_positions:', { imported, skipped, mode });
          sendResponse({ success: true, imported, skipped, mode });
        });

        if (toRemove.length > 0) {
          chrome.storage.local.remove(toRemove, commit);
        } else {
          commit();
        }
      });
    } catch (error) {
      console.error('Unexpected error in import_positions:', error);
      sendResponse({ success: false, error: error && error.message ? error.message : String(error) });
    }
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

// Housekeeping: an earlier version cached a per-channel Videos-tab index under
// yt_vindex_. That approach was dropped, so remove any leftovers.
function removeVideoIndexCache() {
  if (!chrome.storage || !chrome.storage.local) return;
  chrome.storage.local.get(null, (items) => {
    const stale = Object.keys(items || {}).filter(
      (k) => k.startsWith('yt_vindex_') || k.startsWith('yt_next_')
    );
    if (stale.length) {
      chrome.storage.local.remove(stale);
      console.log('Removed', stale.length, 'stale video-index cache entries');
    }
  });
}
removeVideoIndexCache();

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