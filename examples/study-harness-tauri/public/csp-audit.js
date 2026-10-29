// Offline audit hooks (native.md N9), loaded as a classic script before the module entry so they cover the whole page
// life: CSP violation events and an app-level request log (the absolute URL origin of every fetch the page issues;
// WKWebView Resource Timing reports nothing for custom-scheme loads). Both are bounded and read-only from module code.
// The host page itself uses no inline script or style.
(function () {
  'use strict';
  var violations = [];
  var requests = [];
  var limit = 128;
  document.addEventListener('securitypolicyviolation', function (event) {
    if (violations.length >= limit) return;
    violations.push({
      violatedDirective: String(event.violatedDirective || ''),
      effectiveDirective: String(event.effectiveDirective || ''),
      blockedURI: String(event.blockedURI || '').slice(0, 200),
      sourceFile: String(event.sourceFile || '').slice(0, 200),
      sample: String(event.sample || '').slice(0, 80),
      disposition: String(event.disposition || ''),
      atMs: Math.round(performance.now()),
    });
  });
  var pageFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      var url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (requests.length < limit) requests.push({ origin: new URL(url, document.baseURI).origin, atMs: Math.round(performance.now()) });
    } catch (error) {
      if (requests.length < limit) requests.push({ origin: 'unparsable', atMs: Math.round(performance.now()) });
    }
    return pageFetch(input, init);
  };
  Object.defineProperty(window, '__referenceHostAudit', {
    value: Object.freeze({ violations: violations, requests: requests, bootedAtMs: Math.round(performance.now()) }),
    configurable: false,
    enumerable: false,
    writable: false,
  });
})();
