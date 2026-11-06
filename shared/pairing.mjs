// The words for linking a phone, so the panel on the Mac, the box on the Mac, the page on the
// phone and the command line all say the same thing in the same order. Nothing here has been
// tried on a real phone, and the panel says so.

export const DEMO_PAIRING = 'This is the demo, so a phone cannot link to it. To link a phone, stop the demo, then run: npm start';

export const NOT_TRIED = 'Not yet tried on a real iPhone or Android phone, so a screen may look a little different.';

/** The one line that offers the certificate, always after linking and never before it. */
export const PROFILE_LINE = 'Install this to use your microphone and add Venezia to your Home Screen.';

export const LOOPBACK_NOTE = 'An address starting 127.0.0.1 or localhost only ever means the device you are holding. On a phone it points at the phone itself, never at your Mac.';

export const NO_NETWORK = 'This Mac is not on a network yet, so a phone has nothing to reach. Join Wi-Fi on this Mac, then press Link a phone again.';

export const VPN_WARNING = 'A VPN looks to be on, on this Mac. It can hide this Mac from your phone. If the phone cannot open the address, turn the VPN off and press Link a phone again.';

/** What a person does, in order. The panel and `./vz pair` number these. */
export const LINK_STEPS = Object.freeze([
  'On this Mac, a box has opened with a 6-digit PIN. Leave it open. If macOS asks whether node may accept incoming connections, click Allow.',
  'On your phone, scan this QR code with the camera, or type the address under it into the browser.',
  'The phone warns that the connection is not private. That is expected. On iPhone tap Show Details, then visit this website, then Visit Website. On Android tap Advanced, then Proceed.',
  'Enter the PIN from the box. Venezia opens on the phone, and the box closes by itself.',
]);

/** What to check when the phone cannot open the address. */
export const LINK_CHECKS = Object.freeze([
  { what: 'Same Wi-Fi', text: 'The phone and this Mac must be on the same Wi-Fi. Compare the network name on both. Turn off mobile data on the phone if you are not sure.' },
  { what: 'Guest Wi-Fi', text: 'Guest networks, and many office and hotel networks, stop devices seeing each other. Use your main Wi-Fi. Or turn on Personal Hotspot on the phone, join it from this Mac, and press Link a phone again.' },
  { what: 'VPN', text: 'A VPN on this Mac or on the phone can hide one from the other. Turn it off, and press Link a phone again.' },
  { what: 'Firewall', text: 'If you clicked Deny when macOS asked about incoming connections, open System Settings, Network, Firewall, Options, and set node to Allow incoming connections.' },
]);

/** The only place the PIN ever appears. */
export const pinBoxText = (pin, address) => [
  `PIN: ${pin}`,
  '',
  'On your phone:',
  `1. Scan the code on the screen, or open ${address}`,
  '2. Tap past the security warning.',
  '3. Enter this PIN.',
  '',
  'Only type it on your own phone. This box closes by itself when the phone is linked. If you did not ask for this, press Cancel.',
].join('\n');

/**
 * The optional extra, once a phone is linked. Nothing depends on it. `action` marks the step with
 * the download, which the /pair page turns into a link.
 * @type {Record<'iphone'|'android', {text: string, action?: 'profile'|'certificate'}[]>}
 */
export const SETUP_STEPS = Object.freeze({
  iphone: [
    { text: 'Use Safari. Download the profile, then tap Allow and Close.', action: 'profile' },
    { text: 'Open Settings and tap Profile Downloaded, near the top. Tap Install, enter your passcode, tap Install again, then tap Done.' },
    { text: 'In Settings, open General, then About, then Certificate Trust Settings. Turn on full trust for Venezia Local Root, and tap Continue.' },
  ],
  android: [
    { text: 'Use Chrome. Download the certificate. If Android says it cannot install it from there, that is fine, the file is saved.', action: 'certificate' },
    { text: 'Open Settings and search for "CA certificate". Tap it, tap Install anyway, and choose venezia-root.crt. Other makers word this differently.' },
  ],
});
