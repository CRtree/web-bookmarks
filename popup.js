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
  const clearCurrentBtn = document.getElementById('clear-current');
  const refreshBtn = document.getElementById('refresh');
  const positionsListEl = document.getElementById('positions-list');
  const clearAllBtn = document.getElementById('clear-all');
  const statsCountEl = document.getElementById('stats-count');
  const addPageBtn = document.getElementById('add-page');

  // ---- Layout ----
  // Two complete popup pages share this script:
  //   popup.html         "modern"  — compact two-column (popup.css)
  //   popup-classic.html "classic" — editorial single-column (popup-classic.css)
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

  // YouTube play icon (inline SVG)
  const PLAY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-2px;margin-right:3px;" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';

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
      };
      img.addEventListener('error', hide);
      // A cached failure can complete before this listener is attached.
      if (img.complete && img.naturalWidth === 0) hide();
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
                const isYT = currentTabPosition.videoId && !currentTabPosition.scrollY;
                const displayTitle = isYT
                  ? `<a href="${getYouTubeContentLink(currentTabPosition)}" target="_blank" class="entry-link">${PLAY_ICON}${currentTabPosition.videoId}</a>`
                  : truncate(tab.title || 'Untitled', 40);
                const thumb = thumbnailHtml(currentTabPosition);
                html = `
                  <div class="entry${thumb ? '' : ' no-thumb'}">
                    ${thumb}
                    <div class="entry-title">${displayTitle}</div>
                    <div class="entry-url">${truncatePrefix(currentTabUrl, 30)}</div>
                  </div>
                `;
                clearCurrentBtn.disabled = false;
                console.log('Popup: Showing saved position for current tab');
              } else {
                html = `
                  <div class="entry no-thumb">
                    <div class="entry-title">${truncate(tab.title || 'Untitled', 50)}</div>
                    <div class="entry-url">${truncatePrefix(currentTabUrl, 30)}</div>
                    ${isTracking
                      ? '<p class="entry-status">Tracking &mdash; start scrolling to save a position</p>'
                      : '<p class="entry-note">No saved position for this page</p>'
                    }
                  </div>
                `;
                clearCurrentBtn.disabled = true;
                console.log('Popup: No saved position for current tab');
              }

              currentInfoEl.innerHTML = html;
              wireThumbnailFallbacks(currentInfoEl);
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
      const titleText = isYT ? position.videoId : (position.title || 'Untitled');
      const title = isYT
        ? `<a href="${getYouTubeContentLink(position)}" target="_blank" class="entry-link">${PLAY_ICON}${position.videoId}</a>`
        : truncate(position.title || 'Untitled', 40);

      // Stored entries keep the video ID but drop the full link: the ID plus a
      // clickable preview identify the entry, and the URL is still reachable via
      // the goto action.
      const details = `
            <div class="entry-title" title="${titleText}">${title}</div>`;

      // Compact puts the details in a child so the icon actions sit beside
      // them; classic uses the original full-width text buttons underneath.
      const main = pageLayout === 'classic' ? details : `<div class="entry-main">${details}</div>`;
      const actions = pageLayout === 'classic'
        ? `<button class="btn goto" data-url="${url}">Go to Page</button>
            <button class="btn btn-danger clear-one" data-url="${url}">Delete</button>`
        : `<button class="icon-btn goto" data-url="${url}" title="Go to page">\u2197</button>
            <button class="icon-btn danger clear-one" data-url="${url}" title="Delete">\u2715</button>`;

      const thumb = thumbnailHtml(position);
      html += `
        <div class="entry${thumb ? '' : ' no-thumb'}" data-url="${url}">
          ${thumb}${main}
          <div class="entry-actions">${actions}
          </div>
        </div>
      `;
    });

    positionsListEl.innerHTML = html;
    wireThumbnailFallbacks(positionsListEl);

    // Add event listeners to the new buttons
    document.querySelectorAll('.clear-one').forEach(btn => {
      btn.addEventListener('click', function() {
        const url = this.getAttribute('data-url');
        clearPosition(url);
      });
    });

    document.querySelectorAll('.goto').forEach(btn => {
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        const url = this.getAttribute('data-url');
        if (!url) {
          console.error('Popup: No URL found on goto button');
          return;
        }
        chrome.tabs.create({ url }, (tab) => {
          if (chrome.runtime.lastError) {
            console.error('Popup: chrome.tabs.create failed:', chrome.runtime.lastError.message, 'falling back to window.open');
            window.open(url, '_blank');
          }
        });
      });
    });
  }

  // Update stats
  function updateStats() {
    const count = Object.keys(allPositions).length;
    statsCountEl.textContent = count;
    console.log('Popup: Stats updated, count:', count);
  }

  // Clear position for current tab
  clearCurrentBtn.addEventListener('click', function() {
    if (!currentTabUrl || !currentTabPosition) return;

    if (!confirm(`Delete the saved position for this page?\n\n${truncatePrefix(currentTabUrl, 50)}`)) return;

    chrome.runtime.sendMessage(
      { action: 'clear_position', url: currentTabUrl },
      function(response) {
        if (chrome.runtime.lastError) {
          console.error('Error:', chrome.runtime.lastError);
          return;
        }

        if (response.success) {
          // Update UI
          currentTabPosition = null;
          updateCurrentPageInfo();
          loadAllPositions(); // Reload all positions
        }
      }
    );
  });

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

  // Clear a specific position
  function clearPosition(url) {
    if (!confirm(`Delete this saved position?\n\n${truncatePrefix(url, 50)}`)) return;

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