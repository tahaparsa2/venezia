// The page a phone opens when it scans the pairing QR, and the page shown before web/ exists.
// Both are self-contained, so they work on a device that has nothing cached.

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const STYLE = `:root{color-scheme:light dark;--bg:#EFE4CB;--ink:#1B1A17;--line:#b9ab8a;--accent:#2F6B3F}
@media (prefers-color-scheme:dark){:root{--bg:#0B1F24;--ink:#EFE4CB;--line:#2c4a50;--accent:#3E8E7E}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:var(--bg);color:var(--ink);font:17px/1.5 system-ui,sans-serif}
main{max-width:30rem;margin:0 auto}h1{font-size:26px;margin:0 0 8px}h2{font-size:18px;margin:32px 0 8px}
input,button{font:inherit;padding:12px;border-radius:8px;border:1px solid var(--line);width:100%;background:transparent;color:inherit}
input{letter-spacing:.3em;text-align:center}button{margin-top:8px;background:var(--accent);border:0;color:#fff}
a{color:inherit}code{word-break:break-all;font-size:13px}ol{padding-left:1.2rem}#status{min-height:1.5em;margin:12px 0}`;

/**
 * @param {{fingerprint: string, nonce: string}} options
 */
export function pairPage({ fingerprint, nonce }) {
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
<main>
<h1>Pair this device</h1>
<p>This links your phone to the Venezia server on your Mac.</p>
<p id="status" role="status"></p>
<form id="pin-form">
  <label for="pin">Enter the 6-digit code shown by <code>vz pair</code></label>
  <input id="pin" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
  <button type="submit">Pair</button>
</form>
<h2>First time on this phone?</h2>
<p>To stop security warnings, install the certificate for your own server. You only do this once.</p>
<ol>
  <li><a href="/pair/venezia.mobileconfig">Download the profile</a> on iPhone or iPad, or <a href="/pair/ca.crt">the certificate</a> on other devices, and allow it.</li>
  <li>Open Settings, then Profile Downloaded, then Install.</li>
  <li>Open Settings, General, About, Certificate Trust Settings, and turn on Venezia Local Root.</li>
  <li>Scan the QR code again.</li>
</ol>
<p>This certificate can only vouch for <code>.local</code> names and private addresses. Check that its fingerprint matches what <code>vz pair</code> shows:</p>
<p><code>${escapeHtml(fingerprint)}</code></p>
</main>
<script nonce="${nonce}">
const status = document.getElementById('status');
const device = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Android/.test(navigator.userAgent) ? 'Android' : 'Browser';
async function claim(body) {
  status.textContent = 'Pairing...';
  try {
    const response = await fetch('/api/pair/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, name: device }),
    });
    const result = await response.json();
    if (result.ok) {
      status.textContent = 'Paired.';
      location.replace('/');
    } else {
      status.textContent = result.error;
    }
  } catch {
    status.textContent = 'The server could not be reached. If you see a certificate warning, install the certificate below first.';
  }
}
const token = new URLSearchParams(location.hash.slice(1)).get('t');
if (token) {
  history.replaceState(null, '', '/pair');
  claim({ token });
}
document.getElementById('pin-form').addEventListener('submit', (event) => {
  event.preventDefault();
  claim({ pin: document.getElementById('pin').value });
});
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
