# Research: "Next 5 videos" from a YouTube channel video

**Question:** while watching a video, can we surface the next 5–10 videos from that
channel (the ones that follow it in the channel's list) so users don't have to scroll
a long channel page? Add a "Next" button in the popup.

**Verdict: yes — highly feasible.** The hard part (finding a video's position in a
long channel list) can be solved with **one network request**, not by scrolling or
paging the whole channel. Live tests below.

---

## 1. What "next" means (define first)

YouTube's channel **Videos** tab is sorted **newest → oldest**, and the same order is
used by the channel's hidden **uploads playlist** (`UU…`). So "the next video" from the
one you're watching is the one **below it in the list = the next older upload**.

Two buttons are possible and cheap to provide:

- **Next (older)** — item at `currentIndex + 1` (the common binge case)
- **Previous / Newer** — item at `currentIndex - 1`

Decide the default; both come from the same data.

---

## 2. Three ways to get the data

| Route | Requests to find position | Key/OAuth | Sanctioned | Fragility |
|---|---|---|---|---|
| **A. Inner API `youtubei/v1/next`** | **1** | no (public WEB key) | ✗ undocumented | medium |
| **B. YouTube Data API v3 `playlistItems.list`** | up to `N/50` | API key or OAuth | ✓ | low |
| **C. Channel-page DOM scraping** | requires scrolling | no | ✓ | high |

### Route A — the key discovery

YouTube's watch page calls `POST https://www.youtube.com/youtubei/v1/next` with
`{ context, videoId, playlistId }`. If `playlistId` is the channel's uploads playlist,
the response contains the **playlist panel**, which includes:

- `currentIndex` — the video's **absolute position** in the channel's uploads list
- a window of ~99 ordered playlist entries (usually **20 before / 78 after** the current
  video), each with `videoId`, title, duration (`lengthText`), thumbnail, byline

That single response is exactly the "next 5–10" data.

**Deriving the uploads playlist id:** `UU` + `channelId.slice(2)`.
The `channelId` can be read from the watch page (`<meta itemprop="channelId">`,
`ytInitialPlayerResponse.videoDetails.channelId` via a main-world script), or from a
`videoId`-only `/next` call whose `videoOwnerRenderer.browseId` is the channel id.

### Route B — the compliant fallback

`youtube.com/youtube-docs` Data API v3 `playlistItems.list(playlistId=UU…,
maxResults=50, pageToken=…)` returns 50 items/page at **1 quota unit** per call
(10,000 units/day free). Items carry `snippet.position`, so once the current video is
found, the following items are the "next" videos. Downside: you must page from the top
to locate the video (`N/50` requests) and you must ship a key (abuse risk) or use OAuth
(consent friction). Best offered as an **optional "use official API with my key"**
setting for users who want a store-safe path.

### Route C — no good

`ytInitialData` on a channel page only contains the first ~30 cards, and the page is
infinite-scroll, so it can't give "next to video X" without scrolling. This is the
behavior Scroll Saver already has (`progressiveScanForVideo`).

---

## 3. Live proof (measured, not theoretical)

Against a real channel (`@RickAstleyYT`, uploads playlist `UUuAXFkgsw1L7xaCfnd5JJOw`):

| Test | Result |
|---|---|
| Channel Videos tab continuation (`browse`) | 30 videos/request, chained token, ~0.4–1.4 s |
| **Uploads playlist `browse` (`VL…`)** | **100 videos/request**, ~0.5 s, ~1.1 MB |
| **`next` with `videoId` + `playlistId`** | **`currentIndex` + 99-item panel, 1 request** |
| Deep video | `currentIndex=295`, 78 videos after ✓ |
| Newest video | `currentIndex=8`, 78 after ✓ |
| Short | `currentIndex=297`, 78 after ✓ |
| Unrelated video + wrong playlist | panel returned but `after=0` → **must validate** |

Sample parse (the "next 5" from one call):

```
currentIndex = 295   (1-based position in the uploads playlist)
#1 -2BFZsiVejU  3:13  Rick Astley - Waterfall (Official Audio)
#2 DPEVpQYJYRo  0:13  Tomorrow is the day! 🕺 #AreWeThereYet?
#3 h7zuap1LFGI  1:00  Had a very exciting delivery today...
#4 y2h8UvvGkEM  0:25  Tickets to come to the album launch show...
#5 udpWpkBoy1w  0:23  There's just 6 days to go till 'Are We There...
```

Response size is ~0.9 MB because `/next` also returns comments, recommendations, etc.
Parse only `contents.twoColumnWatchNextResults.playlist.playlist` and cache per `videoId`.

---

## 4. How it fits Scroll Saver

The current extension already:

- injects `content.js` on YouTube and detects channel pages (`isYouTubeChannelPage`)
- saves `videoId` on click, and scrolls back via `progressiveScanForVideo`
- stores entries as `yt_position_<normalizedUrl>` and routes messages through
  `background.js` (`get_positions`, `clear_position`, …)
- renders saved thumbnails/links in `popup.html` / `popup-classic.html`

Adding "next videos" is mostly additive:

1. `content.js`: also detect watch pages (`/watch`, `/shorts/<id>`). Read the URL's
   `v`/`list` and resolve `channelId`; call `/next` (same-origin, so no CORS work).
2. `background.js`: new message actions `get_next_videos` / cache read-write. Use
   `chrome.storage.local` (`yt_next_<videoId>`) since the service worker is ephemeral.
   Cache TTL ~1 day; the channel list changes slowly.
3. `popup.js` + both popups: a "Next up" strip of 5–10 thumbnail cards; clicking calls
   `chrome.tabs.update(tabId, {url})` to play in place (not a new tab).
4. Optional in-page overlay next to the player for one-click "Next" without opening the
   popup. Could reuse the existing injected-UI patterns.

If the watch URL has `?list=…`, pass that `list` as the `playlistId` instead of `UU…`,
which generalizes the feature to any playlist.

---

## 5. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **YouTube ToS / Chrome Web Store policy** (automated access via private API; store requires compliance with site ToS) | **High** | Make Route A the default but document it; offer Route B (user's own Data API key) as a compliant option. Narrow `host_permissions` from `<all_urls>` to `*://*.youtube.com/*`. |
| Undocumented schema changes (e.g., `videoRenderer` → `lockupViewModel` migration already observed) | Medium | Defensive parsing + graceful "unavailable" state; keep Route B fallback. |
| Wrong/absent position when video isn't in the playlist | Medium | Validate: the panel's selected item `videoId` must equal the requested id and `after > 0`; else hide the section. |
| Shorts mixed into the uploads playlist, so "next" may jump to a Short | Medium | Filter by `lengthText ≤ 60s` when the user wants long-form; the channel **Videos** tab excludes Shorts. |
| Rate limiting (429 observed on raw watch-page HTML) | Low | 1 request/video + cache; back off and degrade silently. |
| Privacy claim in README ("only outbound request is the thumbnail") | Low | Update copy; the only new calls go to youtube.com, same origin as the page. |
| Playlists, collabs, unlisted, members-only, premieres | Low | `list=` param covers playlists; unlisted videos simply aren't in `UU`; validate and fall back. |

---

## 6. Recommended MVP

1. Watch-page detection + `channelId` resolution.
2. One `/next` call → validate → cache `{ currentIndex, items[] }` per `videoId`.
3. Popup "Next up" row with the next 5 (thumbnail + title + duration).
4. Click → play in the same tab.
5. Toggle: "Include Shorts" (default off) and "Compliant mode (my YouTube API key)".

Estimated effort: ~1–2 days for the Inner-API MVP; +1 day for the Data API fallback and
options UI.

---

## 7. Decisions needed

1. **Next = older (below in list), newer (above), or both buttons?**
2. **Popup only, in-page overlay, or side panel?**
3. **Shorts included or filtered?**
4. **Accept the Inner-API ToS risk, or make the official Data API the default?**
5. **Cache scope** — per video, per channel, or both (per channel is more reusable).
