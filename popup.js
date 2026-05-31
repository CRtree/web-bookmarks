// Scroll Saver - Popup Script
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
  const extensionToggle = document.getElementById('extension-toggle');
  const toggleText = document.querySelector('.toggle-text');

  // State
  let currentTabUrl = null;
  let currentTabPosition = null;
  let allPositions = {};

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

  // Format scroll position
  function formatPosition(position) {
    if (!position) return 'No position saved';
    const percent = position.scrollPercent ? position.scrollPercent.toFixed(1) : '0';
    return `${percent}%`;
  }

  // Truncate text
  function truncate(text, maxLength) {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }

  // Update current page info
  function updateCurrentPageInfo() {
    console.log('Popup: Updating current page info...');
    // Get current active tab
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

      // Update extension toggle for this URL
      updateExtensionToggle(tab.url);

      // Get position for current tab
      console.log('Popup: Sending get_current_tab_position message to background...');
      chrome.runtime.sendMessage(
        { action: 'get_current_tab_position' },
        function(response) {
          console.log('Popup: get_current_tab_position callback fired');
          if (chrome.runtime.lastError) {
            console.error('Popup: Error getting current tab position:', chrome.runtime.lastError);
            return;
          }

          console.log('Popup: Received current tab position response:', response);
          currentTabPosition = response.position;
          console.log('Popup: Current tab position:', currentTabPosition);

          let html = '';
          if (currentTabPosition) {
            html = `
              <p class="title"><strong>${truncate(tab.title || 'Untitled', 40)}</strong></p>
              <p class="url">${truncate(currentTabUrl, 45)}</p>
              <div class="details">
                <span class="position">${formatPosition(currentTabPosition)}</span>
                <span class="time">${formatDate(currentTabPosition.timestamp)}</span>
              </div>
            `;
            clearCurrentBtn.disabled = false;
            console.log('Popup: Showing saved position for current tab');
          } else {
            html = `
              <p class="title"><strong>${truncate(tab.title || 'Untitled', 50)}</strong></p>
              <p class="url">${truncate(currentTabUrl, 60)}</p>
              <p class="position">No saved position for this page</p>
              <p class="help-text">Scroll down on a long article to save your position</p>
            `;
            clearCurrentBtn.disabled = true;
            console.log('Popup: No saved position for current tab');
          }

          currentInfoEl.innerHTML = html;
        }
      );
    });
  }

  // Update extension toggle state for current URL
  function updateExtensionToggle(url) {
    if (!url) {
      console.log('Popup: No URL provided for toggle update');
      return;
    }

    console.log('Popup: Updating extension toggle for URL:', url);
    chrome.runtime.sendMessage(
      { action: 'get_extension_enabled', url },
      function(response) {
        console.log('Popup: get_extension_enabled callback fired');
        if (chrome.runtime.lastError) {
          console.error('Popup: Error getting extension enabled state:', chrome.runtime.lastError);
          return;
        }

        console.log('Popup: Extension enabled state:', response.enabled);
        const isEnabled = response.enabled !== false; // default to true if undefined

        // Update toggle checkbox
        if (extensionToggle) {
          extensionToggle.checked = isEnabled;
          console.log('Popup: Toggle checkbox set to:', isEnabled);
        }

        // Update toggle text
        if (toggleText) {
          toggleText.textContent = isEnabled ? 'Enabled' : 'Disabled';
          console.log('Popup: Toggle text set to:', toggleText.textContent);
        }
      }
    );
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
      positionsListEl.innerHTML = '<p class="empty">No saved positions yet</p>';
      return;
    }

    console.log('Popup: Displaying', positions.length, 'positions');
    // Sort by most recent
    positions.sort((a, b) => b[1].timestamp - a[1].timestamp);

    let html = '';
    positions.forEach(([url, position]) => {
      const title = position.title || 'Untitled';
      html += `
        <div class="position-item" data-url="${url}">
          <div class="title" title="${title}">${truncate(title, 40)}</div>
          <div class="url" title="${url}">${truncate(url, 45)}</div>
          <div class="details">
            <span class="position">${formatPosition(position)}</span>
            <span class="time">${formatDate(position.timestamp)}</span>
          </div>
          <div class="actions">
            <button class="btn btn-secondary btn-small goto" data-url="${url}">Go to Page</button>
            <button class="btn btn-danger btn-small clear-one" data-url="${url}">Delete</button>
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

  // Extension toggle
  if (extensionToggle) {
    extensionToggle.addEventListener('change', function() {
      if (!currentTabUrl) {
        console.log('Popup: No current tab URL, cannot update extension state');
        return;
      }

      const isEnabled = this.checked;
      console.log('Popup: Extension toggle changed to:', isEnabled, 'for URL:', currentTabUrl);

      // Update toggle text immediately for responsive UI
      if (toggleText) {
        toggleText.textContent = isEnabled ? 'Enabled' : 'Disabled';
      }

      // Send message to background to update state
      chrome.runtime.sendMessage(
        { action: 'set_extension_enabled', url: currentTabUrl, enabled: isEnabled },
        function(response) {
          if (chrome.runtime.lastError) {
            console.error('Popup: Error setting extension enabled state:', chrome.runtime.lastError);
            // Revert toggle on error
            extensionToggle.checked = !isEnabled;
            if (toggleText) {
              toggleText.textContent = !isEnabled ? 'Enabled' : 'Disabled';
            }
            return;
          }

          console.log('Popup: Extension state updated successfully:', response);
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