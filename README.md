# Scroll Saver

> Never lose your place again. Automatically save and restore your reading position on any article or long web page.

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Available-brightgreen?logo=googlechrome&logoColor=white)](https://chrome.google.com/webstore)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-1.1.0-orange.svg)](#)


## ✨ What is Scroll Saver?

**Scroll Saver** is a lightweight Chrome extension that remembers exactly where you left off when reading long articles, blog posts, documentation, YouTube channel pages, or any lengthy web content. When you return to a page, it automatically scrolls you back to your last reading position.

### Why You'll Love It

- **Read without worry** - Close tabs freely knowing your position is saved
- **Zero friction** - Works automatically in the background
- **Privacy first** - All data stays on your device
- **Universal support** - Works on news sites, blogs, documentation, social media, and SPAs


## 📦 Installation

### From Chrome Web Store (Recommended)

1. Visit the [Chrome Web Store page](https://chromewebstore.google.com/detail/plnjpjdjdomfkaendgfccokpbhbcomlo?utm_source=item-share-cb)
2. Click **"Add to Chrome"**
3. Grant the requested permissions
4. Start reading!

## 🎯 How to Use

1. **Install the extension** - It's that simple!
2. **Read an article** - Scroll through any long page
3. **Close the tab** - Your position is automatically saved
4. **Come back later** - Revisit the page and you'll be scrolled right back to where you left off
5. **Check the popup** - Click the extension icon to see saved positions and manage settings


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
├── test_scroll_restore.html  # Automation test (YouTube scroll restore)
├── package.sh            # Build script
├── LICENSE               # MIT License
└── README.md             # This file
```

### Building

```bash
# Create distributable ZIP
./package.sh
```

## 📝 Changelog

### v1.1.0 (2026)
- **YouTube channel support** — scroll position now restores on YouTube channel pages (`/videos`, `/shorts`, etc.)

### v1.0.0 (2025)
- Initial release


## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.


## 💬 Support

- **Issues** - [Report bugs or request features](../../issues)
- **Discussions** - [Ask questions or share ideas](../../discussions)
- **Star** ⭐ this repo if you find it useful!
