# Reading Position Recorder Chrome Extension

A Chrome extension that automatically records your reading position on long articles and restores it when you revisit the page. Never lose your place again!

## Features

- **Automatic tracking**: Saves scroll position on articles and long pages
- **Smart detection**: Identifies article pages using multiple heuristics
- **SPA support**: Works with single-page applications (React, Vue, etc.)
- **Manual control**: Popup shows saved positions with clear options
- **Privacy-focused**: All data stored locally in your browser

## Installation

### Development (Unpacked)

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right corner)
4. Click **Load unpacked** button
5. Select the directory containing this extension
6. The extension will appear in your toolbar

### Production (Packaged)

1. Package the extension:
   ```bash
   cd /path/to/extension
   zip -r scoll-saver-1.0.0.zip . -x ".*" -x "__MACOSX" -x "*.py" -x "README.md"
   ```
2. Upload the ZIP to the Chrome Web Store (requires developer account)

## How It Works

### Content Script
- Injects into all pages
- Detects article pages using:
  - Semantic HTML tags (`<article>`, `<main>`, `[role="main"]`)
  - Common CSS classes (`.post`, `.article`, `.content`, etc.)
  - Page length and text content analysis
- Saves scroll position with debouncing (1 second delay)
- Restores position on page load
- Handles SPA navigation via MutationObserver and History API hooks

### Background Service Worker
- Manages storage cleanup (removes entries older than 30 days)
- Provides messaging API for popup
- Weekly automatic cleanup

### Popup Interface
- Shows current page's saved position
- Lists all saved positions with timestamps
- Allows clearing individual or all positions
- Direct links to saved pages

## Configuration

Default settings (editable in `content.js`):
- `SCROLL_SAVE_DEBOUNCE_MS`: 1000ms (save delay after scrolling)
- `MIN_SCROLL_HEIGHT`: 1500px (minimum page height to track)
- `MIN_SCROLL_PERCENT`: 5% (minimum scroll percentage to save)
- `ARTICLE_SELECTORS`: Array of CSS selectors for article detection

## Development

### File Structure
```
├── manifest.json          # Extension manifest
├── content.js            # Content script (main logic)
├── background.js         # Background service worker
├── popup.html           # Popup interface
├── popup.css            # Popup styles
├── popup.js             # Popup functionality
├── icons/               # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md            # This file
```

### Testing
1. Load the extension as unpacked (see Installation)
2. Open a long article (e.g., Wikipedia page, blog post)
3. Scroll down significantly
4. Refresh the page - position should restore
5. Click extension icon to see saved positions

### Debugging
- Open Chrome Developer Tools
- Console logs show extension activity:
  - "Reading Position Recorder active for: [Page Title]"
  - "Saved scroll position: X px (Y%)"
  - "Restoring to saved position: X px (Y%)"

## Permissions

- `storage`: Save and retrieve reading positions
- `activeTab`: Get current tab information for popup
- `alarms`: Schedule automatic cleanup of old entries
- `tabs`: Query tab information
- `<all_urls>`: Work on all websites (required for article detection)

## Privacy

- All data stored locally using `chrome.storage.local`
- No data sent to external servers
- Automatic cleanup of old entries (30 days)
- Users can clear all data via popup

## Limitations

- May not detect all article layouts (custom CSS classes)
- Position restoration may be off on dynamically loaded content
- Very short pages are ignored
- Requires page to be loaded fully for accurate detection

## Future Improvements

- [ ] User-configurable settings
- [ ] Keyboard shortcuts for manual save/restore
- [ ] Export/import saved positions
- [ ] Sync across browsers (optional)
- [ ] Better article detection with machine learning
- [ ] Support for paginated articles
- [ ] Visual indicator of saved position

## License

MIT License - see LICENSE file (to be added)

## Credits

Created with ❤️ using Claude Code

## Support

For issues or feature requests, please create an issue on the repository.