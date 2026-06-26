// ==UserScript==
// @name         Chzzk Live Latency Inspector
// @namespace    chzzk-inspector
// @version      8
// @description  Buffer-preserving wobble defense + recovery state machine for chzzk live streams
// @match        https://chzzk.naver.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

// === Chzzk Live Latency Inspector (v8) ===
//
// Changes from v7:
//   - WOBBLE re-entry false positive fix: avg-dur trigger respects 8s grace after wobble exit,
//     while super-long segments (>5000ms) and segment failures bypass the grace (real signals).
//   - RECOVERY.jumpCooldown: 30s → 15s. Allows second jump on large spikes that v7 couldn't
//     recover from quickly (observed in real session: ahead 4 → 12 stuck for 17s).
//   - Tampermonkey conversion: SPA-aware bootstrap polls for video element on load and
//     handles client-side navigation between live streams.
//
// Tested observations from v7 sessions that motivated the fixes:
//   - Wobble cycle "WOBBLE → RECOVERY → WOBBLE (avg dur 2444ms over 8 segs)" — the second
//     entry was triggered by lingering bad segments in the rolling window, not a real wobble.
//   - After 8000ms super-long segment, RECOVERY single jump brought ahead 12 → 4, but next
//     jump was blocked by 30s cooldown while ahead grew back to 12. v8 unblocks at 15s.

(() => {
  'use strict';

  // ─── Constants ─────────────────────────────────────────────
  const NORMAL = {
    threshold: 1.5,
    gain: 0.04,
    maxRate: 1.25,
    jumpThreshold: 12,
    jumpCooldown: 5000,
    jumpLandingOffset: 2.5,
  };
  const RECOVERY = {
    threshold: 0.5,
    gain: 0.06,
    maxRate: 1.30,
    jumpThreshold: 8,
    jumpCooldown: 15000,         // v8: 30000 → 15000
    jumpLandingOffset: 4.0,
    durationMs: 30000,
  };
  // WOBBLE has no actions — pure buffer defense.

  const WOBBLE_ENTRY_AVG_DUR = 1400;
  const WOBBLE_ENTRY_SUPER_LONG = 5000;
  const WOBBLE_EXIT_HEALTHY_DUR = 1200;
  const WOBBLE_EXIT_HYSTERESIS = 5;
  const WOBBLE_EXIT_GRACE_MS = 8000;   // v8: new — grace for avg-dur re-entry only

  // ─── Inspector lifecycle ───────────────────────────────────
  // Each call to startInspector() creates a fresh inspector instance bound to a specific
  // video element. Necessary because chzzk recreates the player on stream changes.
  const startInspector = (v) => {
    if (window.__chzzkInspector) window.__chzzkInspector.destroy();

    // ─── State ───────────────────────────────────────────────
    const state = {
      enabled: true,
      sessionStart: Date.now(),

      currentMode: 'NORMAL',
      modeEnteredAt: Date.now(),
      healthyStreak: 0,
      wobbleExitTime: 0,           // v8: timestamp of last WOBBLE → RECOVERY transition

      lastJumpAt: 0,

      modeTransitions: [],
      jumpHistory: [],
      underrunEvents: [],
      aheadHistory: { NORMAL: [], WOBBLE: [], RECOVERY: [] },
      rateHistory: { NORMAL: [], WOBBLE: [], RECOVERY: [] },

      segmentTimings: [],
      stalls: 0,
      stallTimes: [],

      timeAtCap: 0,
      lastTickAt: Date.now(),
      lastReadyState: v.readyState,
    };

    const recordTransition = (from, to, reason, ahead) => {
      state.modeTransitions.push({
        ts: Date.now(),
        from, to, reason,
        ahead: +ahead.toFixed(2),
      });
      if (state.modeTransitions.length > 200) state.modeTransitions.shift();
      state.currentMode = to;
      state.modeEnteredAt = Date.now();
      // v8: track wobble exit time for grace period in detectWobbleEntry
      if (from === 'WOBBLE' && to === 'RECOVERY') {
        state.wobbleExitTime = Date.now();
      }
      console.log(`[Chzzk v8] mode: ${from} → ${to} (${reason}, ahead=${ahead.toFixed(2)}s)`);
    };

    // ─── Observers ───────────────────────────────────────────
    const segObs = new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        if (/\.m3u8|\.ts|\.m4s|\.mp4|hls|playlist|manifest/i.test(e.name)) {
          state.segmentTimings.push({
            dur: Math.round(e.duration),
            ts: Date.now(),
            size: e.transferSize || 0,
          });
          if (state.segmentTimings.length > 300) state.segmentTimings.shift();
        }
      }
    });
    segObs.observe({ entryTypes: ['resource'] });

    const onStall = () => {
      state.stalls++;
      state.stallTimes.push(Date.now());
      const cutoff = Date.now() - 5 * 60 * 1000;
      while (state.stallTimes.length && state.stallTimes[0] < cutoff) state.stallTimes.shift();
    };
    v.addEventListener('waiting', onStall);
    v.addEventListener('stalled', onStall);

    // ─── Wobble detection (v8) ───────────────────────────────
    // Critical fix: avg-dur trigger respects grace period after a WOBBLE → RECOVERY transition,
    // because the rolling window of 8 segments still contains bad segments from the just-ended
    // wobble. Super-long segments and explicit failures bypass the grace — these are real signals
    // of a new wobble, not residue from the old one.
    const detectWobbleEntry = () => {
      const recent = state.segmentTimings.slice(-8);
      if (recent.length < 3) return null;

      const last = recent[recent.length - 1];

      // Bypass grace — real new wobble signal
      if (last.dur > WOBBLE_ENTRY_SUPER_LONG) {
        return `super-long segment (${last.dur}ms)`;
      }

      const last3 = recent.slice(-3);
      const failures = last3.filter(s => s.size === 0).length;
      if (failures >= 2) {
        return `${failures} segment failures in last 3`;
      }

      // Avg-dur respects grace
      const inGrace = (Date.now() - state.wobbleExitTime) < WOBBLE_EXIT_GRACE_MS;
      if (!inGrace && recent.length >= 8) {
        const avg = recent.reduce((a, b) => a + b.dur, 0) / recent.length;
        if (avg > WOBBLE_ENTRY_AVG_DUR) {
          return `avg dur ${Math.round(avg)}ms over 8 segs`;
        }
      }

      return null;
    };

    const checkWobbleExit = () => {
      const last = state.segmentTimings[state.segmentTimings.length - 1];
      if (!last) return false;
      if (last.dur < WOBBLE_EXIT_HEALTHY_DUR && last.size > 0) {
        state.healthyStreak++;
      } else {
        state.healthyStreak = 0;
      }
      return state.healthyStreak >= WOBBLE_EXIT_HYSTERESIS;
    };

    // ─── UI ──────────────────────────────────────────────────
    const style = document.createElement('style');
    style.id = 'ci-styles';
    style.textContent = `
      .ci-btn {
        font: 11px ui-monospace, monospace !important;
        color: #fff !important; background: #222 !important;
        border: 1px solid #555 !important; border-radius: 4px !important;
        padding: 4px 8px !important; cursor: pointer !important;
        transition: background 0.1s, border-color 0.1s !important;
      }
      .ci-btn:hover { background: #333 !important; border-color: #888 !important; }
      .ci-btn:active { background: #111 !important; }
      .ci-btn.ci-on {
        background: #064 !important; border-color: #0f8 !important;
        color: #afa !important; box-shadow: 0 0 6px rgba(0,255,136,0.4) !important;
      }
      .ci-flash { animation: ci-flash 0.6s ease-out; }
      @keyframes ci-flash {
        0% { background: #f55; box-shadow: 0 0 12px #f55; }
        100% { background: rgba(0,0,0,0.88); box-shadow: 0 4px 24px rgba(0,0,0,0.5); }
      }
      .ci-mode-NORMAL { color: #0f0; }
      .ci-mode-WOBBLE { color: #fa0; font-weight: bold; }
      .ci-mode-RECOVERY { color: #f88; font-weight: bold; }
    `;
    document.head.appendChild(style);

    const ui = document.createElement('div');
    ui.id = 'ci-overlay';
    ui.style.cssText = `
      position: fixed; top: 16px; right: 16px; z-index: 2147483647;
      background: rgba(0,0,0,0.88); color: #0f0;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
      padding: 10px 12px; border-radius: 8px; min-width: 320px;
      border: 1px solid #0f0; box-shadow: 0 4px 24px rgba(0,0,0,0.5);
      user-select: text;
    `;
    document.body.appendChild(ui);

    ui.innerHTML = `
      <div style="color:#fff;font-weight:bold;margin-bottom:6px">Chzzk Latency Inspector v8</div>
      <div style="color:#9cf;font-size:10px;margin-bottom:4px">buffer-first defense</div>
      <div>mode        : <span id="ci-mode" class="ci-mode-NORMAL">NORMAL</span> <span id="ci-mode-time" style="color:#888;font-size:10px"></span></div>
      <div>currentTime : <span id="ci-ct">—</span></div>
      <div>buffer.end  : <span id="ci-be">—</span></div>
      <div>ahead       : <span id="ci-ah" style="font-weight:bold">—</span></div>
      <div>rate        : <span id="ci-rr">1.00x</span></div>
      <div>stalls      : <span id="ci-st">0</span> tot / <span id="ci-sr" style="font-weight:bold">0.0</span>/min</div>
      <div>jumps       : <span id="ci-aj">0</span></div>
      <div>underruns   : <span id="ci-un">0</span></div>
      <div>healthy seg : <span id="ci-hs">0</span> streak</div>
      <div style="margin-top:4px;color:#9cf">segments(8): <span id="ci-seg">—</span></div>
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
        <button class="ci-btn ci-on" id="ci-toggle">⚡ enabled</button>
        <button class="ci-btn" id="ci-jump">⏭ jump</button>
      </div>
      <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap">
        <button class="ci-btn" id="ci-analysis">📊 analysis</button>
        <button class="ci-btn" id="ci-dump">📋 dump</button>
        <button class="ci-btn" id="ci-stop">✕ stop</button>
      </div>
    `;

    const $ = id => ui.querySelector('#' + id);
    const fmt = n => Number.isFinite(n) ? n.toFixed(2) : '—';

    $('ci-jump').onclick = () => {
      if (v.buffered.length) {
        v.currentTime = v.buffered.end(v.buffered.length - 1) - NORMAL.jumpLandingOffset;
      }
    };
    $('ci-toggle').onclick = () => {
      state.enabled = !state.enabled;
      const btn = $('ci-toggle');
      btn.textContent = state.enabled ? '⚡ enabled' : '⚡ disabled';
      btn.classList.toggle('ci-on', state.enabled);
      if (!state.enabled) v.playbackRate = 1.0;
    };

    const printAnalysis = () => {
      const now = Date.now();
      const sessionMs = now - state.sessionStart;
      const sessionMin = sessionMs / 60000;

      const modeTime = { NORMAL: 0, WOBBLE: 0, RECOVERY: 0 };
      let prevTs = state.sessionStart;
      let prevMode = 'NORMAL';
      for (const t of state.modeTransitions) {
        modeTime[prevMode] += (t.ts - prevTs);
        prevTs = t.ts;
        prevMode = t.to;
      }
      modeTime[prevMode] += (now - prevTs);

      const stats = mode => {
        const a = state.aheadHistory[mode];
        if (!a.length) return null;
        const sorted = [...a].sort((x, y) => x - y);
        return {
          n: a.length,
          avg: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2),
          p50: +sorted[Math.floor(sorted.length * 0.5)].toFixed(2),
          p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
          max: +Math.max(...a).toFixed(2),
        };
      };

      const rateAvg = mode => {
        const r = state.rateHistory[mode];
        if (!r.length) return null;
        return +(r.reduce((x, y) => x + y, 0) / r.length).toFixed(3);
      };

      const recent = state.segmentTimings.slice(-30);
      const segDurAvg = recent.length ? Math.round(recent.reduce((a, b) => a + b.dur, 0) / recent.length) : 0;
      const segFailRate = recent.length ? +(recent.filter(s => s.size === 0).length / recent.length * 100).toFixed(1) : 0;

      const wobbles = state.modeTransitions.filter(t => t.to === 'WOBBLE');
      const recoveries = state.modeTransitions.filter(t => t.to === 'RECOVERY');

      const lines = [
        '=== Chzzk Inspector v8 — Session Analysis ===',
        `Session: ${sessionMin.toFixed(1)} min (${new Date(state.sessionStart).toISOString()} → ${new Date(now).toISOString()})`,
        ``,
        `--- Mode time distribution ---`,
        `  NORMAL   : ${(modeTime.NORMAL / 1000).toFixed(0)}s (${(modeTime.NORMAL / sessionMs * 100).toFixed(1)}%)`,
        `  WOBBLE   : ${(modeTime.WOBBLE / 1000).toFixed(0)}s (${(modeTime.WOBBLE / sessionMs * 100).toFixed(1)}%)`,
        `  RECOVERY : ${(modeTime.RECOVERY / 1000).toFixed(0)}s (${(modeTime.RECOVERY / sessionMs * 100).toFixed(1)}%)`,
        ``,
        `--- Mode events ---`,
        `  Wobble entries  : ${wobbles.length}`,
        `  Recovery starts : ${recoveries.length}`,
        `  Jumps           : ${state.jumpHistory.length}`,
        `  Underruns       : ${state.underrunEvents.length}`,
        `  Stalls (waiting): ${state.stalls}`,
        ``,
        `--- Ahead distribution by mode (seconds) ---`,
      ];
      for (const m of ['NORMAL', 'WOBBLE', 'RECOVERY']) {
        const s = stats(m);
        if (s) lines.push(`  ${m.padEnd(8)}: avg ${s.avg}, p50 ${s.p50}, p95 ${s.p95}, max ${s.max} (n=${s.n})`);
        else lines.push(`  ${m.padEnd(8)}: no data`);
      }
      lines.push('');
      lines.push(`--- Avg playback rate by mode ---`);
      for (const m of ['NORMAL', 'WOBBLE', 'RECOVERY']) {
        const r = rateAvg(m);
        lines.push(`  ${m.padEnd(8)}: ${r !== null ? r + 'x' : 'no data'}`);
      }
      lines.push('');
      lines.push(`--- Recent segment quality (last 30) ---`);
      lines.push(`  avg dur     : ${segDurAvg}ms`);
      lines.push(`  failure rate: ${segFailRate}%`);
      lines.push('');
      lines.push(`--- Wobble events (most recent 5) ---`);
      const recentWobbles = wobbles.slice(-5);
      for (const w of recentWobbles) {
        const idx = state.modeTransitions.indexOf(w);
        const next = state.modeTransitions[idx + 1];
        const dur = next ? ((next.ts - w.ts) / 1000).toFixed(1) + 's' : 'ongoing';
        lines.push(`  [${new Date(w.ts).toLocaleTimeString()}] ${w.reason}, lasted ${dur}, entry ahead=${w.ahead}s`);
      }
      lines.push('');
      lines.push(`--- Jump events (most recent 5) ---`);
      const recentJumps = state.jumpHistory.slice(-5);
      for (const j of recentJumps) {
        lines.push(`  [${new Date(j.ts).toLocaleTimeString()}] mode=${j.mode}, ahead=${j.ahead}s → landed at ${j.landed.toFixed(1)}s`);
      }
      lines.push('');
      lines.push(`--- Underrun events (most recent 3) ---`);
      const recentUnderruns = state.underrunEvents.slice(-3);
      for (const u of recentUnderruns) {
        lines.push(`  [${new Date(u.ts).toLocaleTimeString()}] mode=${u.mode}, ahead=${u.ahead.toFixed(2)}s, currentTime=${u.currentTime.toFixed(1)}s`);
      }

      const text = lines.join('\n');
      console.log(text);

      window.__chzzkLastAnalysis = {
        sessionStart: state.sessionStart,
        sessionEnd: now,
        sessionMs,
        modeTime,
        modeTransitions: state.modeTransitions,
        jumpHistory: state.jumpHistory,
        underrunEvents: state.underrunEvents,
        aheadStats: {
          NORMAL: stats('NORMAL'),
          WOBBLE: stats('WOBBLE'),
          RECOVERY: stats('RECOVERY'),
        },
        rateAvg: {
          NORMAL: rateAvg('NORMAL'),
          WOBBLE: rateAvg('WOBBLE'),
          RECOVERY: rateAvg('RECOVERY'),
        },
        segDurAvg,
        segFailRate,
        stalls: state.stalls,
        wobbleEntries: wobbles.length,
        recoveryStarts: recoveries.length,
        lastSegments: state.segmentTimings.slice(-30),
      };
      console.log('Full JSON: copy(JSON.stringify(__chzzkLastAnalysis, null, 2))');
      return text;
    };
    $('ci-analysis').onclick = printAnalysis;

    $('ci-dump').onclick = () => {
      const dump = {
        time: new Date().toISOString(),
        url: location.href,
        currentMode: state.currentMode,
        video: {
          currentTime: v.currentTime,
          ahead: v.buffered.length ? v.buffered.end(v.buffered.length-1) - v.currentTime : 0,
          playbackRate: v.playbackRate,
          readyState: v.readyState,
          networkState: v.networkState,
        },
        stalls: state.stalls,
        modeTransitions: state.modeTransitions.slice(-30),
        jumpHistory: state.jumpHistory.slice(-20),
        underrunEvents: state.underrunEvents.slice(-10),
        recentSegments: state.segmentTimings.slice(-30),
      };
      window.__chzzkLastDump = dump;
      console.log('=== Chzzk v8 dump ===', dump);
      console.log('Copy: copy(JSON.stringify(__chzzkLastDump, null, 2))');
    };
    $('ci-stop').onclick = () => window.__chzzkInspector.destroy();

    // ─── Main loop ───────────────────────────────────────────
    const tick = () => {
      if (!state.enabled) return;

      const n = v.buffered.length;
      const bufEnd = n ? v.buffered.end(n-1) : 0;
      const ahead = n ? bufEnd - v.currentTime : 0;
      const now = Date.now();
      const dt = now - state.lastTickAt;
      state.lastTickAt = now;
      const stallsLastMin = state.stallTimes.filter(t => t > now-60000).length;

      // Underrun detection
      if (state.lastReadyState >= 2 && v.readyState < 2 && ahead < 1) {
        state.underrunEvents.push({
          ts: now,
          ahead,
          mode: state.currentMode,
          currentTime: v.currentTime,
          bufEnd,
        });
        if (state.underrunEvents.length > 50) state.underrunEvents.shift();
        console.log(`[Chzzk v8] BUFFER UNDERRUN: ahead=${ahead.toFixed(2)}, mode=${state.currentMode}`);
      }
      state.lastReadyState = v.readyState;

      // Mode state machine
      if (state.currentMode === 'NORMAL') {
        const reason = detectWobbleEntry();
        if (reason) {
          recordTransition('NORMAL', 'WOBBLE', reason, ahead);
          state.healthyStreak = 0;
        }
      } else if (state.currentMode === 'WOBBLE') {
        if (checkWobbleExit()) {
          recordTransition('WOBBLE', 'RECOVERY', 'healthy streak reached', ahead);
          state.healthyStreak = 0;
        }
      } else if (state.currentMode === 'RECOVERY') {
        const wobbleReason = detectWobbleEntry();
        if (wobbleReason) {
          recordTransition('RECOVERY', 'WOBBLE', `wobble recurrence: ${wobbleReason}`, ahead);
          state.healthyStreak = 0;
        } else if (now - state.modeEnteredAt > RECOVERY.durationMs && ahead < NORMAL.threshold) {
          recordTransition('RECOVERY', 'NORMAL', 'recovery complete', ahead);
        } else if (now - state.modeEnteredAt > RECOVERY.durationMs * 2) {
          recordTransition('RECOVERY', 'NORMAL', 'recovery timeout', ahead);
        }
      }

      // Action by mode
      let targetRate = 1.0;
      const mode = state.currentMode;

      if (mode === 'NORMAL') {
        if (ahead < NORMAL.threshold) {
          targetRate = 1.0;
        } else {
          targetRate = Math.min(NORMAL.maxRate, 1.0 + ahead * NORMAL.gain);
        }
        if (
          ahead > NORMAL.jumpThreshold &&
          now - state.lastJumpAt > NORMAL.jumpCooldown &&
          n > 0
        ) {
          v.currentTime = bufEnd - NORMAL.jumpLandingOffset;
          state.lastJumpAt = now;
          state.jumpHistory.push({
            ts: now, ahead: +ahead.toFixed(2), mode: 'NORMAL', landed: NORMAL.jumpLandingOffset,
          });
          if (state.jumpHistory.length > 100) state.jumpHistory.shift();
          ui.classList.remove('ci-flash'); void ui.offsetWidth; ui.classList.add('ci-flash');
        }
      } else if (mode === 'WOBBLE') {
        targetRate = 1.0;
      } else if (mode === 'RECOVERY') {
        if (ahead < RECOVERY.threshold) {
          targetRate = 1.0;
        } else {
          targetRate = Math.min(RECOVERY.maxRate, 1.0 + ahead * RECOVERY.gain);
        }
        if (
          ahead > RECOVERY.jumpThreshold &&
          now - state.lastJumpAt > RECOVERY.jumpCooldown &&
          n > 0
        ) {
          v.currentTime = bufEnd - RECOVERY.jumpLandingOffset;
          state.lastJumpAt = now;
          state.jumpHistory.push({
            ts: now, ahead: +ahead.toFixed(2), mode: 'RECOVERY', landed: RECOVERY.jumpLandingOffset,
          });
          if (state.jumpHistory.length > 100) state.jumpHistory.shift();
          ui.classList.remove('ci-flash'); void ui.offsetWidth; ui.classList.add('ci-flash');
        }
      }

      v.playbackRate = targetRate;

      // Record stats
      state.aheadHistory[mode].push(ahead);
      state.rateHistory[mode].push(targetRate);
      for (const k of Object.keys(state.aheadHistory)) {
        if (state.aheadHistory[k].length > 5000) state.aheadHistory[k].shift();
        if (state.rateHistory[k].length > 5000) state.rateHistory[k].shift();
      }

      // UI update
      const modeEl = $('ci-mode');
      modeEl.textContent = mode;
      modeEl.className = 'ci-mode-' + mode;
      $('ci-mode-time').textContent = `(${Math.round((now - state.modeEnteredAt) / 1000)}s)`;
      $('ci-ct').textContent = fmt(v.currentTime);
      $('ci-be').textContent = fmt(bufEnd);
      const ahEl = $('ci-ah');
      ahEl.textContent = fmt(ahead) + 's';
      ahEl.style.color = ahead > 5 ? '#f55' : ahead > 3 ? '#fa0' : '#0f0';
      $('ci-rr').textContent = `${v.playbackRate.toFixed(2)}x`;
      $('ci-st').textContent = state.stalls;
      const srEl = $('ci-sr');
      srEl.textContent = stallsLastMin.toFixed(1);
      srEl.style.color = stallsLastMin >= 2 ? '#f55' : stallsLastMin >= 1 ? '#fa0' : '#0f0';
      $('ci-aj').textContent = state.jumpHistory.length;
      $('ci-un').textContent = state.underrunEvents.length;
      $('ci-hs').textContent = state.healthyStreak;

      const recent = state.segmentTimings.slice(-8);
      const avgDl = recent.length ? Math.round(recent.reduce((a,b)=>a+b.dur,0)/recent.length) : 0;
      const maxDl = recent.length ? Math.max(...recent.map(r=>r.dur)) : 0;
      const fails = recent.filter(s => s.size === 0).length;
      $('ci-seg').textContent = `avg ${avgDl}ms / max ${maxDl}ms${fails ? ` / ${fails} fail` : ''}`;
    };

    const intervalId = setInterval(tick, 500);
    tick();

    // ─── Cleanup ─────────────────────────────────────────────
    window.__chzzkInspector = {
      destroy() {
        clearInterval(intervalId);
        try { segObs.disconnect(); } catch {}
        try { v.removeEventListener('waiting', onStall); } catch {}
        try { v.removeEventListener('stalled', onStall); } catch {}
        try { ui.remove(); } catch {}
        try { document.getElementById('ci-styles')?.remove(); } catch {}
        try { v.playbackRate = 1.0; } catch {}
        delete window.__chzzkInspector;
      },
      state, printAnalysis,
    };

    console.log('Chzzk Inspector v8 loaded.');
    console.log('  Modes: NORMAL ⇄ WOBBLE → RECOVERY → NORMAL');
    console.log('  v8 changes: wobble re-entry grace 8s | RECOVERY cooldown 15s | userscript');
    console.log('  📊 Click "analysis" or run __chzzkInspector.printAnalysis()');
    console.log('  Stop: __chzzkInspector.destroy()');
  };

  // ─── v8: SPA-aware bootstrap ───────────────────────────────
  // Tampermonkey runs this once at page document-end. On chzzk:
  //   - First load: video element may not exist yet (SPA hydration). Poll.
  //   - SPA navigation between live streams: URL changes without reload, video element
  //     may be replaced. Detect URL change, tear down old inspector, re-attach to new video.
  //   - Navigation to non-live page: tear down, don't re-attach (resource cleanup).

  const isLivePage = () => /^\/live\//.test(location.pathname);

  const tryAttach = () => {
    if (!isLivePage()) return false;
    if (window.__chzzkInspector) return true;  // already attached
    const v = document.querySelector('video');
    if (!v) return false;
    startInspector(v);
    return true;
  };

  // Poll for video element on initial load (max 30s)
  let initAttempts = 0;
  const initPoll = setInterval(() => {
    if (tryAttach() || ++initAttempts > 60) {
      clearInterval(initPoll);
    }
  }, 500);

  // SPA navigation watcher
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;

    // Tear down existing inspector — new page, possibly new video element
    if (window.__chzzkInspector) {
      window.__chzzkInspector.destroy();
    }

    if (isLivePage()) {
      // Re-poll for new video element (max 15s)
      let attempts = 0;
      const reattachPoll = setInterval(() => {
        if (tryAttach() || ++attempts > 30) {
          clearInterval(reattachPoll);
        }
      }, 500);
    }
  }, 1500);
})();
