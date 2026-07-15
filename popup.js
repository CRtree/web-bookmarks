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

  // State
  let currentTabUrl = null;
  let currentTabPosition = null;
  let allPositions = {};
  let isTracking = false;

  // Theme
  const themeToggleBtn = document.getElementById('theme-toggle');
  function applyTheme(theme) {
    if (theme === 'dark') {
      document.body.classList.add('theme-dark');
      if (themeToggleBtn) themeToggleBtn.textContent = '\u2600 Light';
    } else {
      document.body.classList.remove('theme-dark');
      if (themeToggleBtn) themeToggleBtn.textContent = '\u263E Dark';
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
        const readingPositions = {};
        for (const [key, value] of Object.entries(items)) {
          if (key.startsWith('reading_position_')) {
            readingPositions[key] = value;
          }
        }
        console.log('Popup: Reading positions in storage:', Object.keys(readingPositions).length);
      }
    });
  }

  // Format date
  function formatDate(timestamp) {
    if (!timestamp) return 'Unknown time';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
    if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
    return date.toLocaleDateString();
  }

  // Truncate text
  function truncate(text, maxLength) {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
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
                  ? `<a href="https://www.youtube.com/watch?v=${currentTabPosition.videoId}" target="_blank" class="entry-link">&#9654; ${currentTabPosition.videoId}</a>`
                  : truncate(tab.title || 'Untitled', 40);
                html = `
                  <div class="entry">
                    <div class="entry-title">${displayTitle}</div>
                    <div class="entry-url">${truncate(currentTabUrl, 45)}</div>
                    <div class="entry-meta">${formatDate(currentTabPosition.timestamp)}</div>
                  </div>
                `;
                clearCurrentBtn.disabled = false;
                console.log('Popup: Showing saved position for current tab');
              } else {
                html = `
                  <div class="entry">
                    <div class="entry-title">${truncate(tab.title || 'Untitled', 50)}</div>
                    <div class="entry-url">${truncate(currentTabUrl, 60)}</div>
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
        ? `<a href="https://www.youtube.com/watch?v=${position.videoId}" target="_blank" class="entry-link">&#9654; ${position.videoId}</a>`
        : truncate(position.title || 'Untitled', 40);
      html += `
        <div class="entry" data-url="${url}">
          <div class="entry-title" title="${titleText}">${title}</div>
          <div class="entry-url" title="${url}">${truncate(url, 45)}</div>
          <div class="entry-meta">${formatDate(position.timestamp)}</div>
          <div class="entry-actions">
            <button class="btn goto" data-url="${url}">Go to Page</button>
            <button class="btn btn-danger clear-one" data-url="${url}">Delete</button>
          </div>
        </div>
      `;
    });

    positionsListEl.innerHTML = html;

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