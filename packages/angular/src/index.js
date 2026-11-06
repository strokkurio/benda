/**
 * Loads the Benda overlay from the local bridge (`npx benda bridge`, or `npx benda dev`).
 * Dev mode only – production builds never request the script, and the overlay itself never enters the bundle.
 * `name` is the project name from benda.config.json: a bridge of another project on the same port then refuses to
 * serve the overlay, instead of resolving this app's selections in its own workspace.
 */
export function loadBenda({ port = 4399, name } = {}) {
  // Same check as Angular's isDevMode(). Importing @angular/core here would resolve a second copy through a `file:`
  // link; the CLI's production `define` of ngDevMode still removes this branch.
  if (typeof ngDevMode !== 'undefined' && !ngDevMode) return;
  const script = document.createElement('script');
  script.type = 'module';
  script.src = `http://localhost:${port}/overlay.js${name ? `?name=${encodeURIComponent(name)}` : ''}`;
  script.onerror = () => console.info(`[benda] Bridge not reachable on port ${port} – run "npx benda bridge".`);
  document.head.append(script);
}
