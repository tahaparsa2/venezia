// The page a phone lands on when it scans the QR, and the page shown before web/ exists.
// Both are self-contained, so they work on a device that has nothing cached.

import { LOOPBACK_NOTE, PROFILE_LINE, SETUP_STEPS } from '../../shared/pairing.mjs';

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const STYLE = `:root{color-scheme:light dark;--bg:#EFE4CB;--ink:#1B1A17;--line:#b9ab8a;--accent:#2F6B3F}
@media (prefers-color-scheme:dark){:root{--bg:#0B1F24;--ink:#EFE4CB;--line:#2c4a50;--accent:#3E8E7E}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:var(--bg);color:var(--ink);font:17px/1.5 system-ui,sans-serif}
main{max-width:30rem;margin:0 auto}h1{font-size:26px;margin:0 0 8px}h2{font-size:18px;margin:32px 0 8px}
input,button{font:inherit;padding:12px;border-radius:8px;border:1px solid var(--line);width:100%;background:transparent;color:inherit}
input{letter-spacing:.3em;text-align:center}button{margin-top:8px;background:var(--accent);border:0;color:#fff}
a{color:inherit}code{word-break:break-all;font-size:13px}ol{padding-left:1.2rem}li{margin:0 0 10px}#status{min-height:1.5em;margin:12px 0;font-weight:600}
.get{display:block;margin:8px 0;padding:12px;border-radius:8px;background:var(--accent);color:#fff;text-align:center;text-decoration:none}
.quiet{font-size:15px;opacity:.85}summary{padding:10px 0;cursor:pointer;text-decoration:underline}label{display:block;margin:0 0 12px}[hidden]{display:none}`;

/** The optional certificate steps. The download link sits inside the step that asks for it. */
function stepList(steps) {
  const links = {
    profile: '<a class="get" href="/pair/venezia.mobileconfig">Download the profile</a>',
    certificate: '<a class="get" href="/pair/ca.crt">Download the certificate</a>',
  };
  return `<ol>${steps.map((step) => `<li>${escapeHtml(step.text)}${step.action ? ` ${links[step.action]}` : ''}</li>`).join('')}</ol>`;
}

/**
 * Two faces. A phone that is not linked sees one question, the PIN, and then the app opens: the
 * certificate never stands in the way. A phone that is linked sees the way in, and the optional
 * certificate. The page only needs ordinary same-origin requests, which work after a tap-through.
 * @param {{fingerprint: string, nonce: string, paired?: boolean}} options
 */
export function pairPage({ fingerprint, nonce, paired = false }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Link this phone to Venezia</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main data-paired="${paired}">
<section id="ask" hidden>
<h1>Link this phone</h1>
<form id="pin-form">
  <label for="pin">Enter the 6-digit PIN from the box on your Mac</label>
  <input id="pin" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus>
  <button type="submit">Link this phone</button>
</form>
<p id="status" role="status"></p>
<p class="quiet">No box on your Mac? On the Mac, open Venezia, go to Settings, and press Link a phone.</p>
<p class="quiet">${escapeHtml(LOOPBACK_NOTE)} This address is the right one to use.</p>
<details class="quiet"><summary>Check this is your Mac</summary>
<p>This fingerprint should match the one in Settings on your Mac:</p>
<p><code>${escapeHtml(fingerprint)}</code></p>
</details>
</section>
<section id="linked" hidden>
<h1>This phone is linked</h1>
<a class="get" href="/">Open Venezia</a>
<p class="quiet">To come back, open this same address in the browser.</p>
<h2>Optional</h2>
<p>${escapeHtml(PROFILE_LINE)}</p>
<details><summary>Show how</summary>
<section id="steps-iphone" hidden>${stepList(SETUP_STEPS.iphone)}</section>
<section id="steps-android" hidden>${stepList(SETUP_STEPS.android)}</section>
</details>
</section>
</main>
<script nonce="${nonce}">
const main = document.querySelector('main');
const show = (id, on) => { document.getElementById(id).hidden = !on; };
const status = document.getElementById('status');
const say = (text) => { status.textContent = text; };
const agent = navigator.userAgent;
const iPadAsMac = /Macintosh/.test(agent) && navigator.maxTouchPoints > 1;
const device = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) || iPadAsMac ? 'iPad' : /Android/.test(agent) ? 'Android phone' : 'Browser';

function showLinked() {
  show('ask', false);
  show('linked', true);
  show('steps-iphone', device !== 'Android phone');
  show('steps-android', device !== 'iPhone' && device !== 'iPad');
}

async function claim(pin) {
  say('Linking...');
  try {
    const response = await fetch('/api/pair/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin, name: device }),
    });
    const result = await response.json();
    if (result.ok) {
      say('Linked. Opening Venezia...');
      location.replace('/?linked=1');
      return;
    }
    say(result.error);
  } catch {
    say('Could not reach your Mac. Check that this phone is on the same Wi-Fi as your Mac, and that the box is still open on the Mac.');
  }
}

document.getElementById('pin-form').addEventListener('submit', (event) => {
  event.preventDefault();
  claim(document.getElementById('pin').value.trim());
});

if (main.dataset.paired === 'true') showLinked();
else {
  show('ask', true);
  // A link from another app can leave the cookie behind, and this request always carries it.
  fetch('/api/health', { cache: 'no-store' }).then((response) => { if (response.ok) showLinked(); }).catch(() => {});
}
</script>
</body>
</html>
`;
}

/** What `/` serves until web/ exists. */
export function placeholderPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Venezia</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Venezia is running</h1>
<p>The web interface has not been built yet, but the server is up. Try <a href="/api/state">the state</a> or <a href="/llms.txt">the index for agents</a>.</p>
</main>
</body>
</html>
`;
}
