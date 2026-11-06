// The pages of Venezia, defined once for the navigation and the routes. Plain words lead.

const icon = (paths) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

export const GLYPHS = Object.freeze({
  new: icon('<path d="M10 3.6v12.8M3.6 10h12.8" stroke-width="1.7"/><path d="M8.4 3.6h3.2M8.4 16.4h3.2M3.6 8.4v3.2M16.4 8.4v3.2"/>'),
  projects: icon('<path d="M2.6 12.2q3 2.4 7.4 2.4t7.4-3.2l-2.2 4.2q-.9 1-2.4 1H6.4q-2.5 0-3.8-4.4Z"/><path d="M9.6 12.6V3.2M9.6 3.8q4 2.2 5.2 6.8H9.6M9.6 5.6Q6.6 7.4 5.6 10.6h4"/>'),
  mosaic: icon('<path d="M3.4 3.9 9 3.3l.3 5.4-5.7.3ZM11 3.3l5.7.5-.4 5.2-5 .2ZM3.6 11l5.6-.3.2 5.6-5.6.2ZM10.9 10.9l5.5-.2.2 5.5-5.6.1Z"/>'),
  lessons: icon('<path d="M4.4 3.4h10.2q1 0 1 1v12.2H5.6q-1.2 0-1.2-1.3Z"/><path d="M4.4 15.3q0-1.3 1.2-1.3h10M7.4 6.6h5.2M7.4 9h5.2"/>'),
  fair: icon('<path d="M6 17V3M6 3.6q4.5 2 9.6.4l-2 3.3 2 3.4Q10.5 12 6 10"/><path d="M2.8 17.4q1.6-.9 3.2 0t3.2 0 3.2 0" stroke-width=".8"/>'),
  treasury: icon('<path d="M3 14.4a7.4 7.4 0 1 1 14 0Z"/><path d="m10 13.2 3.2-5"/><path d="M5.2 13.2h1M13.8 13.2h1M10 6.2v1M6.3 8.2l.7.7" stroke-width=".8"/><circle cx="10" cy="13.2" r=".9" fill="currentColor"/>'),
  settings: icon('<path d="M3.2 6h13.6M3.2 14h13.6"/><circle cx="7.4" cy="6" r="1.9" fill="var(--nav-fill)"/><circle cx="12.8" cy="14" r="1.9" fill="var(--nav-fill)"/>'),
  help: icon('<circle cx="10" cy="10" r="7.4"/><path d="M7.7 7.8q.2-2.1 2.4-2.1 2.3 0 2.3 2 0 1.2-1.3 1.9-1.1.7-1.1 1.9"/><circle cx="10" cy="14" r=".6" fill="currentColor"/>'),
  more: icon('<path d="m4.6 8.2 1.9 1.9-1.9 1.9-1.9-1.9ZM10 8.2l1.9 1.9-1.9 1.9-1.9-1.9ZM15.4 8.2l1.9 1.9-1.9 1.9-1.9-1.9Z"/>'),
});

export const PAGES = Object.freeze([
  { id: 'projects', word: 'Projects', route: '/projects' },
  { id: 'mosaic', word: 'Results', route: '/results' },
  { id: 'lessons', word: 'Rulebook', route: '/rulebook' },
  { id: 'fair', word: 'Launched', route: '/launched' },
  { id: 'treasury', word: 'Budget', route: '/budget' },
  { id: 'settings', word: 'Settings', route: '/settings' },
  { id: 'help', word: 'Help', route: '/help' },
].map((page) => Object.freeze(page)));

export const PAGE = Object.freeze(Object.fromEntries(PAGES.map((page) => [page.id, page])));

/** The page at an address. A ship's own page is `/ships/:id`, kept by the routes in main.js. */
export const pageForPath = (path) => PAGES.find((page) => page.route === path.replace(/\/$/, ''))?.id ?? null;
