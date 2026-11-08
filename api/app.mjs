// api/app.mjs — Vercel serverless entry for every /api/* route.
//
// Plotline's core is one Node req/res handler extracted from createApp, so the
// long-running `node server/server.mjs` server and this function share identical
// routing logic. The caveats of this shape are stated up front, honestly:
//
//   • The demo registry (ledger, serials, verifiers, orders) lives in files under
//     DATA_DIR. On Vercel that is /tmp of ONE instance: state survives requests
//     for that instance's lifetime, but instance recycling starts a fresh
//     registry, and concurrent cold instances can briefly diverge. Fine for a
//     public demo; farmer phones always keep their own records regardless.
//   • The Redis read-through cache is skipped (none on the platform); every
//     read hits its source, which is what the cache layer is built to allow.
//   • Neon Realtime stays a browser-to-Neon connection: the server only seals
//     capabilities here (a normal POST), so no WebSocket listener is needed.
//   • Static surfaces (landing, app shell, console, service worker) are served
//     straight from Vercel's static layer — only this catch-all needsCompute.

import { join } from 'node:path';

const DATA_DIR = process.env.DATA_DIR || '/tmp/plotline-data';

let appPromise = null;
const getApp = () => appPromise || (appPromise = (async () => {
  // No Redis on the platform: the cache layer treats null as "always miss", so the
  // app is strictly correct either way — just uncached.
  const { createApp } = await import('../server/server.mjs');
  return createApp({ dataDir: DATA_DIR, cache: null });
})());

// The original path: the vercel.json rewrite lands every /api/* request on
// /api/app.mjs, so the platform-reported URL is not the route the client asked
// for. The rewrite carries the original path in a query param; keep the two
// fallbacks for direct invocations and other rewriters.
const pathOf = (req) => {
  const url = new URL(req.url || '/', 'http://x');
  const viaQuery = url.searchParams.get('__path');
  if (viaQuery) return decodeURIComponent(viaQuery);
  const viaHeader = req.headers?.['x-matched-path'];
  if (typeof viaHeader === 'string' && viaHeader) return viaHeader.split('?')[0];
  return url.pathname;
};

export default async function handler(req, res) {
  const app = await getApp();
  const path = pathOf(req);
  if (!path.startsWith('/api/')) {
    // Belt and braces: the platform should never route a non-API path here.
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  return app.handle(req, res, path);
}
