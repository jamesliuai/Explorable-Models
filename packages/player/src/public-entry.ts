// Preserve existing experiment/embed/capture URLs and downloaded v1 snapshots.
// Only an unqualified visit opens the new composition studio.
const query = new URLSearchParams(location.search);
const legacy = ['experiment', 'embed', 'capture'].some(key => query.has(key))
  || Boolean(document.getElementById('experiment-kit-snapshot'));
if (legacy) await import('./main');
else await import('./agent-gallery');
export {};
