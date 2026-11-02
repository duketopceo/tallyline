// Static, dependency-free offline page. No scripts and no external requests so
// it renders even when everything else is down. Colours are the Silver Lining
// tokens from DESIGN.md (dark by default, light via prefers-color-scheme).

const MARK = `<svg width="28" height="28" viewBox="0 0 16 16" fill="none" aria-hidden="true">
<defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16"><rect width="16" height="16" fill="white"/><path d="M1.2 12.8L14.8 3.4" stroke="black" stroke-width="5" stroke-linecap="round"/></mask></defs>
<g mask="url(#m)" stroke="currentColor" stroke-width="2"><path d="M3 2V14"/><path d="M6 2V14"/><path d="M9 2V14"/><path d="M12 2V14"/></g>
<path d="M1.2 12.8L14.8 3.4" stroke="var(--accent)" stroke-width="3" stroke-linecap="round"/></svg>`;

export const OFFLINE_TITLE = "Tallyline is offline, back soon";

export function offlinePage(opts: { retryAfterSeconds: number; refreshSeconds: number }): string {
  const { retryAfterSeconds, refreshSeconds } = opts;
  const minutes = Math.max(1, Math.round(retryAfterSeconds / 60));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="${refreshSeconds}">
<title>${OFFLINE_TITLE}</title>
<style>
:root{--canvas:#090909;--surface:#0f0f0f;--ink:#e5e5e5;--muted:#cacaca;--lining:#434343;--accent:#339fee;--attention:#f59e0b}
@media (prefers-color-scheme:light){:root{--canvas:#f5f5f5;--surface:#fff;--ink:#1a1a1a;--muted:#343434;--lining:#afafaf;--accent:#005fba;--attention:#92400e}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--canvas);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:440px;padding:28px;background:var(--surface);border:1px solid var(--lining);border-radius:4px}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;letter-spacing:-.1px}
h1{margin:24px 0 8px;font-size:22px;line-height:1.25;letter-spacing:-.3px}
p{margin:0 0 12px;color:var(--muted)}
.state{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.state i{width:10px;height:10px;border-radius:2px;background:var(--attention)}
a{color:var(--accent)}
a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
</head>
<body>
<main>
<div class="brand">${MARK}<span>Tallyline</span></div>
<h1>${OFFLINE_TITLE}</h1>
<p>The server is not answering right now. This page checks again every ${refreshSeconds} seconds, so you can leave it open.</p>
<p><a href="">Try again now</a></p>
<div class="state" role="status"><i aria-hidden="true"></i>If it is still down, try again in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.</div>
</main>
</body>
</html>
`;
}
