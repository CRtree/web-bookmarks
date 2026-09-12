# Scroll Saver

> Never lose your place on YouTube. Automatically remembers the video you clicked on a channel and restores it when you come back.

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Available-brightgreen?logo=googlechrome&logoColor=white)](https://chrome.google.com/webstore)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-2.0.1-orange.svg)](#)


## ✨ What is Scroll Saver?

**Scroll Saver** is a lightweight Chrome extension that remembers your **scroll position on any YouTube channel**. Click a video or a Short, close the tab, come back later — and it automatically scrolls you back to exactly where you left off, even when that content sits far down a long, infinitely-scrolling channel page.

A focused alternative to generic "scroll position saver" tools: it does one thing, on one site, and does it automatically.

### Why You'll Love It

- **Watch without worry** - Close tabs freely, knowing your spot is saved
- **Zero friction** - Works automatically in the background
- **Privacy first** - Saved positions, enabled channels and settings stay on your device. The
  only outbound request is the thumbnail image (see [Privacy](#-privacy--security)).
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


## 🎨 Popup layouts and previews

The popup ships in two layouts and remembers your choice.

| | Compact (default) | Classic |
|---|---|---|
| Look | Two columns, system sans-serif | Editorial single column, system serif |
| Size | 640×400 | 360×689 (scrolls past Chrome's 600px cap) |
| Toggle | ☰ in the top bar | "Compact" in the footer |

`manifest.json` points `default_popup` at `popup.html`, so a fresh install opens the compact
layout with no redirect. The choice is saved in `chrome.storage.local` (`layout`) and
applied via `chrome.action.setPopup`, so it persists across restarts. Both layouts share
`popup.js` and differ only in markup and stylesheet:

- `popup.html` + `popup.css` — compact two-column (default)
- `popup-classic.html` + `popup-classic.css` — editorial single column

Changing the default means updating **both** `default_popup` in `manifest.json` and
`DEFAULT_LAYOUT` in `popup.js`; existing users keep whatever they have chosen.

### Video previews

Every saved entry shows a thumbnail and, when it could be scraped at save time, a duration
badge. There is no toggle — previews are always on. See
[Privacy](#-privacy--security) for the network implication.

Except for the compact Current panel, where the preview spans the width, previews sit beside
the text rather than above it:

| Layout | Preview | Size |
|---|---|---|
| Classic, both panels | beside the text | 96×54 |
| Compact, Current panel | full width | ~170×96 |
| Compact, Stored list | beside the details | 72×40 |

Previews are deliberately height-neutral in the classic layout: a full-width thumbnail grew
that popup from 689px to 858px, which is far past Chrome's 600px cap and produced nested
scrollbars. When a thumbnail is unavailable the row gets `.no-thumb` and reverts to the plain
stacked layout instead of leaving an empty column.

Durations are copied from the clicked card on the channel page and are best-effort. YouTube's
badge class names change between releases, so there is a rename-proof fallback: the duration is
the only childless element in a card whose entire text is a timestamp, and the scan is bounded
so it can never reach a neighbouring video in a grid. Shorts cards carry no duration at all, and
entries saved before this existed have none — in every such case the badge is simply omitted.

Preview both layouts in every theme:

```bash
npm run screenshots
```

> **Note:** the classic layout originally loaded Playfair Display + Source Serif 4 from
> `fonts.googleapis.com` — four external requests on every popup open, which contradicted this
> extension's privacy posture. It now uses system serif stacks
> (`Iowan Old Style` / `Palatino` / `Georgia`). Typography is close but not pixel-identical.
> Self-hosting the webfonts would restore it exactly, at a cost of roughly 200 KB added to a
> 25 KB extension.


## 🔒 Privacy & Security

- **100% Local Storage** - All data stored using `chrome.storage.local`
- **No accounts, no analytics, no servers of ours** - Positions, enabled channels and settings
  never leave your browser. See "the one network request" below.
- **Transparent** - Open source, auditable code
- **Minimal Permissions** - Only requests what's absolutely necessary

### The one network request

Saved entries show a video thumbnail, loaded from
`https://i.ytimg.com/vi/<videoId>/mqdefault.jpg`. That URL contains the video ID, so opening
the popup tells YouTube which videos are in your saved list. This is the extension's **only**
outbound request.

- The URL is derived from the `videoId` already in local storage — no lookup, no API key.
- `loading="lazy"` fetches only the rows actually visible in the list.
- `referrerpolicy="no-referrer"` keeps the extension URL out of the request.
- Everything else (positions, enabled channels, theme, layout) stays local.

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
├── popup.html            # Popup HTML — compact layout
├── popup.css             # Popup styles — compact layout
├── popup-classic.html    # Popup HTML — classic (pre-2.0) layout
├── popup-classic.css     # Popup styles — classic layout
├── popup.js              # Popup functionality (shared by both layouts)
├── icons/                # Extension icons
│   ├── bookmark_16.png
│   ├── bookmark_48.png
│   └── bookmark_128.png
├── _locales/                # Localized name + description (11 locales, see below)
├── docs/store-listing.md    # Paste-ready store copy + target keywords
├── tools/marketing/         # Store asset build (tile, banner, screenshots)
├── test_youtube_live.mjs     # Live automation test (YouTube channel click-save/restore)
├── tools/verify-i18n.mjs     # Validates locale codes and message resolution
├── tools/verify-layout.mjs   # Layout toggle + previews, end to end
├── tools/verify-duration.mjs # Live test: duration scraped from a real channel
├── tools/screenshot-layouts.mjs  # Renders every layout/theme for review
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

Regenerate the Chrome Web Store promotional images into `store-assets/` — the marquee
banner, the small promo tile, and popup screenshots for both layouts in light and dark:

```bash
npm run assets
# or: ./tools/marketing/build.sh
```

`package.sh` also runs this automatically at the end of every package build, so a fresh release always ships matching store graphics.

### Localization

**The item name is not localized.** `manifest.json` hardcodes `"name": "Youtube Scroll Saver"`,
so the extension shows the same name in every locale (`chrome://extensions`, the toolbar, and
the store listing).

Only the **summary** is localized — `manifest.json` uses `"description": "__MSG_description__"`,
resolved through `_locales/<code>/messages.json`. Supported: `de`, `en`, `es`, `fr`, `hi`, `id`,
`ja`, `pt_BR`, `ru`, `zh_CN`, `zh_TW`.

The long-form store description and the target keyword list live in
[`docs/store-listing.md`](docs/store-listing.md).

Locale folder names must exactly match Chrome's supported codes — `zh` is **not** valid,
it must be `zh_CN` / `zh_TW`. An unrecognized folder is silently ignored, which means that
language never shows up on your store listing.

```bash
npm run verify:i18n
```

This checks every folder against Chrome's supported locale list, validates the JSON and the
132-character summary limit, then loads the extension in Chromium to confirm the manifest
messages actually resolve.

When adding a locale:

1. Copy an existing `_locales/<code>/messages.json`.
2. Translate `description`. Keep it under 132 characters.
3. Run `npm run verify:i18n`.
4. Add locale-specific screenshots in the Developer Dashboard if you want matching visuals.

> **Note:** each `messages.json` also carries a translated `name`. It is currently **inactive** —
> Chrome only applies it if `manifest.json` switches to `"name": "__MSG_name__"`. The values are
> kept so that switching later is a one-line change. `npm run verify:i18n` flags them as unused.

## ✅ Verification

Three scripts, all runnable from the repo root:

| Script | Covers | Needs network |
|---|---|---|
| `npm run verify:i18n` | Locale codes, JSON shape, 132-char limit, live message resolution | no |
| `npm run verify:layout` | Manifest default popup, layout toggle + persistence, previews, thumbnail fallback | yes (CDN) |
| `npm run verify:duration` | Scrapes a duration from a real channel page and asserts it is what got saved | yes (YouTube) |

Each loads the real extension in Chromium rather than unit-testing in isolation — `/verify:layout`
clicks the actual toggle button and checks `chrome.action.getPopup()`, and `/verify:duration`
dispatches the same `pointerdown` that `content.js` listens for, then reads the entry back out of
`chrome.storage.local` from an extension page.

Two gotchas worth knowing if you extend them:

- Use `channel: 'chromium'`. Playwright's default headless shell cannot load extensions at all.
- Thumbnails use `loading="lazy"`, which Chrome will not resolve in a backgrounded page. Call
  `bringToFront()` and poll, rather than sleeping.

`npm run screenshots` renders every layout × theme to `/tmp/ss-layouts` for visual review.

## 📝 Changelog

### v2.0.1 (2026)
- **Layout toggle** — the pre-2.0 editorial layout is back as a selectable option, so users who
  preferred the old UI can switch to it. The compact layout stays the default (`default_popup`
  and `DEFAULT_LAYOUT` both point at it); the choice is stored and survives restarts. Both
  layouts share one `popup.js`, so Shorts support and channel-level enablement work in both.
- **Video previews** — saved entries always show a YouTube thumbnail and, where available, a
  duration badge. There is no toggle. This is the extension's only network request; see
  [Privacy](#-privacy--security). Durations are scraped from the channel card on click, with a
  rename-proof fallback (Shorts have no duration, so they show the thumbnail alone).
- **Store discoverability** — keyword-optimized localized store summaries across 11 locales, and fixed
  the invalid `_locales/zh` folder (Chrome silently ignored it) by renaming it to `_locales/zh_CN`
  and adding `zh_TW`. The item name is unchanged.
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
