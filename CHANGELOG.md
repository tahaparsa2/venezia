# Changelog

Notable changes to Venezia. Versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Tap once to start talking and tap again to stop, on the deck and the idea screen, next to holding. A double tap does the same as a tap.
- A press that ends with no words says why and what to do next: blocked, no sound reaching Venezia, a silent or very faint microphone, too short, or nothing recognised. On the deck the reason stays up until you act on it, with Type it instead beside it.
- The first press says "Allow the microphone in your browser, then hold Talk again", and says when it is allowed. A block by the browser or by macOS names the exact place to fix it, for Chrome and for Safari.
- `test/ui/real-voice.mjs` plays real speech through Chrome's capture into the real server and speech helper, on both surfaces, and is part of the UI suite.

### Fixed

- A short tap vanished, and letting go before the microphone had opened threw the press away with no word.
- The audio context is made inside the press, so a browser that wants a gesture has one, and a stuck context can no longer hang the press.
- Audio devices running below 16 kHz, such as an old Bluetooth headset, came through at twice the speed and were not recognised.
- While the speech helper builds for first use, Venezia says "Getting voice ready" and waits, rather than giving up after 10 seconds.
- A press shorter than the socket's connection never told the server it had ended.
- The level meter reads decibels, so a quiet voice still moves it.
### Changed

- Linking a phone is one button. Link a phone in Settings starts phone access, shows numbered steps and a QR code, and opens one box on the Mac with the PIN, which closes itself once the phone is linked. `./vz pair` does the same, and waits to say how it ended.
- The PIN only ever appears in that box, never over HTTP. The typed Mac code is gone, for linking and for turning off, listing and removing devices.
- The QR and the first address use the Mac's IP address, with `venezia.local` as the alternative.
- The phone page asks for the PIN and opens the app. The certificate is never required first, and is offered afterwards in one line. The check for a trusted certificate, and its second listener, are gone.

### Fixed

- The panel and the phone page explain that 127.0.0.1 only means the device itself, and the panel says what to check for a different Wi-Fi, a guest network, a VPN, the firewall or no network address.

## 0.1.1 - 2026-11-05

### Added

- Phone access starts on demand, with no restart, after a yes on the Mac: from Show a pairing code in Settings, or `./vz pair`. A loopback-only server is still the default, and `--lan` still works.
- Settings shows Phone access is on, with a Turn off button. `./vz pair --off` does the same. It closes the listeners and disconnects devices without unpairing them.
- The pairing panel, `./vz pair` and the `/pair` page give the first-time steps in order, for iPhone and Android, and say plainly that no real phone has tried them. `/pair` checks whether the phone trusts the certificate and says what to do next.
- A `./vz` wrapper that needs nothing installed and works from any folder and through a symlink, plus `npm run vz --`.

### Changed

- Every hint now gives a command that works. When the server is not running, the message gives the exact line, including the `cd`.
- The pairing QR holds only the address, and the phone types the PIN from the Mac. The first time in a browser, listing or removing devices, turning phone access off and starting a pairing also take a code from a box on the Mac.

### Fixed

- A QR no longer carries a pairing secret. An impostor at the address could read it once the certificate warning was tapped through.
- An `Origin` header no longer passes for a person. Any local process could list and revoke devices, turn phone access off, and raise dialogs until one gave it a PIN. Boxes on the Mac are now capped.
- Removing a device cuts every connection it has open: live updates, voice and any held request.
- A device paired in the demo is kept apart from the real factory's. A demo with `--lan` still asks nobody, since nothing real is behind it.
- Turn off wins over a yes that was still waiting, and a session ends after a year on the server, as the docs always said.
- A crash after a GitHub Pages push no longer loses the publish. The restart adopts what landed, and a rollback goes back to the true state before the push, which is now journalled first. A failed resume rolls back or says the site may be out.
- Publishing a version that is already out says it sends nothing, and a failed live check no longer tears a checked site down.
- A rollback reports what is still out, and the status, chronicle and Atlas follow it. A live tile dims if its site is gone, and lights again when it is checked live again.
- A local tarball or preview no longer reads as launched or live in a bell, the chronicle, the Atlas or the Fair.
- The receipt is checked after planning, before anything leaves and by the host's recheck during `publishing`, so a commit landing in that gap stops the publish.
- The live check and host simulator run by the contract locked outside the yard, so an edit in the yard cannot weaken them.
- An approval runs from the moment of the yes and spends once, so a yes that has run out of time is asked for again.
- A torn journal line can no longer swallow the entry written after it.

## 0.1.0 - 2026-11-05

The first version, not yet published.

### Added

- The factory line, from idea through contract, build, gate, independent review, repair, receipt and lessons, with state kept only as events.
- The gate: locked tests, a secret scan, and real Chrome checks at phone and desktop sizes, with mechanical evidence. No model decides "done".
- Worker control over the `claude` stream-json protocol, with sandboxing, a jail for yard code, budgets and a rate limit guard.
- The web surface: the lagoon world, deck, cards, folio and intake, plus voice typing on macOS 26.
- The `vz` command line, an MCP surface, and a simulator with `npm run sim` that spends nothing.
- LAN access over HTTPS, with a local certificate authority and phone pairing.
- Publishing through a broker: local, tarball, private repo, secret gist and GitHub Pages. Public targets need a held approval.
- Local prototypes kept for as long as a project's receipt holds.
- Memory in `portolano/`: lessons, the Atlas and the Mariegola rulebook.
- Tool approval cards follow the autonomy setting: Tiller approves each tool, Sail approves what is risky, and Wind runs confined work without a card. Every automatic allow is an event, listed in the chronicle. One policy in `engine/tool-policy.mjs` decides, and no level widens a write outside the project, a credential path, a publishing command or a new network host.
- Preparation for publication: `.gitignore` for local state, secrets and large output, `SECURITY.md`, `docs/PUBLISHING.md`, and personal data removed from docs and tests.

### Fixed

- A finished project can be published. It used to need the `ready` state, so a project finished without publishing could never go live. Every publish rule still applies, it returns to done afterwards, and a failed publish rolls back to done.

### Changed

- Public publishing always needs a person. The opt-in standing policy for tier 3 is gone.
- An agent over MCP can no longer change autonomy.

### Known limits

- Two small projects have run on real Claude from start to finish. Larger ones have not.
- The autonomy policy has not finished a real project. Its one real run reached the contract, where the rate limit guard held it.
- Nothing has been published to the internet from a real run.
- Pairing has not been tried on a physical phone.
- See `docs/ROADMAP.md` for the rest.
