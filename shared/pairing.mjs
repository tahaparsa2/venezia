// The words for linking a phone, so the panel on the Mac, the /pair page on the phone and the
// command line give the same steps in the same order. Only the steps of research 04, section 4.2
// that Apple documents are firm. Nothing here has been tried on a real phone, and the page says so.

export const DEMO_PAIRING = 'Pairing needs the real factory. Stop the demo, then run: npm start';

/** The header a browser on the Mac sends once a person has proved they are at it. */
export const PROOF_HEADER = 'x-venezia-proof';

export const NOT_TRIED = 'Not yet tried on a real iPhone or Android phone. These steps come from Apple and Google documentation, so a screen may look different. The biggest open question is whether a phone accepts this certificate, because it is limited to local addresses.';

const FIREWALL = {
  where: 'Mac',
  text: 'If your Mac asks "Do you want the application node to accept incoming network connections?", click Allow. It only asks when the macOS firewall is on. If you clicked Deny, open System Settings, Network, Firewall, Options, and set node to Allow incoming connections.',
};

/**
 * The first-time steps for each kind of phone. `action` marks the step with a download, which
 * the /pair page turns into a link.
 * @type {Record<'iphone'|'android', {where: string, text: string, action?: 'profile'|'certificate'}[]>}
 */
export const SETUP_STEPS = Object.freeze({
  iphone: [
    FIREWALL,
    { where: 'iPhone', text: 'Point the Camera at the QR code and tap the link. Use Safari, because other browsers cannot install the profile.' },
    { where: 'iPhone', text: 'Safari says "This Connection Is Not Private". That is expected the first time, because your iPhone does not know your Mac\'s certificate yet. Tap Show Details, tap visit this website, then tap Visit Website.' },
    { where: 'iPhone', text: 'On the Pair this device page, download the profile, then tap Allow and Close.', action: 'profile' },
    { where: 'iPhone', text: 'Open Settings and tap Profile Downloaded, near the top. Tap Install, enter your passcode, tap Install again, then tap Done.' },
    { where: 'iPhone', text: 'In Settings, open General, then About, then Certificate Trust Settings. Turn on full trust for Venezia Local Root, and tap Continue.' },
    { where: 'iPhone', text: 'Go back to Safari. The page checks the certificate again, then asks for the 6-digit code on your Mac. Type it there. If the code has run out, press Show a pairing code on the Mac.' },
  ],
  android: [
    FIREWALL,
    { where: 'Android', text: 'Point the camera at the QR code and open the link in Chrome.' },
    { where: 'Android', text: 'Chrome says "Your connection is not private". That is expected the first time, because your phone does not know your Mac\'s certificate yet. Tap Advanced, then tap Proceed.' },
    { where: 'Android', text: 'On the Pair this device page, download the certificate. If Android says it cannot install it from there, that is fine, the file is saved.', action: 'certificate' },
    { where: 'Android', text: 'Open Settings and search for "CA certificate". Tap it, tap Install anyway, and choose venezia-root.crt. On a Pixel it is under Security and privacy, More security settings, Encryption and credentials, Install a certificate. Other makers word this differently.' },
    { where: 'Android', text: 'Go back to Chrome. The page checks the certificate again, then asks for the 6-digit code on your Mac. Type it there. If the code has run out, press Show a pairing code on the Mac.' },
  ],
});
