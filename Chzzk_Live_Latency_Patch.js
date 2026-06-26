// ==UserScript==
// @name Chzzk Live Latency Patch
// @namespace chzzk-latency
// @Version 2
// @match https://chzzk.naver.com/*
// @run-at document-start
// @grant none
// ==/UserScript==

(function() {
const origFetch = window.fetch;
const PATTERN = /liveSyncDurationCount:3/g;
const REPLACEMENT = 'liveSyncDurationCount:2';

window.fetch = function(...args) {
const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;

// Narrow the URL match — main bundle only
if (typeof url !== 'string' || !/\/glive\/.*\/main\.[a-f0-9]+\.js$/.test(url)) {
  return origFetch.apply(this, args);
}

return origFetch.apply(this, args).then(async (response) => {
  try {
    const text = await response.clone().text();
    const matches = (text.match(PATTERN) || []).length;

    if (matches === 0) {
      // Fail-loud — make it clearly visible
      console.error('[CHZZK PATCH] FAILED: pattern not found in', url,
                    '— bundle structure may have changed. Patch is INACTIVE.');
      return response;  // return the original response unchanged
    }

    if (matches !== 2) {
      console.warn('[CHZZK PATCH] unexpected hit count:', matches, '(expected 2)');
    }

    console.log('[CHZZK PATCH] applied, hits=' + matches);

    // Preserve original headers
    const newHeaders = new Headers(response.headers);
    return new Response(text.replace(PATTERN, REPLACEMENT), {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  } catch (e) {
    // On any error, return the original response — never break the page
    console.error('[CHZZK PATCH] error, falling back to original:', e);
    return response;
  }
});
};
})();