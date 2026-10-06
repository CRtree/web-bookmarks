// Youtube Scroll Saver - import page
//
// Import runs in its own window rather than the toolbar popup. Opening the OS
// file picker from an action popup dismisses the popup, which tears down the
// message port while the read/import round-trip is still in flight ("the message
// port closed before a response was received"). A real window survives the
// picker, so the background can always answer.
//
// The page is a small state machine - idle / working / success / error - so the
// outcome gets the whole card instead of a line of text.

const els = {
  card: document.getElementById('card'),
  idle: document.getElementById('state-idle'),
  working: document.getElementById('state-working'),
  success: document.getElementById('state-success'),
  error: document.getElementById('state-error'),
  drop: document.getElementById('drop'),
  file: document.getElementById('file'),
  workingName: document.getElementById('working-name'),
  importedCount: document.getElementById('imported-count'),
  importedLabel: document.getElementById('imported-label'),
  successDetail: document.getElementById('success-detail'),
  errorDetail: document.getElementById('error-detail'),
  again: document.getElementById('again'),
  close: document.getElementById('close'),
  retry: document.getElementById('retry'),
};

const STATES = {
  idle: els.idle,
  working: els.working,
  success: els.success,
  error: els.error,
};

function show(name) {
  for (const [key, el] of Object.entries(STATES)) {
    el.hidden = key !== name;
  }
  els.card.classList.toggle('is-success', name === 'success');
  els.card.classList.toggle('is-error', name === 'error');
}

function reset() {
  els.file.value = '';
  els.successDetail.textContent = '';
  els.errorDetail.textContent = '';
  els.workingName.textContent = '';
  show('idle');
}

function fail(message) {
  els.errorDetail.textContent = message;
  show('error');
}

// Accepts either the exported wrapper ({ kind, positions: {...} }) or a bare
// { url: position } map, so hand-written files still import.
function extractPositions(parsed) {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && parsed.positions && typeof parsed.positions === 'object' && !Array.isArray(parsed.positions)) {
    return parsed.positions;
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  return null;
}

function plural(n, singular, pluralForm) {
  return n === 1 ? singular : pluralForm;
}

function handleFile(file) {
  if (!file) return;

  els.workingName.textContent = file.name;
  show('working');

  const reader = new FileReader();
  reader.onload = function() {
    let parsed;
    try {
      parsed = JSON.parse(String(reader.result));
    } catch (e) {
      fail('That file is not valid JSON.');
      return;
    }

    const positions = extractPositions(parsed);
    const count = positions ? Object.keys(positions).length : 0;
    if (!count) {
      fail('No saved positions were found in that file.');
      return;
    }

    chrome.runtime.sendMessage(
      { action: 'import_positions', positions: positions, mode: 'merge' },
      function(response) {
        if (chrome.runtime.lastError) {
          fail('The extension did not respond. Reload it from chrome://extensions and try again. (' + chrome.runtime.lastError.message + ')');
          return;
        }
        if (!response || !response.success) {
          fail((response && response.error) || 'The import could not be completed.');
          return;
        }

        els.importedCount.textContent = response.imported;
        els.importedLabel.textContent = plural(response.imported, 'position imported', 'positions imported');
        els.successDetail.textContent = response.skipped
          ? response.skipped + ' invalid ' + plural(response.skipped, 'entry was', 'entries were') + ' skipped.'
          : '';
        show('success');
      }
    );
  };
  reader.onerror = function() {
    fail('That file could not be read.');
  };
  reader.readAsText(file);
}

els.file.addEventListener('change', function() {
  handleFile(els.file.files && els.file.files[0]);
});

['dragenter', 'dragover'].forEach(function(type) {
  els.drop.addEventListener(type, function(e) {
    e.preventDefault();
    els.drop.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach(function(type) {
  els.drop.addEventListener(type, function(e) {
    e.preventDefault();
    els.drop.classList.remove('dragover');
  });
});
els.drop.addEventListener('drop', function(e) {
  handleFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
});

els.again.addEventListener('click', reset);
els.retry.addEventListener('click', reset);

// This page is opened by the extension, so window.close() is not guaranteed to
// work; close the current window through the API instead.
els.close.addEventListener('click', function() {
  if (chrome.windows && chrome.windows.getCurrent) {
    chrome.windows.getCurrent(function(win) {
      if (win && win.id != null) chrome.windows.remove(win.id);
    });
  } else {
    window.close();
  }
});
