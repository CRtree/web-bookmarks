# Scroll Saver

> Never lose your place again. Automatically save and restore your reading position on any article or long web page.

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Available-brightgreen?logo=googlechrome&logoColor=white)](https://chrome.google.com/webstore)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-1.0.0-orange.svg)](#)

---

## ✨ What is Scroll Saver?

**Scroll Saver** is a lightweight Chrome extension that remembers exactly where you left off when reading long articles, blog posts, documentation, or any lengthy web content. When you return to a page, it automatically scrolls you back to your last reading position.

### Why You'll Love It

- **Read without worry** - Close tabs freely knowing your position is saved
- **Zero friction** - Works automatically in the background
- **Privacy first** - All data stays on your device
- **Universal support** - Works on news sites, blogs, documentation, social media, and SPAs

---

## 🚀 Features

| Feature | Description |
|---------|-------------|
| **Automatic Tracking** | Saves your scroll position as you read (with smart debouncing) |
| **Smart Detection** | Intelligently identifies article pages using semantic HTML, common patterns, and content analysis |
| **SPA Support** | Works perfectly with React, Vue, and other single-page applications |
| **Per-Site Control** | Enable/disable tracking per website via the popup toggle |
| **Privacy Focused** | All data stored locally - nothing leaves your browser |
| **Auto Cleanup** | Automatically removes old positions after 30 days |
| **Zero Configuration** | Works out of the box - no setup required |

---

## 📦 Installation

### From Chrome Web Store (Recommended)

1. Visit the [Chrome Web Store page](https://chrome.google.com/webstore) (link coming soon)
2. Click **"Add to Chrome"**
3. Grant the requested permissions
4. Start reading!

### Manual Installation (Development)

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/scroll-saver.git
cd scroll-saver

# Load as unpacked extension
# 1. Open Chrome and navigate to chrome://extensions/
# 2. Enable "Developer mode" (toggle in top-right)
# 3. Click "Load unpacked"
# 4. Select the scroll-saver directory
```

---

## 🎯 How to Use

1. **Install the extension** - It's that simple!
2. **Read an article** - Scroll through any long page
3. **Close the tab** - Your position is automatically saved
4. **Come back later** - Revisit the page and you'll be scrolled right back to where you left off
5. **Check the popup** - Click the extension icon to see saved positions and manage settings

### Popup Interface

- **Current Page** - View and manage the current page's saved position
- **Toggle** - Enable/disable tracking for the current website
- **Stored Websites** - See all pages with saved positions
- **Quick Actions** - Delete individual positions or clear all data

---

## 🔧 Technical Details

### How It Works

**Content Script** (`content.js`)
- Injects into all pages automatically
- Detects article pages using semantic HTML tags (`<article>`, `<main>`, etc.)
- Analyzes page length and text content
- Saves position with 1-second debounce (avoids excessive writes)
- Restores position on page load with smooth scrolling
- Handles SPA navigation via MutationObserver and History API

**Background Service Worker** (`background.js`)
- Manages data storage and retrieval
- Runs weekly cleanup of entries older than 30 days
- Provides API for popup interface

**Popup Interface** (`popup.html`, `popup.js`, `popup.css`)
- Clean, modern UI for managing saved positions
- Real-time position display
- Per-site enable/disable toggle

### Configuration

Advanced users can customize behavior in `content.js`:

```javascript
const SCROLL_SAVE_DEBOUNCE_MS = 1000;  // Save delay after scrolling
const MIN_SCROLL_HEIGHT = 1500;        // Minimum page height to track
const MIN_SCROLL_PERCENT = 5;          // Minimum scroll % to save
```

---

## 🔒 Privacy & Security

- **100% Local Storage** - All data stored using `chrome.storage.local`
- **No External Connections** - Zero network requests, zero data sharing
- **Transparent** - Open source, auditable code
- **Minimal Permissions** - Only requests what's absolutely necessary

### Permissions Used

| Permission | Purpose |
|------------|---------|
| `storage` | Save reading positions locally |
| `activeTab` | Get current tab info for popup |
| `alarms` | Schedule weekly data cleanup |
| `tabs` | Query tab information |
| `<all_urls>` | Work on all websites (required for article detection) |

---

## 🛠️ Development

### Project Structure

```
scroll-saver/
├── manifest.json          # Extension manifest (v3)
├── content.js             # Content script - main tracking logic
├── background.js          # Service worker - storage management
├── popup.html            # Popup HTML
├── popup.css             # Popup styles
├── popup.js              # Popup functionality
├── icons/                # Extension icons
│   ├── bookmark_16.png
│   ├── bookmark_48.png
│   └── bookmark_128.png
├── package.sh            # Build script
├── LICENSE               # MIT License
└── README.md             # This file
```

### Building

```bash
# Create distributable ZIP
./package.sh

# Output: reading-position-recorder-v1.0.0.zip
```

### Testing

1. Load extension in Chrome (see Manual Installation)
2. Visit a long article (e.g., Wikipedia, Medium, blog posts)
3. Scroll down significantly
4. Refresh the page - position should restore automatically
5. Click the extension icon to verify saved position

### Debug Mode

Open Chrome Developer Tools (F12) to see detailed logs:
- Extension activation messages
- Position save/restore events
- Storage operations

Access debug functions in console:
```javascript
window.debugReadingPosition.isTrackingActive()
window.debugReadingPosition.checkStorage()
window.debugReadingPosition.forceRestore()
```

---

## 🤝 Contributing

Contributions are welcome! Here's how to help:

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

### Ideas for Contributions

- [ ] Add keyboard shortcuts for manual save/restore
- [ ] Implement data sync across devices
- [ ] Add visual progress indicator
- [ ] Support for paginated articles
- [ ] Export/import saved positions
- [ ] Better article detection algorithms

---

## 📝 Changelog

### v1.0.0 (2024)
- Initial release
- Automatic scroll position tracking
- Per-site enable/disable toggle
- SPA support (React, Vue, etc.)
- Weekly automatic cleanup
- Privacy-focused local storage

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- Created with care for readers everywhere
- Inspired by the frustration of losing your place in long articles
- Built for privacy-conscious users who want convenience without compromise

---

## 💬 Support

- **Issues** - [Report bugs or request features](../../issues)
- **Discussions** - [Ask questions or share ideas](../../discussions)
- **Star** ⭐ this repo if you find it useful!

---

<p align="center">
  <strong>Happy Reading!</strong> 📚
</p>

<p align="center">
  Made with ❤️ for the web reading community
</p>
