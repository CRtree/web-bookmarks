# Scroll Saver

> Never lose your place on YouTube. Automatically remembers the video you clicked on a channel and restores it when you come back.

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Available-brightgreen?logo=googlechrome&logoColor=white)](https://chrome.google.com/webstore)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-2.1.1-orange.svg)](#)


## ✨ What is Scroll Saver?

**Scroll Saver** is a lightweight Chrome extension that remembers your **scroll position on any YouTube channel**. Click a video or a Short, close the tab, come back later — and it automatically scrolls you back to exactly where you left off, even when that content sits far down a long, infinitely-scrolling channel page.

A focused alternative to generic "scroll position saver" tools: it does one thing, on one site, and does it automatically.

### Why You'll Love It

- **Watch without worry** - Close tabs freely, knowing your spot is saved
- **Continue down a channel** - On a video, the popup shows **‹ Prev** / **Next ›** to step
  through the channel's uploads without scrolling a long page. The channel's **Videos** tab spot
  follows along as you watch, so the next visit there resumes at the latest video.
- **Zero friction** - Works automatically in the background
- **Privacy first** - Saved positions, enabled channels and settings stay on your device. The
  only outbound requests are thumbnails and, on a video page, the channel's own video list
  (see [Privacy](#-privacy--security)).
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
6. **Back up your list** - In the Stored panel, **Export** writes every saved position to a JSON file and **Import** opens a small window to read one back (positions with the same URL are updated, and their channels are enabled)


## 🎨 Popup layouts and previews

The popup ships in two layouts and remembers your choice.

| | Compact (default) | Stack |
|---|---|---|
| Look | Two columns, system sans-serif | Editorial single column, system serif |
| Size | 640×400 | 360×scrolls (full-width previews exceed Chrome's 600px cap) |
| Toggle | ☰ in the top bar | "Compact" in the fixed bottom bar |

`manifest.json` points `default_popup` at `popup.html`, so a fresh install opens the compact
layout with no redirect. The choice is saved in `chrome.storage.local` (`layout`) and
applied via `chrome.action.setPopup`, so it persists across restarts. Both layouts share
`popup.js` and differ only in markup and stylesheet:

- `popup.html` + `popup.css` — Compact, two-column (default)
- `popup-classic.html` + `popup-classic.css` — Stack, editorial single column

Changing the default means updating **both** `default_popup` in `manifest.json` and
`DEFAULT_LAYOUT` in `popup.js`; existing users keep whatever they have chosen.

### Video previews

Every saved entry shows a thumbnail and, when it could be scraped at save time, a duration
badge. There is no toggle — previews are always on. See
[Privacy](#-privacy--security) for the network implication.

Saved entries lead with a preview — two per row in the Compact stored list, full width
elsewhere:

| Layout | Preview | Size |
|---|---|---|
| Stack, both panels | full width, above the text | 16:9 (≈316×178) |
| Compact, Current panel | full width | 16:9 |
| Compact, Stored list | two per row, preview-only cards | 16:9 (≈190×107 each) |

The preview is the entry point: clicking it opens the video, so video entries no longer show
their ID or a separate go-to link. Delete floats on the preview's top-right as a trash icon
that scales up slightly on hover/focus as a pressability cue. Entries without a preview —
channel scroll positions — keep a linked title and a compact trash icon pinned to the entry's
top-right.

Because the Stack popup now carries full-width previews it grows past Chrome's 600px cap and
scrolls as a single column; the stored list no longer keeps its own scrollbar. When a thumbnail
is unavailable the entry gets `.no-thumb` and simply renders without it.

Durations are copied from the clicked card on the channel page and are best-effort. YouTube's
badge class names change between releases, so there is a rename-proof fallback: the duration is
the only childless element in a card whose entire text is a timestamp, and the scan is bounded
so it can never reach a neighbouring video in a grid. Shorts cards carry no duration at all, and
entries saved before this existed have none — in every such case the badge is simply omitted.

Preview both layouts in every theme:

```bash
npm run screenshots
```

### Backing up the stored list

The Stored panel's **Export** and **Import** controls move the saved list in and out as JSON, so it
can be archived or carried to another machine. Export writes:

> **Why Import opens its own window.** Choosing a file from a toolbar popup dismisses the popup the
> moment the OS picker takes focus, which closes the extension message port before the background can
> answer. `import.html` runs in a small window that survives the picker, reads the file, and calls the
> same background import path.

```json
{
  "kind": "youtube-scroll-saver-positions",
  "version": 1,
  "exportedAt": "2026-01-01T00:00:00.000Z",
  "count": 1,
  "positions": {
    "https://www.youtube.com/@handle/videos": {
      "videoId": "dQw4w9WgXcQ",
      "type": "video",
      "timestamp": 1700000000000,
      "duration": "19:49"
    }
  }
}
```

Import accepts that wrapper **or** a bare `{ "<url>": { … } }` map. It merges by default — an entry
with the same URL is updated, every other entry is kept — skips anything that isn't an `http(s)` URL
with a `videoId` or `scrollY`, and enables each imported channel at its root so the entries restore
instead of sitting inert. The whole exchange is local; it is not a network feature.

> **Note:** the classic layout originally loaded Playfair Display + Source Serif 4 from
> `fonts.googleapis.com` — four external requests on every popup open, which contradicted this
> extension's privacy posture. It now uses system serif stacks
> (`Iowan Old Style` / `Palatino` / `Georgia`). Typography is close but not pixel-identical.
> Self-hosting the webfonts would restore it exactly, at a cost of roughly 200 KB added to a
> 25 KB extension.


## 🔒 Privacy & Security

- **100% Local Storage** - All data stored using `chrome.storage.local`
- **No accounts, no analytics, no servers of ours** - Positions, enabled channels and settings
  never leave your browser. See "the outbound requests" below.
- **Transparent** - Open source, auditable code
- **Minimal Permissions** - Only requests what's absolutely necessary

### The outbound requests

There are two, both to YouTube and neither involving an account, an API key of yours, or a
server of ours:

1. **Thumbnails.** Saved entries show a video thumbnail, loaded from
   `https://i.ytimg.com/vi/<videoId>/mqdefault.jpg`. That URL contains the video ID, so opening
   the popup tells YouTube which videos are in your saved list.
   - The URL is derived from the `videoId` already in local storage — no lookup, no API key.
   - `loading="lazy"` fetches only the rows actually visible in the list.
   - `referrerpolicy="no-referrer"` keeps the extension URL out of the request.

2. **Watch-page Prev / Next.** When you open the popup on a regular YouTube video page, the
   content script asks YouTube for that channel's ordered uploads list so the **‹ Prev** /
   **Next ›** buttons know what comes before and after the current video. (That list omits
   members-only videos, so those are skipped.) The request is made from the video page itself
   (same origin as youtube.com, using the page's own web client), and only while the popup is
   open on a watch page. The result is cached locally, and the background never makes the
   request, so the extension origin is never exposed to it.

- Everything else (positions, enabled channels, theme, layout) stays local.

### Permissions Used

| Permission | Purpose |
|------------|---------|
| `storage` | Save reading positions locally |
| `activeTab` | Get current tab info for popup |
| `alarms` | Schedule weekly data cleanup |
| `tabs` | Query tab information |
| `<all_urls>` | Inject everywhere, but only YouTube channel/video pages are used, and the watch-page list is fetched from the page's own origin |


## 🛠️ Development

### Project Structure

```
scroll-saver/
├── manifest.json          # Extension manifest (v3)
├── content.js             # Content script - main tracking logic
├── background.js          # Service worker - storage management
├── popup.html            # Popup HTML — compact layout
├── popup.css             # Popup styles — compact layout
├── popup-classic.html    # Popup HTML — Stack (pre-2.0) layout
├── popup-classic.css     # Popup styles — Stack layout
├── popup.js              # Popup functionality (shared by both layouts)
├── import.html           # Import page - its own window (the popup can't survive the file picker)
├── import.js             # Import page logic
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
├── tools/verify-click-save.mjs # Regression: saving only on added channels
├── tools/verify-duration.mjs # Live test: duration scraped from a real channel
├── tools/verify-transfer.mjs # Saved-list export/import, end to end
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

Five scripts, all runnable from the repo root:

| Script | Covers | Needs network |
|---|---|---|
| `npm run verify:i18n` | Locale codes, JSON shape, 132-char limit, live message resolution | no |
| `npm run verify:layout` | Manifest default popup, layout toggle + persistence, previews, thumbnail fallback | yes (CDN) |
| `npm run verify:click-save` | Click-to-save is armed only for added channels; Add/Stop apply live | no |
| `npm run verify:duration` | Scrapes a duration from a real channel page and asserts it is what got saved | yes (YouTube) |
| `npm run verify:transfer` | Export writes a versioned JSON file; import validates, merges, skips junk, and re-enables channels | no |

Each loads the real extension in Chromium rather than unit-testing in isolation — `/verify:layout`
clicks the actual toggle button and checks `chrome.action.getPopup()`, `/verify:duration`
dispatches the same `pointerdown` that `content.js` listens for, then reads the entry back out of
`chrome.storage.local` from an extension page, and `/verify:click-save` serves a local
YouTube-shaped fixture (no network) and drives the disabled → added → disabled lifecycle.

Two gotchas worth knowing if you extend them:

- Use `channel: 'chromium'`. Playwright's default headless shell cannot load extensions at all.
- Thumbnails use `loading="lazy"`, which Chrome will not resolve in a backgrounded page. Call
  `bringToFront()` and poll, rather than sleeping.

`npm run screenshots` renders every layout × theme to `/tmp/ss-layouts` for visual review.

## 📝 Changelog

### v2.1.1 (2026)
- **Layout names** — the two-column layout is **Compact** again and the editorial single-column
  layout is **Stack**. The names now describe the geometry and are parallel, replacing "Vertical
  Menu" (which named the *two-column* layout) and "Extended" (which named the *single-column*
  one). Toggles name their destination: the Stack popup's button reads `Compact`, and the Compact
  popup's `☰` reads "Switch to the stack layout". The stored `layout` values (`modern` /
  `classic`) and the filenames are unchanged.
- **Stack toolbar is a fixed floor** — the `Export Log` / `Compact` / theme controls in the Stack
  layout are pinned to the bottom of the popup instead of sitting under the tagline, so a long
  Stored list never buries them behind a scroll. The bar is slimmer than the card actions and the
  container reserves matching bottom padding so no entry hides behind it.

### v2.1.0 (2026)
- **Export / import the saved list** — the Stored panel gains **Export** (writes every saved position to a
  versioned `scroll-saver-positions-*.json`) and **Import**, which opens a small dedicated window
  (`import.html`) and reads that file back. Import runs outside the toolbar popup because the OS file
  picker dismisses a popup and closes the message port mid-request; the background handler also now
  answers on every path, even an unexpected error. Import merges by default,
  re-validates every field in the background — malformed entries and non-`http(s)` keys are skipped and the
  count is reported — and enables each imported channel at its root so restores actually run. The window is
  a small state machine (choose → importing → result) and announces the outcome with a full-card success
  view — an animated check badge and a large imported count — instead of a line of text. Covered by
  `npm run verify:transfer`.
- **Tighter Extended layout** — the utility controls (`Export Log`, `Vertical Menu`, theme) moved out of the
  footer to a toolbar under the tagline, and card/entry/preview spacing was compacted.
- **`Refresh` beside `Add`** — in both layouts Refresh now shares the Current header row instead of occupying
  its own row; the compact layout uses an icon-only `↻` to fit its 200px column.
- **Compact Stored header** — Export / Import / Delete all are now icon buttons with tooltips, and the
  saved-position count sits beside the `Stored` title so the header stays on one line.
- **One-click delete** — deleting a single saved video no longer shows a confirm dialog; the trash icon
  removes it immediately. "Delete all" keeps its confirmation because it is bulk and hard to undo.

### v2.0.3 (2026)
- **Preview-first entries** — the preview is now the only thing identifying a saved video.
  Clicking it opens the video, so the video ID and the separate go-to button are gone from both
  layouts; titles stay (and link to the saved page) for non-video entries that have no preview.
- **Two previews per row** — the Vertical Menu stored list lays its video cards out in a
  two-column grid, roughly halving the scrolling for a list of saved videos; entries without a
  preview span the full width so their titles still fit.
- **Floating delete** — delete is now a trash icon on the preview's top-right, with a subtle
  scale-up on hover as a pressability cue. It's obvious without cluttering the row. Entries
  without a preview get a compact trash icon pinned to their top-right instead.

### v2.0.2 (2026)
- **No stray saved videos** — click-to-save now runs only for channels you've actually added.
  Previously an in-page (SPA) navigation could arm the click listener on a channel you never
  added, so clicking one of its videos silently wrote a stored entry while the popup button
  still read "Add". The enabled state is re-checked on every navigation and when the channel
  is added/removed while the page is open. Covered by `npm run verify:click-save`.
- **Restore refresh** — when the saved video isn't on screen, the page now reloads once and the
  scan runs on the clean result, instead of scanning a page that was already open or scrolled.
  This removes the repeated loading spinners, the scrambled card order, and the extra
  auto-scroll that appeared when restoring without a manual refresh. The reload is recorded in
  `sessionStorage`, so it happens exactly once and cannot loop; a card already on screen is
  scrolled to directly. Restore also runs at most once per page per navigation, so the several
  triggers (initial load, SPA navigation, history) cannot re-scroll or re-scan.
- **Layout names** — the compact layout is now the **Vertical Menu** and the classic layout is
  the **Extended** layout, in both toggle labels and these docs.
- **Bigger compact previews** — the Vertical Menu stored list now leads each entry with a large
  thumbnail, with the video ID beside it and the actions at the right.
- **Extended full-width previews** — the Extended layout's previews now span the panel and sit
  above the text, matching the requested look; the popup scrolls as a single column.
- **Cleaner stored list** — stored entries keep the video ID and the clickable preview but drop
  the full URL line; the address is still one click away via the go-to action.
- **Removed timestamps** — the "last used" time is gone from both layouts.

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
  - **Clearer & safer UI** — tagline in the header, suffix-first URL display, higher text contrast in both themes.

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
