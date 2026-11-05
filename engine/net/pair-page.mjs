// The page a phone opens when it scans the pairing QR, and the page shown before web/ exists.
// Both are self-contained, so they work on a device that has nothing cached.

import { NOT_TRIED, SETUP_STEPS } from '../../shared/pairing.mjs';
import { LAN_NAME } from './mdns.mjs';

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const STYLE = `:root{color-scheme:light dark;--bg:#EFE4CB;--ink:#1B1A17;--line:#b9ab8a;--accent:#2F6B3F}
@media (prefers-color-scheme:dark){:root{--bg:#0B1F24;--ink:#EFE4CB;--line:#2c4a50;--accent:#3E8E7E}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:var(--bg);color:var(--ink);font:17px/1.5 system-ui,sans-serif}
main{max-width:30rem;margin:0 auto}h1{font-size:26px;margin:0 0 8px}h2{font-size:18px;margin:32px 0 8px}
input,button{font:inherit;padding:12px;border-radius:8px;border:1px solid var(--line);width:100%;background:transparent;color:inherit}
input{letter-spacing:.3em;text-align:center}button{margin-top:8px;background:var(--accent);border:0;color:#fff}
a{color:inherit}code{word-break:break-all;font-size:13px}ol{padding-left:1.2rem}li{margin:0 0 10px}#status{min-height:1.5em;margin:12px 0}
.get{display:block;margin:8px 0;padding:12px;border-radius:8px;background:var(--accent);color:#fff;text-align:center;text-decoration:none}
.quiet{font-size:15px;opacity:.85}button.plain{background:transparent;border:1px solid var(--line);color:inherit}[hidden]{display:none}`;

/** One list of steps. The download link sits inside the step that asks for it. */
function stepList(steps) {
  const links = {
    profile: '<a class="get" href="/pair/venezia.mobileconfig">Download the profile</a>',
    certificate: '<a class="get" href="/pair/ca.crt">Download the certificate</a>',
  };
  return `<ol>${steps.map((step) => `<li><b>${escapeHtml(step.where)}.</b> ${escapeHtml(step.text)}${step.action ? ` ${links[step.action]}` : ''}</li>`).join('')}</ol>`;
}

/**
 * The page looks for itself before it spends the one-time token. A token sent before the
 * certificate is trusted crosses a link nobody has verified, so that takes a deliberate tap.
 * @param {{fingerprint: string, nonce: string, probePort?: number|null, fallback?: string|null, paired?: boolean}} options
 *   `probePort` is the listener behind the certificate check, and `fallback` the address by IP
 */
export function pairPage({ fingerprint, nonce, probePort = null, fallback = null, paired = false }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Pair with Venezia</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main data-probe="${probePort ?? ''}" data-paired="${paired}">
<h1>Pair this device</h1>
<p>This links your phone to the Venezia server on your Mac.</p>
<p id="status" role="status"></p>
<p id="open-app" hidden><a class="get" href="/">Open Venezia</a></p>
<form id="pin-form" hidden>
  <label for="pin">Enter the 6-digit code shown on your Mac</label>
  <input id="pin" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
  <button type="submit">Pair</button>
</form>
<div id="setup" hidden>
<h2>What to do next</h2>
<section id="steps-iphone" hidden>${stepList(SETUP_STEPS.iphone)}</section>
<section id="steps-android" hidden>${stepList(SETUP_STEPS.android)}</section>
<button type="button" id="check-again">Check again</button>
<p class="quiet">${escapeHtml(NOT_TRIED)}</p>
<h2>If it will not trust the certificate</h2>
<p>You can pair anyway. Do this only on your own Wi-Fi: without the certificate, this page cannot prove it is talking to your Mac. Live updates may fail, and the microphone and the Home Screen app may not work.</p>
<button type="button" id="pair-anyway" class="plain">Pair anyway</button>
</div>
${fallback ? `<p class="quiet">If <code>${LAN_NAME}</code> does not open on this phone, use the address instead: <a href="${escapeHtml(fallback)}">${escapeHtml(fallback)}</a></p>` : ''}
<p class="quiet">This certificate can only vouch for <code>.local</code> names and private addresses. Check that its fingerprint matches the one on your Mac:</p>
<p><code>${escapeHtml(fingerprint)}</code></p>
</main>
<script nonce="${nonce}">
const main = document.querySelector('main');
const show = (id, on) => { document.getElementById(id).hidden = !on; };
const status = document.getElementById('status');
const say = (text) => { status.textContent = text; };
const agent = navigator.userAgent;
const iPadAsMac = /Macintosh/.test(agent) && navigator.maxTouchPoints > 1;
const device = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) || iPadAsMac ? 'iPad' : /Android/.test(agent) ? 'Android' : 'Browser';
const token = new URLSearchParams(location.hash.slice(1)).get('t');
let paired = main.dataset.paired === 'true';
let checking = false;
let misses = 0;

/** Fetched from the second certificate, which only a device that trusts the root will accept. */
async function certificateTrusted() {
  if (!main.dataset.probe) return null;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 5000);
  try {
    const response = await fetch('https://' + location.hostname + ':' + main.dataset.probe + '/', { cache: 'no-store', credentials: 'omit', signal: stop.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function liveLinkWorks() {
  return new Promise((resolve) => {
    const socket = new WebSocket('wss://' + location.host + '/ws');
    const timer = setTimeout(() => { socket.close(); resolve(false); }, 5000);
    socket.onopen = () => { clearTimeout(timer); socket.close(); resolve(true); };
    socket.onerror = () => { clearTimeout(timer); resolve(false); };
  });
}

/** Paired. The last thing to find out is whether live updates reach this phone. */
async function finish() {
  say('Paired. Checking the live connection...');
  show('pin-form', false);
  if (await liveLinkWorks()) {
    location.replace('/');
    return;
  }
  say('Paired, but live updates are blocked on this phone, so the app will fall back to a slower connection. Trusting the certificate is what fixes this.');
  show('open-app', true);
}

async function claim(body) {
  say('Pairing...');
  try {
    const response = await fetch('/api/pair/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, name: device }),
    });
    const result = await response.json();
    if (result.ok) {
      history.replaceState(null, '', '/pair');
      paired = true;
      await finish();
    } else {
      say(result.error);
      show('pin-form', true);
    }
  } catch {
    say('The server could not be reached. Check that this phone is on the same Wi-Fi as your Mac, and that phone access is still on.');
    show('pin-form', true);
  }
}

function pairNow() {
  show('setup', false);
  if (paired) finish();
  else if (token) claim({ token });
  else {
    show('pin-form', true);
    say('This phone trusts your Mac. Enter the code to finish.');
  }
}

async function check() {
  if (checking) return;
  checking = true;
  say('Checking whether this phone trusts your Mac...');
  const trusted = await certificateTrusted();
  checking = false;
  if (trusted) {
    pairNow();
    return;
  }
  if (paired) say('This device is already paired, but it does not trust the certificate yet. Follow the steps below.');
  else if (trusted === null) say('This server cannot check the certificate from here. If you have not trusted it yet, follow the steps below.');
  else if (misses === 0) say('Not trusted yet. This phone does not know your Mac\\'s certificate. You have done the first steps, so carry on from step 4 below.');
  else say('Still not trusted. The usual cause is the last step: Certificate Trust Settings has to be turned on after the profile is installed.');
  misses++;
  show('open-app', paired);
  show('setup', true);
  show('steps-iphone', device !== 'Android');
  show('steps-android', device === 'Android' || device === 'Browser');
}

document.getElementById('check-again').addEventListener('click', check);
document.getElementById('pair-anyway').addEventListener('click', () => {
  show('setup', false);
  if (paired) finish();
  else if (token) claim({ token });
  else show('pin-form', true);
});
document.getElementById('pin-form').addEventListener('submit', (event) => {
  event.preventDefault();
  claim({ pin: document.getElementById('pin').value });
});
// Someone coming back from Settings needs no button: that is when trust may have changed.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !document.getElementById('setup').hidden) check();
});
check();
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
