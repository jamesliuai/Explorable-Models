// Loaded as a classic script before the module entry so CSP violations raised while
// the page boots are captured. No inline script is used anywhere in the document.
(function () {
  'use strict';
  var violations = [];
  var limit = 64;
  document.addEventListener('securitypolicyviolation', function (event) {
    if (violations.length >= limit) return;
    violations.push({
      violatedDirective: String(event.violatedDirective || ''),
      effectiveDirective: String(event.effectiveDirective || ''),
      blockedURI: String(event.blockedURI || ''),
      sourceFile: String(event.sourceFile || ''),
      sample: String(event.sample || '').slice(0, 80),
      disposition: String(event.disposition || ''),
      originalPolicy: String(event.originalPolicy || ''),
      atMs: Math.round(performance.now()),
    });
  });
  Object.defineProperty(window, '__spikeEarly', {
    value: Object.freeze({ violations: violations, bootedAtMs: Math.round(performance.now()) }),
    configurable: false,
    enumerable: false,
    writable: false,
  });
})();
