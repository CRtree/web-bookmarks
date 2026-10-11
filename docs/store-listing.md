# Chrome Web Store listing copy — v2.0.1

Paste-ready text for the Developer Dashboard → **Store listing** tab.
Keyword edits live in `manifest.json` + `_locales/*/messages.json`; this file holds the
long-form description, which the dashboard stores separately.

---

## Item title

**Not localized — unchanged.**

`manifest.json` hardcodes `"name": "Youtube Scroll Saver"`, so the item is listed as
**Youtube Scroll Saver** in every locale. This is deliberate: renaming would trigger a metadata
re-review and lose the little name recognition the listing has built.

The Chrome Web Store **item title is derived from the extension manifest name.** For search
purposes the title carries the most weight, and yours already contains all three keywords that
matter (`youtube`, `scroll`, `saver`) in a readable order.

> **Optional, not recommended right now.** `_locales/*/messages.json` each carry a translated
> `name` (e.g. `YouTube™ 滚动位置保存`). They are **inactive** until `manifest.json` switches to
> `"name": "__MSG_name__"`. Kept available so the switch is a one-line change if you change
> your mind. `npm run verify:i18n` reports them as inactive.
>
> Note also that `Youtube Scroll Saver` leads with a Google trademark. Google's branding
> guidelines ask for the `Thing for YouTube™` form. Many listings do this anyway and it is
> rarely enforced — but it is a small policy risk to be aware of.

## Item summary (max 132 characters)

Localized via `_locales` (`manifest.json` → `__MSG_description__`). English:

> Save your spot on any YouTube channel. Reopen it and jump straight back to the last video or Short you watched.

> **Fixed in this pass:** the Chinese folder was named `_locales/zh`, which is **not** a valid
> Chrome locale code — Chrome ignored it, so the live listing reported only 4 languages. It is
> now `zh_CN` (plus a new `zh_TW`), verified by `npm run verify:i18n`.
>
> This is the one place where localized keywords genuinely reach non-English searches, since the
> title is fixed.

## Detailed description

Copy everything in the block below into the dashboard description field.

```text
Never lose your place on a YouTube channel again.

Scroll Saver remembers where you were on any YouTube channel and takes you straight back — automatically. Click a video or a Short on a channel, close the tab, come back days later, and the page scrolls itself back to exactly the content you clicked. No more digging through infinite scroll to find the one video you meant to watch.

WHY YOU'LL LOVE IT

• Resume where you left off — your scroll position on every enabled channel is saved and restored automatically.
• Works with videos and Shorts — tracks both /videos and /shorts cards on a channel.
• Video previews — each saved entry shows its YouTube thumbnail and duration at a glance.
• Per-channel control — you decide which channels are remembered, with a single click.
• Fully automatic — after setup it works silently in the background.
• Private by design — everything is stored locally on your device.
• Lightweight — no performance impact, no background processes.

HOW IT WORKS

1. Install the extension.
2. Open a YouTube channel page (any /@handle URL).
3. Click the Scroll Saver icon and press "Add".
4. Click a video or a Short on that channel.
5. Come back to the channel later — Scroll Saver scrolls you right back to it.

To stop remembering a channel, open the popup and press "Stop".

PRIVACY

Scroll Saver stores everything with chrome.storage.local. No accounts, no analytics, no servers, no tracking — your saved positions, channels and settings never leave your browser.

The one outbound request is the video thumbnail on each saved entry, fetched from YouTube's own image CDN (i.ytimg.com). Nothing else leaves your device, and the extension only tracks YouTube channel pages.

PERMISSIONS

• storage — save your scroll positions locally
• activeTab / tabs — show the right channel in the popup
• alarms — schedule local cleanup of old entries
```

---

## Target keyword phrases

Ranking is driven by title match → summary → description, then by
ratings and downloads-vs-uninstalls. Aim at long-tail intent, not single words.

**Realistic targets** (win these first)
- youtube scroll saver
- youtube channel scroll position
- save scroll position youtube
- resume last video youtube channel
- youtube channel resume where you left off
- youtube infinite scroll bookmark
- remember position on youtube channel

**Do not target** — dominated by extensions with millions of users, and the
intent is meaningless: `youtube`, `scroll`, `saver`, `bookmark`.

## Store assets checklist

| Asset | Size | File |
|---|---|---|
| Small promo tile | 440x280 | `marketing-tile-440x280.png` |
| Marquee image | 1400x560 | `marketing-banner-1400x560.png` |
| Screenshot 1 — modern (default), light | 1280x800 | `marketing-screenshot-modern-light-1280x800.png` |
| Screenshot 2 — classic, dark | 1280x800 | `marketing-screenshot-classic-dark-1280x800.png` |
| Screenshot 3 — modern, dark | 1280x800 | `marketing-screenshot-modern-dark-1280x800.png` |
| Screenshot 4 — classic, light | 1280x800 | `marketing-screenshot-classic-light-1280x800.png` |
| Feature card — Prev / Next | 1280x800 | `marketing-feature-watch-nav-1280x800.png` |
| Feature card — Backup / restore | 1280x800 | `marketing-feature-backup-1280x800.png` |

All 640x400 variants are generated alongside the 1280x800 ones; either size is
accepted. Chrome Web Store allows up to **5** screenshots, and there are now **6**
candidates: the four popup screenshots plus the two feature cards. Suggested order:
lead with modern-light, then classic-dark and modern-dark, and close with the Prev /
Next and Backup / restore cards — dropping one popup shot (e.g. classic-light) to fit.
Both feature cards are designed cuts of the real UI — the popup in watch-page mode and
the real import window driven to its success state (`render-popup.js`) — not hand-built
mocks, so they cannot drift from the product.

Regenerate everything with:

```bash
npm run assets
```

Two things to remember:

1. **The small promo tile is a ranking signal.** Google's docs: *"Extensions that
   don't have a small promotional image will be shown after extensions that do have
   that image."* It also appears on the home page, category pages and in search results.
2. **Promo tiles are not locale-specific.** Whatever text is baked into the image is
   shown to every locale, so keep them graphic-led and text-light — the localized
   titles above will not match English text inside a shared image.

### The YouTube brand on the tile

The tile carries the official YouTube lockup in the sanctioned descriptive form:

```
[Scroll Saver mark]  for  [YouTube logo] ™
```

Wording matters here: Google's branding guidelines require "for", "for use with" or
"compatible with" plus the ™ when referencing a Google product. The logo is used
unmodified (white wordmark variant, for dark backgrounds). See
`tools/marketing/assets/README.md` for provenance and the rules to keep following.

Worth being precise about what this buys: the tile's **content does not feed the
search ranking algorithm** — only its *presence* does (see point 1). What the logo
affects is **click-through rate** on the home page, category pages and search
results, which in turn drives installs, which *does* feed ranking indirectly.

## Screenshot rendering notes

`tools/marketing/render-popup.js` renders the real popups rather than hand-built
mocks, so the screenshots cannot drift from the product. Two things it has to work
around:

- **The mock must report the page's own layout.** Otherwise `popup.js` performs its
  (correct) redirect and you silently capture the wrong page. The script now throws
  if it lands somewhere unexpected.
- **`loading="lazy"` does not resolve before a headless paint**, which produced
  screenshots with empty thumbnail boxes. It forces the images eager and waits for
  real bytes before capturing.

The classic popup is portrait (360x689) and a store screenshot must be 640x400, so
it is rendered at native size and composited onto a themed canvas. The modern popup
is natively 640x400 and is captured full-bleed.
