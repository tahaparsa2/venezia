# Stack guidance: web

Choose things the gate can prove and GitHub Pages can host. **Default: a static Vite site with vanilla JavaScript.** Leave the default only when the idea needs it, and name why in the contract.

## The default

```json
{
  "type": "module",
  "scripts": {
    "dev": "vite --host 127.0.0.1",
    "build": "vite build",
    "start": "vite preview --host 127.0.0.1 --strictPort --port ${PORT:-4173}",
    "test": "node --test --test-reporter=tap"
  }
}
```

```js
// vite.config.js
export default { base: './', build: { sourcemap: false } };
```

- Pin exact versions, with `npm install --save-dev --save-exact vite`. Commit `package-lock.json`, since no lockfile fails the gate.
- Install must work with `npm ci --ignore-scripts`. Avoid packages that need install scripts or native addons.
- The gate sets `PORT` and `HOST` and needs `start` to serve the built site on exactly those. Binding every interface is refused.
- The gate runs a fresh copy of your last commit in a sandbox, so anything uncommitted does not exist there. Commands cannot use the network, except the install. They cannot reach any loopback port but `$PORT`, and `listen(0)` is unreachable, so a test that needs a server uses `$PORT`.
- `.gitignore` covers `node_modules`, `dist` and `.env*`.
- `index.html` has `<meta name="viewport" content="width=device-width, initial-scale=1">` and a real `<title>`.

## When vanilla is not enough

Take the smallest library that does the job, in this order: none, a focused utility, then `preact` or `lit` for a UI with a lot of state. Good: `uplot` for charts, `date-fns` for dates. No Next, no Nuxt, no Remix, no SSR, no CSS framework with a build plugin, no state library. A 3D or game idea may take `three` when it truly needs it.

## Base path safety

This is the most common way an app passes locally and breaks once it is live. Pages serves each app from `/venezia-sites/<slug>/`, not from `/`. The gate tests that on a strict copy of Pages, so these fail there even when `vite preview` looks fine:

| Wrong | Right |
|---|---|
| `<script src="/src/main.js">`, `<img src="/logo.png">` | `./src/main.js`, `./logo.png` |
| `fetch('/data.json')` | `fetch(new URL('data.json', document.baseURI))` |
| `url(/bg.png)` in CSS | Relative to the CSS file, or import it through Vite |
| `new Worker('/worker.js')` | `new Worker(new URL('./worker.js', import.meta.url), {type: 'module'})` |
| `location.href = '/about'`, `history.pushState` routes | Hash routing: `#/about` |
| A link to `/` | `./` |

- **Use hash routing only.** Pages has no fallback, so a deep link to a path is a 404.
- **Filenames are case-sensitive on Pages** and not on this Mac. `Logo.png` and `logo.png` are different files there. Use lowercase, and make imports match exactly.
- Assets that are imported or referenced from JS go through Vite. Fixed files go in `public/` and are reached by relative path.

## One shared origin

All apps on Pages share one origin, so storage collides between apps.

- Prefix every `localStorage` key and IndexedDB name with the app's slug.
- Wrap all storage access in `try`/`catch`. It can throw, and the app must still work.
- Do not register a service worker unless the contract asks for one, and scope it to the app's own folder if so.
- Do not use cookies.

## What the gate needs

- **No server at run time.** Everything runs in the browser. Set `"static": true`. If an idea truly needs a server, that is the planner's gap to raise, because Pages cannot host it.
- **No outside hosts at run time.** No CDN links, no Google Fonts, no analytics, no remote images, no API calls. Bundle what you use, including fonts, which come from an `@fontsource` package when a webfont earns its place. The gate's browser records outside hosts, and workers cannot reach them anyway.
- **No secrets in the client.** The gate scans every file, and any `.env` fails it.
- **No `.map` files** in the output.
- **The first paint must be visible.** The gate fails a blank page, so do not start the page empty and wait for data.
- **Quiet console.** Any `console.error` or uncaught error fails the gate. So does a 404 on any asset, including ones you meant to add later.
- **No sideways scroll at phone width.** Use `min-width: 0` in grids and flex items, `overflow-wrap: anywhere` on user text, and `max-width: 100%` on media.
- **Smoke selectors** exist and are visible at both 393 px and 1440 px. Do not hide a control behind a phone-only menu if a smoke step clicks it.
- **Fast:** each smoke step has 3 seconds.
- **Canvas apps** keep a real DOM element in step with true state, so the gate has something to read.

## Structure

```
index.html
vite.config.js
src/
  main.js        wiring and DOM only
  logic.js       pure functions, reachable from node:test without a DOM
  style.css
public/          fixed files
test/            locked, hashed: never edit
```

Pure logic in `src/` must import without touching `document` or `window`, or the locked tests cannot load it.

Pages rules also bind what we build: no commercial SaaS, and nothing that collects passwords or card numbers.
