# chzzk-latency

Userscripts to reduce video/chat latency on Chzzk live streams when watching from abroad.

## What this is

Watching Naver's Chzzk live streams from outside Korea (for example, from Germany) comes with significant delay, since the service is served primarily from Korea. Even with a VPN, a noticeable gap remains between the live video and the chat, which makes it hard to follow conversations or react in real time. These userscripts reduce that gap, keeping the video and chat close enough to follow a stream and its chat as it happens.

There are two scripts. They can be used independently, but they are meant to work together.

## Disclaimer

- These are **personal, educational** userscripts that run entirely **client-side**, in your own browser.
- They **do not collect or transmit any data**, and they do not talk to any server of their own.
- They modify how the page behaves on your machine only. They may break at any time if Chzzk changes its site.
- Provided **as-is, with no warranty**. Use at your own discretion.

## How it works

### `Chzzk_Live_Latency_Patch.js`

Chzzk's player ships with a target live-sync setting in its main bundle. This script hooks `window.fetch`, and when the main bundle is requested, rewrites that one setting (`liveSyncDurationCount: 3` → `2`) so the player aims to stay closer to the live edge.

It is written to fail safely:

- It only touches the specific main bundle URL, nothing else.
- If the expected pattern isn't found (e.g. the bundle changed), it logs a clear error and returns the **original** response unchanged. The patch simply goes inactive rather than breaking the page.
- Any error falls back to the original response.

### `_Chzzk_Live_Latency_Inspector.js`

This is the larger of the two. It watches playback health and gently corrects sync drift in real time, instead of making a one-time change.

- Uses a `PerformanceObserver` to track how media segments are loading (duration, failures).
- Runs a small **state machine** with three modes:
  - **NORMAL** — nudges `playbackRate` slightly above 1.0 when the buffer is ahead, to ease back toward the live edge; jumps forward if it falls far behind.
  - **WOBBLE** — pure buffer defense during unstable segment loading; takes no corrective action, just waits it out.
  - **RECOVERY** — a more cautious version of NORMAL after a wobble settles, with hysteresis and cooldowns to avoid over-correcting.
- Shows a small on-screen panel with current mode, how far ahead of live you are, playback rate, stalls, and segment stats.
- Is SPA-aware: it re-attaches when you navigate between live streams, and tears itself down on non-live pages.
- Cleans up fully via `__chzzkInspector.destroy()` (clears timers, disconnects observers, removes UI, resets playback rate).

## Install

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/).
2. Create a new script and paste in the contents of each file (one script each), or add them as separate userscripts.
3. Open a Chzzk live stream. The Inspector's panel should appear, and the patch logs its status to the browser console.

## Design note: what was deliberately left out

An earlier version of the Inspector also overrode `document.visibilityState` / `hidden` to stop the browser from throttling playback when the tab was in the background. It worked, but it had a side effect worth taking seriously: the stream would keep pulling segments at full quality even in a background tab, which on a real platform means consuming CDN bandwidth for a stream nobody is actively watching.

For a personal tool that one person runs, the impact is negligible. But a script that is published for others to use is a different thing: at any scale, that behavior shifts cost onto the platform for traffic it would normally be able to shed. Since the whole point here is a lightweight, client-side latency fix, that trade-off wasn't worth it, so the visibility override is intentionally not part of this version. The latency handling does not depend on it.

## Limitations

- Tested only in personal use, on one setup. Behavior will vary with network conditions and VPN routing.
- Tied to Chzzk's current page and bundle structure; expect it to break when the site changes.
- The Patch depends on a specific string in the main bundle. If that changes, the patch goes inactive (by design) and you'll see an error in the console.

## License

Do whatever you like with this. No warranty of any kind.
