# Scroll Saver

> Never lose your place on YouTube. Automatically remembers the video you clicked on a channel and restores it when you come back.

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Available-brightgreen?logo=googlechrome&logoColor=white)](https://chrome.google.com/webstore)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-2.0.0-orange.svg)](#)


## ✨ What is Scroll Saver?

**Scroll Saver** is a lightweight Chrome extension that remembers the last video you clicked on a YouTube channel (*/@* page). When you return to that channel, it automatically scrolls you back to that video — even if the video is far down a long, infinitely-scrolling channel.

### Why You'll Love It

- **Watch without worry** - Close tabs freely, knowing your spot is saved
- **Zero friction** - Works automatically in the background
- **Privacy first** - All data stays on your device
- **YouTube focused** - Laser-targeted to YouTube channel pages


## 📦 Installation

### From Chrome Web Store (Recommended)

1. Visit the [Chrome Web Store page](https://chromewebstore.google.com/detail/plnjpjdjdomfkaendgfccokpbhbcomlo?utm_source=item-share-cb)
2. Click **"Add to Chrome"**
3. Grant the requested permissions
4. Start reading!

## 🎯 How to Use

1. **Install the extension** - It's that simple!
2. **Open a YouTube channel** - Browse any channel page (URL starts with `/@`)
3. **Click a video** - Your spot on that channel is saved
4. **Come back later** - Revisit the channel and you'll be scrolled back to the video you clicked
5. **Check the popup** - Click the extension icon to see saved channels and manage settings


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
| `<all_urls>` | Inject everywhere, but only YouTube channel pages are tracked |


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
├── test_youtube_live.mjs     # Live automation test (YouTube channel click-save/restore)
├── package.sh            # Build script
├── LICENSE               # MIT License
└── README.md             # This file
```

### Architecture

> The diagrams below describe the **legacy generic article mode** (removed in v1.2.0). The current build is **YouTube channel only**: it saves a clicked video's `videoId` under a `yt_position_*` key and, on returning to the channel, progressively scans the page to scroll that video back into view. See [`content.js`](content.js) for the live logic.

#### State Machine (legacy article mode)

```
     TRACKING        RESTORING        COOLDOWN
     ────────        ─────────        ────────

  ┌─────────┐    scroll event    ┌───────────┐  reached target  ┌──────────┐
  │  IDLE   │──────────────────▶ │ RESTORING │────────────────▶ │ COOLDOWN │
  │ saves   │                    │ saves     │                  │ saves    │
  │ ALLOWED │                    │ BLOCKED   │                  │ BLOCKED  │
  └─────────┘                    └───────────┘                  └────┬─────┘
       ▲                                                            │
       │                                  10 seconds elapsed        │
       └────────────────────────────────────────────────────────────┘
```

Three guards protect against overwriting a valid position:

| Guard | What it blocks | Where |
|-------|---------------|-------|
| `isRestoring` | Saves during the scroll animation itself | `handleScroll`, visibility handler |
| 10s cooldown | Saves after restore finishes but page still loading content | `handleScroll`, visibility handler |
| min scroll threshold | Saves near the very top of the page (<5% scroll) | `saveScrollPosition` |

#### Restore Flow

```
  restoreScrollPosition(url)
       │
       ▼
  isRestoring? ──YES──▶ abort
  isTrackingActive? ──NO──▶ abort
       │
       ▼
  get saved position from chrome.storage.local
       │
  ┌────┴────┐
  │ NO DATA │ YES, HAS DATA
  ▼         ▼
 SKIP    target > current page height?
           ┌─────┴─────┐
           │ YES       │ NO (smooth path)
           ▼           ▼
    PROGRESSIVE        SMOOTH SCROLL
    (infinite scroll)  window.scrollTo({ behavior:'smooth' })
           │               │
    scrollTo(instant)      settle checker (every 200ms, max 15s):
    dispatch scroll event       wait until currentY ≥ target - 50px
    wait 1s, repeat                  │
    (max 40 attempts)         ┌──────┴──────┐
           │                  │ reached     │ timeout
           └──────────────────┤ target?     │
                              └──────┬──────┘
                                     ▼
                              isRestoring = false
                              restoreCompletedAt = Date.now()
                              ▶ 10s cooldown starts
```

#### Save Flow

```
  scroll event               tab hidden              page unload
       │                    (visibilitychange)      (beforeunload/pagehide)
       ▼                         │                       │
  isRestoring? ──YES──▶ IGNORE   │                       │
       │                         │                       │
       ▼                         ▼                       ▼
  within 10s cooldown?      isTrackingActive         isTrackingActive?
  ──YES──▶ IGNORE           && !isRestoring          ──NO──▶ IGNORE
       │                    && !in cooldown?              │
       │                         │                       ▼
       ▼                         ▼                  ✅ save (no cooldown
  reset 1s debounce        ✅ save immediately           check — user is
  after 1s idle:                                         done reading)
    isTrackingActive? ──NO──▶ IGNORE
    isRestoring? ──YES──▶ IGNORE
    in cooldown? ──YES──▶ IGNORE
    ✅ saveScrollPosition() ──▶ chrome.storage.local
```

### Building

```bash
# Create distributable ZIP
./package.sh
```

### Store assets

Regenerate the Chrome Web Store promotional images (banner, small tile, and the dark/light popup screenshots) into `store-assets/`:

```bash
npm run assets
# or: ./tools/marketing/build.sh
```

`package.sh` also runs this automatically at the end of every package build, so a fresh release always ships matching store graphics.

## 📝 Changelog

### v2.0.1 (2026)
- **Popup window size** — pin the popup to exactly `640×400` by setting the size on both `<html>` and `<body>` so Chrome opens the popup at the intended dimensions instead of scaling it larger.

### v2.0.0 (2026)
- **Major upgrade** — all improvements consolidated into one release:
  - **Shorts support** — tracks both `/videos` and `/shorts` cards on a channel (`/@…`), saving the content ID + type and restoring it on return.
  - **Channel-level enablement** — one “Add” enables a whole channel at its `/@handle`, covering every tab; existing enablements and saved channels migrate automatically.
  - **Compact popup redesign** — fixed `640×400` window, slim header, two-column layout, and compact entry rows with inline icon actions.
  - **Clearer & safer UI** — delete confirmations, tagline in the header, suffix-first URL display, higher text contrast in both themes.

### v1.2.0 (2026)
- **YouTube-only** — removed generic article/scroll tracking. The extension now injects only on YouTube and works exclusively on channel (`/@…`) pages.
- **Removed** the article detector, `reading_position_*` storage, and the scroll-event/unload save logic. The `<all_urls>` host permission is retained — the script loads everywhere but only tracks YouTube channel pages.

### v1.1.2 (2026)
- **Opt-in by default** — extension starts disabled; enable per-site via the popup toggle
- **Migration** — existing saved sites are automatically carried forward as enabled
- **Post-restore cooldown** — prevents position overwrites from late-loading content after restore
- **Scroll settle detection** — waits for smooth scroll to actually finish before re-enabling saves

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
