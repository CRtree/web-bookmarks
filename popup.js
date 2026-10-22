// Scroll Saver - Popup Script

// Forward console logs to background for aggregation
(function() {
  const _original = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console)
  };

  function forward(level, args) {
    chrome.runtime.sendMessage({
      action: 'store_log',
      source: 'popup',
      level: level,
      message: args.join(' '),
      timestamp: Date.now()
    });
  }

  console.log = function(...args) {
    _original.log(...args);
    forward('log', args);
  };
  console.error = function(...args) {
    _original.error(...args);
    forward('error', args);
  };
  console.warn = function(...args) {
    _original.warn(...args);
    forward('warn', args);
  };
})();

console.log('Popup script loading...');

document.addEventListener('DOMContentLoaded', function() {
  console.log('Popup: DOM loaded, initializing...');
  try {
    // DOM Elements
  const currentInfoEl = document.getElementById('current-info');
  const refreshBtn = document.getElementById('refresh');
  const positionsListEl = document.getElementById('positions-list');
  const clearAllBtn = document.getElementById('clear-all');
  const statsCountEl = document.getElementById('stats-count');
  const addPageBtn = document.getElementById('add-page');

  // ---- Layout ----
  // Two complete popup pages share this script:
  //   popup.html         "modern"  — Compact layout, two-column (popup.css)
  //   popup-classic.html "classic" — Stack layout, editorial single-column (popup-classic.css)
  // The storage keys and data-layout values keep the old "modern"/"classic"
  // names; only the user-facing labels use Compact / Stack.
  // manifest.json points default_popup at the modern page, so a fresh install
  // opens it with no redirect. Switching calls chrome.action.setPopup so the
  // choice survives restarts, stores the preference, and navigates so it takes
  // effect without reopening.
  const LAYOUTS = { modern: 'popup.html', classic: 'popup-classic.html' };
  const DEFAULT_LAYOUT = 'modern';
  const pageLayout = document.body.dataset.layout === 'classic' ? 'classic' : 'modern';
  const layoutToggleBtn = document.getElementById('layout-toggle');

  function readStoredLayout(cb) {
    if (!chrome.storage || !chrome.storage.local) return cb(null);
    chrome.storage.local.get(['layout'], function(result) {
      if (chrome.runtime.lastError) return cb(null);
      const v = result && result.layout;
      cb(v === 'classic' || v === 'modern' ? v : null);
    });
  }

  function saveLayout(layout) {
    if (chrome.storage && chrome.storage.local) chrome.storage.local.set({ layout: layout });
    if (chrome.action && chrome.action.setPopup) {
      chrome.action.setPopup({ popup: LAYOUTS[layout] });
    }
  }

  if (layoutToggleBtn) {
    layoutToggleBtn.addEventListener('click', function() {
      const next = pageLayout === 'classic' ? 'modern' : 'classic';
      saveLayout(next);
      console.log('Popup: switching layout to', next);
      window.location.replace(LAYOUTS[next]);
    });
  }

  // Re-assert the stored preference over default_popup. chrome.action.setPopup
  // normally persists, but an extension update can reset it; this self-heals.
  // Navigating here is loop-free: we only ever redirect to the page matching
  // the target, which then finds itself already correct.
  readStoredLayout(function(stored) {
    const target = stored || DEFAULT_LAYOUT;
    if (stored !== target && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ layout: target });
    }
    if (chrome.action && chrome.action.setPopup) {
      chrome.action.setPopup({ popup: LAYOUTS[target] });
    }
    if (target !== pageLayout) {
      console.log('Popup: layout preference is', target, '- redirecting');
      window.location.replace(LAYOUTS[target]);
    }
  });

  // Trash icon (inline SVG) for the floating delete control.
  const TRASH_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';

  // The delete control floats on the preview's top-right corner. Hovering it
  // gives a small scale-up cue. Entries without a preview fall back to a bare
  // icon pinned to the entry (see .entry-delete-bare).
  function deleteButtonHtml(url, options) {
    const opts = options || {};
    const classes = 'entry-delete' + (opts.bare ? ' entry-delete-bare' : '');
    return `<button type="button" class="${classes}" data-url="${url}"`
      + ' title="Delete saved position" aria-label="Delete saved position">'
      + TRASH_ICON + '</button>';
  }

  // Build the correct YouTube link for a saved content entry. Shorts live under
  // /shorts/<id> while regular videos use /watch?v=<id>. Entries saved before the
  // type field existed default to 'video'.
  function getYouTubeContentLink(position) {
    const isShorts = position && position.type === 'shorts';
    const base = isShorts
      ? 'https://www.youtube.com/shorts/'
      : 'https://www.youtube.com/watch?v=';
    return base + (position ? position.videoId : '');
  }

  // State
  let currentTabUrl = null;
  let currentTabPosition = null;
  let allPositions = {};
  let isTracking = false;

  // Theme
  const themeToggleBtn = document.getElementById('theme-toggle');
  function applyTheme(theme) {
    const isDark = theme === 'dark';
    // Classic labels the button ("\u2600 Light"); compact shows the icon only.
    const label = pageLayout === 'classic'
      ? (isDark ? '\u2600 Light' : '\u263E Dark')
      : (isDark ? '\u2600' : '\u263E');
    document.body.classList.toggle('theme-dark', isDark);
    if (themeToggleBtn) {
      themeToggleBtn.textContent = label;
      themeToggleBtn.title = isDark ? 'Switch to light' : 'Switch to dark';
    }
  }
  function loadTheme() {
    if (!chrome.storage || !chrome.storage.local) {
      applyTheme('light');
      return;
    }
    chrome.storage.local.get(['theme'], function(result) {
      applyTheme(result.theme === 'dark' ? 'dark' : 'light');
    });
  }
  function toggleTheme() {
    const isDark = document.body.classList.contains('theme-dark');
    const newTheme = isDark ? 'light' : 'dark';
    applyTheme(newTheme);
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ theme: newTheme });
    }
  }
  loadTheme();

  // ---- Video previews ----
  // Always on: thumbnails are enrichment, not a user decision. The URL is derived
  // from the videoId already in storage, so this also lights up entries saved
  // before the feature existed. Note this is the extension's ONLY network
  // request — see the Privacy section of the README.
  function thumbnailUrl(videoId) {
    return 'https://i.ytimg.com/vi/' + encodeURIComponent(videoId) + '/mqdefault.jpg';
  }

  // Only ever trust a validated "mm:ss" / "h:mm:ss" from storage.
  function formatDuration(value) {
    return typeof value === 'string' && /^(?:\d{1,2}:)?\d{1,2}:\d{2}$/.test(value) ? value : '';
  }

  // Thumbnail + optional duration badge for a saved entry. Returns '' when the
  // entry has no videoId, so callers can inline it unconditionally.
  function thumbnailHtml(position) {
    if (!position || !position.videoId) return '';
    const duration = formatDuration(position.duration);
    const badge = duration ? `<span class="entry-duration">${duration}</span>` : '';
    return `<a class="entry-thumb" href="${getYouTubeContentLink(position)}" target="_blank" tabindex="-1" aria-hidden="true">`
      + `<img src="${thumbnailUrl(position.videoId)}" alt="" loading="lazy" referrerpolicy="no-referrer">${badge}</a>`;
  }

  // Drop a thumbnail that fails to load (offline, request blocked). Inline onerror
  // attributes are blocked by the MV3 CSP, so wire it up after insert. The entry
  // also gets .no-thumb so layout hooks (and the layout verifier) can tell the
  // preview is gone; the anchor itself is hidden so it never leaves an empty slot.
  //
  // Note: a deleted/private video does NOT land here — i.ytimg.com answers 404 with
  // a small (120px) placeholder JPEG, which decodes fine and fires load, not error.
  function wireThumbnailFallbacks(root) {
    if (!root) return;
    root.querySelectorAll('.entry-thumb img').forEach(function(img) {
      const hide = function() {
        const thumb = img.closest('.entry-thumb');
        if (thumb) thumb.style.display = 'none';
        const entry = img.closest('.entry');
        if (entry) entry.classList.add('no-thumb');
        // The overlay delete lived inside the preview; move it out so the entry
        // still has a delete control once the preview is gone.
        const media = img.closest('.entry-media');
        if (media && entry) {
          const btn = media.querySelector('.entry-delete');
          if (btn && !btn.classList.contains('entry-delete-bare')) {
            btn.classList.add('entry-delete-bare');
            entry.appendChild(btn);
          }
          media.style.display = 'none';
        }
      };
      img.addEventListener('error', hide);
      // A cached failure can complete before this listener is attached.
      if (img.complete && img.naturalWidth === 0) hide();
    });
  }

  // Wire the floating delete controls rendered inside a container. Uses event
  // listeners (not inline handlers) because the MV3 CSP blocks inline JS.
  function wireDeleteButtons(root) {
    if (!root) return;
    root.querySelectorAll('.entry-delete').forEach(function(btn) {
      if (btn.dataset.wired) return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', function() {
        const url = btn.getAttribute('data-url');
        if (url) clearPosition(url);
      });
    });
  }

  // Test background script connection
  function testBackgroundConnection() {
    console.log('Popup: Testing background script connection...');
    const timeout = setTimeout(() => {
      console.error('Popup: Background script not responding - timeout after 5 seconds');
    }, 5000);

    chrome.runtime.sendMessage({ action: 'ping' }, function(response) {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        console.error('Popup: Background script error:', chrome.runtime.lastError);
      } else {
        console.log('Popup: Background script responded:', response);
      }
    });
  }

  // Test storage access directly from popup
  function testStorageAccess() {
    console.log('Popup: Testing storage access directly...');
    if (!chrome.storage || !chrome.storage.local) {
      console.error('Popup: chrome.storage.local not available');
      return;
    }
    chrome.storage.local.get(null, function(items) {
      if (chrome.runtime.lastError) {
        console.error('Popup: Storage access error:', chrome.runtime.lastError);
      } else {
        console.log('Popup: Storage access successful, total items:', Object.keys(items).length);
        const ytPositions = {};
        for (const [key, value] of Object.entries(items)) {
          if (key.startsWith('yt_position_')) {
            ytPositions[key] = value;
          }
        }
        console.log('Popup: YouTube positions in storage:', Object.keys(ytPositions).length);
      }
    });
  }

  // Truncate text (keeps the beginning)
  function truncate(text, maxLength) {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }

  // Truncate from the START, keeping the trailing identity. Used for URLs where
  // the path suffix is what identifies the saved page (e.g. /@channel, /shorts/<id>).
  function truncatePrefix(text, maxLength) {
    if (!text || text.length <= maxLength) return text;
    return '...' + text.substring(Math.max(0, text.length - (maxLength - 3)));
  }

  // ---- Watch-page Prev / Next ----
  // On a regular video watch page the Current panel shows the video preview plus
  // Prev / Next buttons that walk the channel's upload list (background fetches
  // the ordered list from YouTube's inner API). Shorts pages are not handled yet.
  function parseWatchUrl(url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '');
      let videoId = null;
      if ((host === 'youtube.com' || host === 'm.youtube.com') && u.pathname === '/watch') {
        videoId = u.searchParams.get('v');
      } else if (host === 'youtu.be') {
        videoId = u.pathname.slice(1).split('/')[0];
      }
      if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
      return { videoId: videoId, listId: u.searchParams.get('list') || null };
    } catch (e) {
      return null;
    }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function watchThumbHtml(video) {
    const duration = formatDuration(video.duration);
    const badge = duration ? `<span class="entry-duration">${escapeHtml(duration)}</span>` : '';
    const src = video.thumbnail || thumbnailUrl(video.videoId);
    return `<div class="entry-thumb watch-thumb">`
      + `<img src="${escapeHtml(src)}" alt="" referrerpolicy="no-referrer">${badge}</div>`;
  }

  function watchArrowHtml(video, dir) {
    const label = dir === 'prev' ? 'Previous' : 'Next';
    const glyph = dir === 'prev' ? '\u2039' : '\u203a';
    if (!video) {
      return `<span class="watch-nav-arrow ${dir} is-disabled" aria-hidden="true">${glyph}</span>`;
    }
    const title = escapeHtml(video.title || 'video');
    return `<button type="button" class="watch-nav-arrow ${dir}" data-video-id="${escapeHtml(video.videoId)}"`
      + ` title="${label}: ${title}" aria-label="${label}: ${title}">${glyph}</button>`;
  }

  function watchNavHtml(video, prev, next, index, noteOverride) {
    const note = noteOverride || (index ? `Video ${index} in this channel` : 'Current video');
    return `
      <div class="watch-nav">
        <div class="watch-nav-media">
          ${watchArrowHtml(prev, 'prev')}
          ${watchThumbHtml(video)}
          ${watchArrowHtml(next, 'next')}
        </div>
        <div class="watch-nav-title">${escapeHtml(truncate(video.title || 'Untitled', 46))}</div>
        <div class="watch-nav-note">${escapeHtml(note)}</div>
      </div>`;
  }

  // Ask the background to refresh the channel's saved video and then navigate the
  // active tab. Keeping both in one message lets the background own the storage
  // write (so it cannot race the popup closing) and the navigation.
  function wireWatchNavigation(root, tabId, nav) {
    if (!root) return;
    const targets = { prev: nav && nav.prev, next: nav && nav.next };
    root.querySelectorAll('.watch-nav-arrow[data-video-id]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        const dir = btn.classList.contains('prev') ? 'prev' : 'next';
        const target = targets[dir];
        if (!target || typeof tabId !== 'number') return;
        // Refresh the channel's resume points for its own uploads list: the
        // Videos-tab spot moves to the target video, and the spot that led here
        // is matched by the video we are leaving.
        const useChannel = !!(nav && nav.channelUploads);
        chrome.runtime.sendMessage({
          action: 'watch_nav_goto',
          tabId: tabId,
          videoId: target.videoId,
          fromVideoId: useChannel ? (nav.videoId || null) : null,
          channelUrl: useChannel ? (nav.channelUrl || null) : null,
          duration: target.duration || ''
        }, function() {
          window.close();
        });
        // Safety net if the background never answers.
        setTimeout(function() { window.close(); }, 600);
      });
    });
  }

  function renderWatchFallback(tab, info) {
    const video = { videoId: info.videoId, title: tab.title, duration: '', thumbnail: null };
    currentInfoEl.innerHTML = watchNavHtml(video, null, null, null, 'Prev / next unavailable');
    wireWatchNavigation(currentInfoEl, tab.id, null);
    wireThumbnailFallbacks(currentInfoEl);
  }

  function renderWatchNavigation(tab, info) {
    currentInfoEl.innerHTML = '<p class="entry-loading">Loading&hellip;</p>';
    chrome.runtime.sendMessage(
      { action: 'get_watch_nav', videoId: info.videoId, listId: info.listId, tabId: tab.id },
      function(response) {
        if (chrome.runtime.lastError || !response || !response.ok || !response.nav) {
          console.warn('Popup: watch navigation unavailable, showing preview only');
          renderWatchFallback(tab, info);
          return;
        }
        const nav = response.nav;
        const video = nav.current || { videoId: info.videoId, title: tab.title };
        currentInfoEl.innerHTML = watchNavHtml(video, nav.prev, nav.next, nav.index);
        wireWatchNavigation(currentInfoEl, tab.id, nav);
        wireThumbnailFallbacks(currentInfoEl);
      }
    );
  }

  // Update current page info
  function updateCurrentPageInfo() {
    console.log('Popup: Updating current page info...');
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (!tabs[0]) {
        console.log('Popup: No active tab found');
        currentInfoEl.innerHTML = '<p class="error">No active tab found</p>';
        return;
      }

      const tab = tabs[0];
      currentTabUrl = tab.url;
      console.log('Popup: Current tab URL:', currentTabUrl);
      console.log('Popup: Current tab title:', tab.title);

      chrome.runtime.sendMessage(
        { action: 'get_extension_enabled', url: tab.url },
        function(enabledResponse) {
          if (chrome.runtime.lastError) {
            console.error('Popup: Error getting extension enabled state:', chrome.runtime.lastError);
            return;
          }

          isTracking = enabledResponse.enabled === true;
          updateAddButton();

          // Regular videos get Prev / Next navigation instead of the saved
          // scroll-position entry. Shorts pages keep the existing behavior.
          const watchInfo = parseWatchUrl(tab.url);
          if (watchInfo) {
            renderWatchNavigation(tab, watchInfo);
            return;
          }

          chrome.runtime.sendMessage(
            { action: 'get_current_tab_position' },
            function(positionResponse) {
              console.log('Popup: get_current_tab_position callback fired');
              if (chrome.runtime.lastError) {
                console.error('Popup: Error getting current tab position:', chrome.runtime.lastError);
                return;
              }

              console.log('Popup: Received current tab position response:', positionResponse);
              currentTabPosition = positionResponse.position;
              console.log('Popup: Current tab position:', currentTabPosition);

              let html = '';
              if (currentTabPosition) {
                const thumb = thumbnailHtml(currentTabPosition);
                // The preview is the entry point, so the video ID link is
                // redundant; show the page/video title and float delete on the
                // preview instead.
                const media = thumb
                  ? `<div class="entry-media">${thumb}${deleteButtonHtml(currentTabUrl)}</div>`
                  : '';
                html = `
                  <div class="entry${thumb ? '' : ' no-thumb'}">
                    ${media}
                    <div class="entry-main">
                      <div class="entry-title">${truncate(tab.title || 'Untitled', 40)}</div>
                      <div class="entry-url">${truncatePrefix(currentTabUrl, 30)}</div>
                    </div>
                    ${thumb ? '' : deleteButtonHtml(currentTabUrl, { bare: true })}
                  </div>
                `;
                console.log('Popup: Showing saved position for current tab');
              } else {
                html = `
                  <div class="entry no-thumb">
                    <div class="entry-main">
                      <div class="entry-title">${truncate(tab.title || 'Untitled', 50)}</div>
                      <div class="entry-url">${truncatePrefix(currentTabUrl, 30)}</div>
                      ${isTracking
                        ? '<p class="entry-status">Tracking &mdash; start scrolling to save a position</p>'
                        : '<p class="entry-note">No saved position for this page</p>'
                      }
                    </div>
                  </div>
                `;
                console.log('Popup: No saved position for current tab');
              }

              currentInfoEl.innerHTML = html;
              wireThumbnailFallbacks(currentInfoEl);
              wireDeleteButtons(currentInfoEl);
            }
          );
        }
      );
    });
  }

  // Update add button state for current URL
  function updateAddButton() {
    const addBtn = document.getElementById('add-page');
    if (!addBtn) return;

    if (isTracking) {
      addBtn.textContent = 'Stop';
      addBtn.classList.add('btn-added');
    } else {
      addBtn.textContent = 'Add';
      addBtn.classList.remove('btn-added');
    }
  }

  // Load all positions
  function loadAllPositions() {
    console.log('Popup: Loading all positions...');
    console.log('Popup: Sending get_positions message to background...');
    chrome.runtime.sendMessage({ action: 'get_positions' }, function(response) {
      console.log('Popup: get_positions callback fired');
      if (chrome.runtime.lastError) {
        console.error('Popup: Error loading positions:', chrome.runtime.lastError);
        return;
      }

      console.log('Popup: Received positions response:', response);
      allPositions = response.positions || {};
      console.log('Popup: Parsed positions count:', Object.keys(allPositions).length);
      updatePositionsList();
      updateStats();
    });
  }

  // Update positions list UI
  function updatePositionsList() {
    console.log('Popup: Updating positions list, total positions:', Object.keys(allPositions).length);
    const positions = Object.entries(allPositions);

    if (positions.length === 0) {
      console.log('Popup: No positions to display');
      positionsListEl.innerHTML = '<p class="empty-state">No saved positions yet</p>';
      return;
    }

    console.log('Popup: Displaying', positions.length, 'positions');
    // Sort by most recent
    positions.sort((a, b) => b[1].timestamp - a[1].timestamp);

    let html = '';
    positions.forEach(([url, position]) => {
      const isYT = position.videoId && !position.scrollY;
      const thumb = thumbnailHtml(position);

      // Video entries are identified by their preview alone: clicking it opens
      // the video, so the video ID and a separate go-to link are redundant.
      // Non-video entries keep a title, which links to the saved page because
      // they have no preview to click.
      let main = '';
      if (!isYT) {
        const titleText = position.title || 'Untitled';
        main = `<div class="entry-main">
            <div class="entry-title" title="${titleText}">
              <a class="entry-link" href="${url}" target="_blank" rel="noopener">${truncate(titleText, 40)}</a>
            </div>
          </div>`;
      }

      // Delete floats on the preview's top-right; entries without a preview get
      // a bare icon pinned to the entry.
      const media = thumb
        ? `<div class="entry-media">${thumb}${deleteButtonHtml(url)}</div>`
        : '';
      const bare = thumb ? '' : deleteButtonHtml(url, { bare: true });

      html += `
        <div class="entry${thumb ? '' : ' no-thumb'}" data-url="${url}">
          ${media}${main}${bare}
        </div>
      `;
    });

    positionsListEl.innerHTML = html;
    wireThumbnailFallbacks(positionsListEl);
    wireDeleteButtons(positionsListEl);
  }

  // Update stats
  function updateStats() {
    const count = Object.keys(allPositions).length;
    statsCountEl.textContent = count;
    console.log('Popup: Stats updated, count:', count);
  }

  // Clear all positions
  clearAllBtn.addEventListener('click', function() {
    if (Object.keys(allPositions).length === 0) return;

    if (confirm(`Are you sure you want to clear all ${Object.keys(allPositions).length} saved positions?`)) {
      chrome.runtime.sendMessage({ action: 'clear_all' }, function(response) {
        if (chrome.runtime.lastError) {
          console.error('Error:', chrome.runtime.lastError);
          return;
        }

        if (response.success) {
          allPositions = {};
          updatePositionsList();
          updateStats();
          updateCurrentPageInfo();
        }
      });
    }
  });

  // Refresh button
  refreshBtn.addEventListener('click', function() {
    updateCurrentPageInfo();
    loadAllPositions();
  });

  // Add/Stop button
  if (addPageBtn) {
    addPageBtn.addEventListener('click', function() {
      if (!currentTabUrl) {
        console.log('Popup: No current tab URL, cannot update tracking state');
        return;
      }

      const newState = !isTracking;
      console.log('Popup: Add button clicked, setting tracking to:', newState, 'for URL:', currentTabUrl);

      chrome.runtime.sendMessage(
        { action: 'set_extension_enabled', url: currentTabUrl, enabled: newState },
        function(response) {
          if (chrome.runtime.lastError) {
            console.error('Popup: Error setting tracking state:', chrome.runtime.lastError);
            return;
          }

          console.log('Popup: Tracking state updated successfully:', response);
          isTracking = newState;
          updateAddButton();
          updateCurrentPageInfo();
        }
      );
    });
  }

  // Clear a specific position. One click, no confirm: removing a single entry is
  // cheap to redo (re-add the channel), and the extra dialog slowed the common
  // case. "Delete all" keeps its confirm because it is bulk and hard to undo.
  function clearPosition(url) {
    chrome.runtime.sendMessage(
      { action: 'clear_position', url: url },
      function(response) {
        if (chrome.runtime.lastError) {
          console.error('Error:', chrome.runtime.lastError);
          return;
        }

        if (response.success) {
          // Remove from local state
          delete allPositions[url];
          updatePositionsList();
          updateStats();

          // If this is the current tab, update current page info
          if (url === currentTabUrl) {
            currentTabPosition = null;
            updateCurrentPageInfo();
          }
        }
      }
    );
  }

  // Export log button
  const exportLogBtn = document.getElementById('export-log');
  if (exportLogBtn) {
    exportLogBtn.addEventListener('click', function() {
      chrome.runtime.sendMessage({ action: 'get_all_logs' }, function(response) {
        if (chrome.runtime.lastError) {
          console.error('Popup: Error getting logs:', chrome.runtime.lastError);
          return;
        }

        const logs = response.logs || [];
        if (logs.length === 0) {
          alert('No logs collected yet.');
          return;
        }

        const lines = logs.map(function(entry) {
          var ts = new Date(entry.timestamp).toISOString();
          var urlSuffix = entry.url ? ' [' + entry.url + ']' : '';
          return '[' + ts + '] [' + entry.source + ':' + entry.level + ']' + urlSuffix + ' ' + entry.message;
        });

        var blob = new Blob([lines.join('\n')], { type: 'text/plain' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'scroll-saver-log-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      });
    });
  }

  // ---- Saved-position export / import ----
  // Archive the stored list to a JSON file, or read one back. Export reuses the
  // same get_positions payload the list renders. Import is re-validated in the
  // background, which also enables the imported channels so restores work.
  const EXPORT_KIND = 'youtube-scroll-saver-positions';
  const EXPORT_VERSION = 1;

  function buildPositionsExport(positions) {
    return {
      kind: EXPORT_KIND,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      count: Object.keys(positions).length,
      positions: positions
    };
  }

  function downloadJson(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportPositions() {
    chrome.runtime.sendMessage({ action: 'get_positions' }, function(response) {
      if (chrome.runtime.lastError) {
        alert('Export failed: ' + chrome.runtime.lastError.message);
        return;
      }
      const positions = (response && response.positions) || {};
      const count = Object.keys(positions).length;
      if (count === 0) {
        alert('There are no saved positions to export.');
        return;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      downloadJson('scroll-saver-positions-' + stamp + '.json',
        JSON.stringify(buildPositionsExport(positions), null, 2));
      console.log('Popup: exported', count, 'positions');
    });
  }

  // Import runs in its own window. Opening the OS file picker from this popup
  // dismisses the popup, which tears down the message port while the read/import
  // round-trip is still in flight. The import page does it from a window that
  // stays open, so the background can always answer.
  function openImportWindow() {
    const url = chrome.runtime.getURL('import.html');
    const width = 560;
    const height = 500;

    // chrome.windows.create places new windows at the top-left of the display by
    // default; center it on the screen the popup is on instead. availLeft/availTop
    // are Chrome-only but guard for engines that omit them.
    const scr = window.screen || {};
    const availLeft = typeof scr.availLeft === 'number' ? scr.availLeft : 0;
    const availTop = typeof scr.availTop === 'number' ? scr.availTop : 0;
    const availWidth = scr.availWidth || scr.width || 1280;
    const availHeight = scr.availHeight || scr.height || 800;
    const left = Math.round(availLeft + Math.max(0, (availWidth - width) / 2));
    const top = Math.round(availTop + Math.max(0, (availHeight - height) / 2));

    if (chrome.windows && chrome.windows.create) {
      const options = {
        url: url,
        type: 'popup',
        focused: true,
        width: width,
        height: height,
        left: left,
        top: top,
        // Some Chrome/macOS full-screen setups otherwise clone the current
        // window's full-screen state into the new popup.
        state: 'normal'
      };
      chrome.windows.create(options, function(win) {
        // Re-assert the normal size shortly after creation: on macOS a popup
        // opened from a full-screen window can be promoted to full screen after
        // its initial bounds are applied.
        if (win && win.id != null && chrome.windows.update) {
          setTimeout(function() {
            chrome.windows.update(win.id, {
              state: 'normal',
              width: width,
              height: height,
              left: left,
              top: top,
              focused: true
            }, function() { void chrome.runtime.lastError; });
          }, 50);
        }
      });
    } else if (chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: url });
    } else {
      window.open(url, '_blank');
    }
    window.close();
  }

  const exportPositionsBtn = document.getElementById('export-positions');
  if (exportPositionsBtn) exportPositionsBtn.addEventListener('click', exportPositions);
  const importPositionsBtn = document.getElementById('import-positions');
  if (importPositionsBtn) importPositionsBtn.addEventListener('click', openImportWindow);

  // Theme toggle button
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', toggleTheme);
  }

  // Video previews are always on, so there is no toggle to wire up.

  // Initialize
  testBackgroundConnection();
  testStorageAccess();
  updateCurrentPageInfo();
  loadAllPositions();

  // Auto-refresh every 10 seconds while popup is open
  const refreshInterval = setInterval(() => {
    updateCurrentPageInfo();
    loadAllPositions();
  }, 10000);

  // Clear interval when popup closes
  window.addEventListener('unload', () => {
    clearInterval(refreshInterval);
  });
  } catch (error) {
    console.error('Popup initialization error:', error);
  }
});