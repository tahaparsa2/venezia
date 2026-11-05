# 04. Device surfaces and the Venetian source material

Track: surface. Date: 2026-11-04. Machine tested: MacBook M2, 8 GB, macOS 26.5, Chrome 156.0.8078.80, Safari 26.5, Node 25.

## How to read this report

Every claim carries one of these labels.

| Label | Meaning |
|---|---|
| **[V]** | Verified today on this Mac by running it. |
| **[P]** | Read in a primary source: vendor docs, a spec, a bug tracker, or a primary historical text. |
| **[S]** | Secondhand: encyclopedias, compatibility tables, vendor blogs, popular history. |
| **[U]** | Unverified. Needs a real iPhone or a book I could not read. |

**The largest gap:** no iPhone or iOS Simulator was available (only Command Line Tools are installed, not Xcode). Nothing about iOS below is [V]. Section 9 lists the checks to run on a real phone.

**Reliability note:** the Apple Developer Web Push page did not load, and the fetch tool returned a made-up summary (it claimed a paid membership is required). I discarded it and used WebKit's own posts, which say the opposite.

**Side effects of testing:**
- Three background Safari tabs were opened on this Mac, pointing at test URLs that are now dead. They can be closed.
- Test servers and the mDNS record are stopped.
- Test artifacts stayed in a temporary folder and are not in this repository.
- Nothing was installed globally, and nothing remote was created.

---

## 1. Decisions this implies

1. **Transcribe on the Mac, not in the browser.** Phone audio goes to the Mac as 16 kHz Int16 PCM, through an AudioWorklet and a WebSocket. A small compiled Swift helper runs Apple's `SpeechAnalyzer`. It worked here with no download and no permission prompt. Web Speech recognition is left out of the core path, because WebKit has said it is not available in Home Screen web apps and that bug is closed as LATER.
2. **Plain `http://LAN-IP` is not viable.** `navigator.mediaDevices`, service workers, Wake Lock, and WebHID/Serial/USB are all absent there, measured in both Chrome and Safari.
3. **Phone access uses a Venezia-generated local root CA, installed once as an iOS profile, plus a QR pairing code.** The Mac issues leaf certificates silently afterwards. Tap-through self-signed is only a one-time demo mode, because reports say `wss://` fails on iOS even after accepting the warning.
4. **The name `venezia.local` works with no installs.** macOS's own `dns-sd -P` registered it, and it needs to run as a child of the server.
5. **Transport is abstracted: WebSocket, then SSE, then long poll.** Tap-through mode and tunnels each break one of these.
6. **Speech output defaults to Mac `say` rendered to AAC and played on the phone.** Browser `speechSynthesis` is the fallback.
7. **The physical deck is built in layers.** On-screen deck first, then keyboard keys, then Gamepad API (the only physical API that works on iOS, Android and desktop), then a macro pad driven from the Node server rather than from WebHID, so it works headless.
8. **Haptics, sound, and visuals are always paired.** iOS has no `navigator.vibrate`. The `<input switch>` trick is optional decoration.
9. **Five bells become five notification classes.** Web Push requires Home Screen install and a trusted certificate, so it is treated as a bonus layer.
10. **The Venetian fiction should use Tafur's real line.** Hulls move, windows hand out typed artifacts. Avoid the "16,000 workers" and "a galley a day" claims (section 8).

---

## 2. What I measured

### 2.1 API exposure by origin [V]

A probe page was served from one Node process and loaded headless in Chrome and in real Safari, reporting results by POST beacon.

| API | Chrome `localhost` | Chrome `https://<lan-ip>` (cert errors ignored) | Chrome `http://<lan-ip>` | Safari `localhost` | Safari `http://<lan-ip>` | Safari `http://*.local` |
|---|---|---|---|---|---|---|
| `isSecureContext` | true | true | **false** | true | **false** | **false** |
| `navigator.mediaDevices` | yes | yes | **undefined** | yes | **undefined** | **undefined** |
| `SpeechRecognition` (unprefixed) | yes | yes | yes | no | no | no |
| `webkitSpeechRecognition` | yes | yes | yes | yes | **undefined** | **undefined** |
| `SR.available/install`, `processLocally` | yes | yes | yes, but `available()` hung over 2 s | no | no | no |
| `speechSynthesis` | yes | yes | yes | yes | yes | yes |
| `navigator.vibrate` | yes | yes | yes | **no** | **no** | **no** |
| `wakeLock` | yes | yes | **no** | yes | **no** | **no** |
| `serviceWorker` | yes | yes | **no** | yes | **no** | **no** |
| `PushManager` | yes | yes | yes | yes | **undefined** | **undefined** |
| `hid` / `serial` / `usb` / `bluetooth` | yes | yes | **no** | no | no | no |
| `getGamepads` | yes | yes | yes | yes | yes | yes |
| `AudioWorkletNode` | yes | yes | yes | yes | **undefined** | **undefined** |
| MediaRecorder `audio/webm;codecs=opus` and `audio/mp4` | both | both | both | both | both | both |

Reading these results:
- The `https://<lan-ip>` column used `--ignore-certificate-errors`, so it proves the APIs appear on a LAN HTTPS origin. It does not show what a real user sees at a certificate warning.
- Exposure is not proof of function. `SpeechRecognition.start()` produced no events on either origin in the 4-second headless run, so that test is inconclusive.
- `SpeechRecognition.available({langs:['en-US'], processLocally:true})` returned `"downloadable"` on Chrome 156 at localhost.

### 2.2 Speech-to-text on this Mac [V]

Test clip: 8.55 s of `say -v Samantha`, 16 kHz mono. This is clean synthetic speech, so real microphone accuracy is **[U]**.

| | Apple `SpeechTranscriber` (macOS 26) | whisper.cpp `base.en` (pywhispercpp 1.5.1, Metal) |
|---|---|---|
| New disk | None. English model already present | 148 MB model + 38 MB venv |
| Install | `swiftc` from Command Line Tools; helper binary is 65-91 KB | Scratch venv with uv |
| Batch time | 1.24 s (about 7x real time) | 0.71 s transcribe, plus **9.9 s load** |
| Peak memory | 18 MB in the helper process (the model likely runs in a system service, so true cost is not captured) | **322 MB** peak footprint |
| Live partials | Yes: 37 partials, first at about 1.1 s, final sentence at 7.4 s | Not tested |
| Permission prompt | None for fed-in audio. `authorizationStatus` stayed 0 (notDetermined) with an unsigned CLI binary | None |
| Heard "Arsenale" as | "arsenal" | "Arsenal" |
| Heard "hold at the" as | "hold it the" in batch, "hold at the" in a partial | "hold it the" |

More findings:
- `SpeechTranscriber.isAvailable` is true. `supportedLocales` has 30 entries. `installedLocales` is nine English variants.
- `fa-IR` is not available through the older `SFSpeechRecognizer`. `it-IT` is available there but not on-device. `en-US` is on-device.
- `bestAvailableAudioFormat` returned **1 ch, 16000 Hz, Int16**. That is a simple format to send from a phone.
- `contextualStrings` with "Arsenale" did not change the output in one attempt. Plan a glossary correction step in the intent parser instead.
- My live harness threw `nilError` from the finish path after the results had arrived. The streaming works, but clean shutdown still needs proper handling.
- The 9.9 s whisper load is a warm-up figure taken while the machine was heavily swapping: **6.03 GB of 7.17 GB swap used**. Treat memory as a first-class budget on this Mac. A permanently loaded 322 MB model is expensive, which is another point for the Apple path.

### 2.3 Text-to-speech on this Mac [V]

- `say -o b.aiff` for a 2-sentence line took 0.69 s.
- `say --data-format=aac -o a.m4a` produced 42 KB for 1.9 s of audio.
- 184 voices are listed. None are tagged Premium, Enhanced, or Siri, so better voices would need a user download in System Settings.

### 2.4 Naming and certificates [V]

| Test | Result |
|---|---|
| `dns-sd -G v4 <mac-name>.local` | Resolves to the Mac's LAN address |
| `dns-sd -P "Venezia" _https._tcp local 18443 venezia.local <lan-ip>` | Registers a custom `venezia.local`. `dns-sd -G` resolved it, and `curl` reached the server in 13 ms |
| Safari to `http://<mac-name>.local:18080` | Loaded |
| Headless Chrome to the same `.local` URL | Returned nothing, twice. Cause unknown. My guess is macOS Local Network privacy for Chrome **[U]** |
| Strict `curl` against the self-signed cert | Exit 60. With `--cacert`, 200 on both IP and `.local` |
| Headless Chrome without the ignore flag | Empty page (blocked) |
| OpenSSL `verify` of a leaf under a **name-constrained** root | OK |
| Apple `security verify-cert` of that chain, host `venezia.local` | Successful |
| Same chain, host `evil.example` | Host name mismatch |
| Leaf with no anchor | `CSSMERR_TP_NOT_TRUSTED` |
| Self-signed CA:FALSE leaf as its own anchor | Successful on macOS. iOS behavior differs, see section 4 |

No listen prompt appeared in this test. A Mac with its firewall on may show one.

---

## 3. Voice

### 3.1 Web Speech recognition

| Browser | State |
|---|---|
| Chrome desktop | Prefixed and unprefixed both exposed [V]. Cloud by default [P: MDN]. On-device through `processLocally`, `available()`, `install()` [P: MDN, V for exposure]. If the pack is missing, `start()` fails with `language-not-supported` [P] |
| Safari desktop | `webkitSpeechRecognition` only, secure context only [V]. No on-device API [V]. caniuse lists 14.1 to 27.1 as "partial" [S] |
| iOS Safari, in a tab | Prefixed, listed as partial for 14.5 to 27.2 [S]. Local-vs-cloud behavior is inconsistent [S: Apple forum, Addpipe] |
| **iOS Home Screen web app** | **Not available.** A WebKit engineer said in 2021 that the API was not available in SafariViewController or Home Screen web apps [P]. Bug 225298 is RESOLVED LATER, last touched March 2025 [P]. A 2026 pull request and a 2026 issue report that iOS 27.2 still fails with `service-not-allowed` or `not-allowed` [S] |
| Firefox | Disabled by default through 162 [S] |

The Safari 27 beta post as fetched has no speech recognition changes, only a `speechSynthesis.cancel()` fix [P].

**Decision:** browser recognition cannot be the core path for a mobile-first installed app. Keep it only as a fallback when the Mac helper is unreachable, such as on a public preview page.

### 3.2 getUserMedia

- Requires a secure context. On `http://LAN-IP`, `navigator.mediaDevices` is undefined [V, P: MDN]. This is the direct answer to "does the mic work from http://LAN-IP": **no**, in either browser.
- Desktop-only flags such as `unsafely-treat-insecure-origin-as-secure` exist [S]. I found no iOS equivalent.
- On iOS in standalone mode, expect repeated mic prompts. WebKit bug 215884 is titled "getUserMedia recurring permissions prompts in standalone when hash changes", and a 2024 comment reports permission not persisting after reload [P].
  - **Do not use hash routing in the app.**
  - Design push-to-talk so one prompt per launch is acceptable.

### 3.3 Local speech-to-text options

| Option | Footprint | Verdict |
|---|---|---|
| **Apple `SpeechAnalyzer`/`SpeechTranscriber`** | No new disk here; compiled helper | **Primary.** Measured above. macOS 26+ only. Apple states it is on-device [P: WWDC25 session 277 via search] |
| whisper.cpp `base.en` | 148 MB + 322 MB RAM | **Fallback.** For other languages or machines. Load on demand and unload. `brew install` would be a global install, so use a project-local venv |
| Larger whisper models | Larger | Not tested. Not advised on 8 GB while agents run |
| parakeet-mlx | Unknown | Third-party benchmark shows about 0.50 s vs 1.23 s for whisper.cpp on an M4 with 24 GB [S]. No memory data found. Not needed now |
| Chrome `processLocally` | Language pack | Desktop Chrome only. Does not help the phone |

No `ffmpeg` is on this Mac [V], so sending WebM would need a decoder. Raw PCM from an AudioWorklet avoids this. AudioWorklet is exposed in secure contexts on desktop Safari and Chrome [V]. On iOS it is **[U]**.

### 3.4 Speech output

- iOS needs `speak()` inside a user gesture; calls from a timer fail silently [S, several sources agree].
- Chrome stops long utterances after about 15 seconds on desktop [S].
- Chromium may silence other tabs, and Safari may pause when switching tabs [S, weak].

**Decision:** render lines on the Mac with `say`, stream AAC, and play through an audio element unlocked by the first tap. This gives one voice on all devices and no 15-second cutoff. Keep `speechSynthesis` as a fallback. Whether audio plays with the screen locked is **[U]**.

---

## 4. Reaching the server from a phone

### 4.1 Options

| Option | Phone install? | Cert warning | Mic, PWA, push | Away from home | Verdict |
|---|---|---|---|---|---|
| `http://<lan-ip>` | None | None | **No** [V] | No | Rejected |
| Self-signed, tap through | None | Every new origin | Page likely secure; `wss` reported failing; service worker unclear | No | Demo only |
| **Local root CA profile + `venezia.local`** | One profile, no app | None after setup | Expected yes, **[U]** on iOS | No | **Default** |
| Tailscale Serve | App on phone and Mac | None, real certs | Yes in principle | **Yes** | **Recommended for remote** |
| Cloudflare Quick Tunnel | None (`cloudflared` on Mac) | None | Origin changes every run, so PWA and push break | Yes, but public | Opt-in for sharing previews only |
| Wildcard DNS with shipped key (local-ip.sh, qip.sh) | None | None | Yes | No | **Rejected** for a control plane; key is public [S] |
| Own domain + DNS-01 cert pointing at LAN IP | None | None | Yes | No | Good later, needs a domain. Some routers block private-IP DNS answers [S] |

### 4.2 The cost on iOS

**Tap-through:** the page can load after accepting the warning. But:
- iOS Safari has been reported to block WebSockets on an untrusted cert even when the page loads, and accepting the warning was not enough [S: Red Hat bug 1885442, Home Assistant forum, Cendio bug 7401].
- Chrome refuses service worker registration on untrusted certs with a SecurityError [S: MSW docs, Dean Hume].
- Safari's service worker behavior here is **[U]**.

So tap-through gives a page, not an app.

**Local CA profile:** a one-time setup of roughly 8 to 10 taps and about two minutes (my estimate):
1. Scan the QR code, which opens a page on the Mac.
2. Download the profile and allow it.
3. Settings, then Profile Downloaded, then Install, entering the passcode.
4. Settings, General, About, **Certificate Trust Settings**, turn on full trust [P: Apple 102390].

Rules to respect:
- Server certs need a SAN, `serverAuth` EKU, SHA-2, ECDSA or RSA 2048+, and validity of **825 days or fewer** [P: Apple 103769]. The leaf I generated meets this. Whether these apply to user-added roots is not stated.
- iOS needs a real CA to list in Trust Settings. The Cendio thread found that removing Basic Constraints stopped iOS treating the cert as a CA [S]. This is why to use **root + leaf**, not a self-signed leaf, even though macOS accepted one [V].
- mkcert warns that its root key "gives complete power to intercept secure requests". This is a real risk, because the phone will trust this root for everything.

**Mitigation, recommended:** add X.509 **name constraints** so the root can only sign `.local`, `localhost`, and private IP ranges. OpenSSL and Apple's trust check on macOS both accept this [V], and a generated `ca.crt` is 745 bytes. Whether iOS enforces or accepts name-constrained user roots is **[U]**, and is the first thing to test. Keep `ca.key` mode 600, out of git, and offer a "Revoke this phone" instruction.

A local CA also handles DHCP changes. The phone trusts the root once, and the Mac re-issues the leaf when its IP changes.

### 4.3 mDNS

- iOS resolves `.local` through multicast by design [S: Rebex, mostly older sources]. Current iOS is **[U]**.
- Android has had mDNS in its resolver since a November 2021 Mainline update, likely Android 12+. A May 2026 PR reports Chrome on Android 16 failing with some responders [S]. So the QR should carry a fallback IP URL, and the cert should include the IP SAN.
- `dns-sd -P` must stay running, and should be restarted when the IP changes.

### 4.4 QR pairing

This server can run code, so pairing is a security boundary.

- QR opens `https://venezia.local:PORT/pair#t=<128-bit token>`. The token sits in the fragment, so it is never sent in the request line or logged.
- The token is single-use and expires in a few minutes. It is exchanged by POST for an `HttpOnly; Secure; SameSite=Strict` cookie.
- Check `Host` and `Origin` on every request and WebSocket upgrade, to block DNS rebinding.
- Keep a paired-device list on the Mac with one-tap revoke. Rate-limit PIN attempts.
- **Also offer a 6-digit PIN flow inside the installed app.** Sources conflict on whether storage is shared between Safari and a Home Screen app: a vendor guide says separate, an October 2026 field note says a Home Screen page used Safari's storage [S]. Don't depend on either.
- Publishing should need a stronger confirmation than a paired session. See "Desponsamus" in section 7.

### 4.5 Remote access notes

- Tailscale Personal is free, for up to 6 users with unlimited user devices [P]. Serve keeps access inside the tailnet [P]. Funnel is public; ports 443, 8443, 10000 [P]. Whether Personal includes Funnel was not visible on the pricing page.
- Quick Tunnels need no account. They allow 200 in-flight requests, **do not support SSE**, have no uptime guarantee, and give a new URL each run. Email restriction was added 2026-10-02 [P/S: Cloudflare docs via search]. Creating one counts as a remote action, so it should stay an explicit user action.
- Chrome's Local Network Access prompt applies when a public page reaches a local address. It would affect a published prototype calling back to the Mac, but not the app served from the Mac [P: Chrome blog]. Enforcement dates in third-party posts are unconfirmed.

---

## 5. Phone surface features

| Feature | State | Decision |
|---|---|---|
| `navigator.vibrate` | Chrome and Android yes. Safari desktop none [V]. iOS Safari none through 27.2 [S: caniuse]. Firefox removed it at 129 [S] | Use on Android only |
| iOS haptic workaround | `<input type="checkbox" switch>` plus a programmatic label click triggers the system tap haptic. Library: `web-haptics` [S, March 2026]. Version claims differ (17.4 vs 18). Described as a hack that may break. Whether it fires outside a tap is **[U]** | Optional. Fire inside tap handlers only. Never the only signal |
| Wake Lock | iOS 16.4 in Safari; **Home Screen apps since 18.4** [P: WebKit]. Secure context only [V]. Re-acquiring on return needs a user gesture on iOS [P: WebKit bug 255363 comment] | Use during a live build view. Re-request on the next tap |
| PWA install, iOS | Add to Home Screen is the only route; no `beforeinstallprompt` [S]. iOS 26 opens every added site as a web app by default [P: WebKit 26.0] | Show an instruction sheet. Detect with `display-mode` |
| PWA install, Android | Standard Chrome flow, needs trusted HTTPS | Same manifest |
| Web Push, iOS | 16.4+, Home Screen only, user gesture, no Apple Developer membership [P: WebKit]. Visible notification required for each push, or the subscription can be revoked [P] | Implement after tier 1 works |
| Declarative Web Push | iOS 18.4 for Home Screen apps [P]. Payload: `{"web_push":8030,"notification":{"title":...,"navigate":...}}`. Survives service worker removal, with no JS modification [P] | Prefer it. Fits short bell alerts |
| Push from a local server | Server only needs outbound HTTPS to subdomains of `push.apple.com` [P]. VAPID is standard. Working from a local-CA origin is **[U]** | Test early. If it fails, push waits for tailnet or a domain |
| Keeping the live link in background | iOS suspending sockets is assumed, not tested **[U]** | Reconnect and resync on `visibilitychange`. Server state is the truth |

---

## 6. Physical control deck

### 6.1 Reference: Codex Micro

OpenAI's first hardware, launched 2026-07-15 at $230, made with Work Louder [S: Axios, Engadget]. It has 13 mechanical keys, a rotary dial, and a planar joystick [P: OpenAI docs, Work Louder]. Six frosted **Agent Keys** with LEDs show the status of each assigned chat. Command keys default to Fast mode, Approve, Decline, Continue in a new chat, Mic, and Send. The dial has four modes, and it defaults to composer navigation, so setting reasoning level is only one of them. The joystick defaults to navigation and a Plan mode toggle, and skills are optional assignments. Agent Keys need the ChatGPT desktop app running [S: TechTimes], and Work Louder Input can configure five more layers [P]. `02-control-centers.md` section 2.4 has the primary-source detail.

The useful idea is a small set of **status you can feel, plus decisions you can press**. Venezia can offer that in software first.

### 6.2 APIs

| API | Chrome desktop | Safari | iOS | Android Chrome | Firefox | Notes |
|---|---|---|---|---|---|---|
| **Gamepad** | Yes | Yes | Yes (10.3+) | Yes | Yes | Widest reach [S: caniuse]. Exposed on all origins tested [V]. Fires only after a button press, and on a focused page [P: MDN] |
| Gamepad rumble | Yes (68+) | Desktop 16.4+ | **No** through 26.6 [S], WebKit bug 263022 | | | Treat as optional |
| WebHID | 89+ | No | No | **No** | No | Secure only [V]. Keyboard and mouse collections blocked; FIDO blocked [P: Chrome docs]. Needs a picker. WebKit opposed on fingerprinting grounds [S] |
| Web Serial | 89+ | No | No | 156 per caniuse [S] | 151, gated by add-on [S] | Good for a DIY board with LEDs. WebKit opposed [S] |

### 6.3 Deck design

**Layer 0: on-screen deck.** Six lamps, Approve, Reject, Steer, Talk, a dial. It runs everywhere and is the design source for all others.

**Layer 1: keyboard.** A macro pad in keyboard mode sends plain keys. This needs no permission and works on any device that accepts a keyboard, which also covers Bluetooth keyboards on phones.

**Layer 2: gamepad.** Works with a phone, no install. Note that the page must stay focused, so this suits a tablet or phone sitting at the desk.

| Input | Action |
|---|---|
| Left stick, 8 directions | The eight winds, a radial navigator |
| Right trigger, analog | Dial: effort or speed |
| A / B | Approve / Reject |
| X | Talk, hold to speak |
| Y | Steer the selected hull |
| Bumpers | Previous or next hull |

**Layer 3: macro pad from the Node server.** The pad plugs into the Mac, which is also the server. Driving it from Node (for example with `node-hid`, not tested) means it works with no browser open, fits the headless goal, and works with any page state. WebHID would need a Chrome tab, and only reaches vendor collections, such as QMK Raw HID (`0xFF60`/`0x61`) [P: QMK docs] or a Stream Deck through the unofficial `@elgato-stream-deck/webhid` [S].

Do not buy hardware yet. Layers 0 to 2 cover the need, and layer 3 can follow once the deck's actions have settled.

### 6.4 Recommended build order

| Tier | Delivers | Needs from the user |
|---|---|---|
| 0 | Everything on the Mac at `localhost`, which is a secure context [V] | Nothing |
| 1 | Phone on LAN: voice, PWA, deck | Install one profile |
| 2 | Push, haptics, wake lock, gamepad | Add to Home Screen |
| 3 | Remote via Tailscale | Install Tailscale |
| 4 | Macro pad | Buy one |

---

## 7. Venetian source material and system mapping

The game names in the "maps to" column are **suggestions, not historical terms**, unless noted.

### 7.1 The moving hull: the central metaphor

The best source is an eyewitness. Pero Tafur, a Castilian traveller in Venice in the late 1430s (secondary sources say 1436), trans. Malcolm Letts, 1926 [P]:

> "And as one enters the gate there is a great street on either hand with the sea in the middle, and on one side are windows opening out of the houses of the arsenal, and the same on the other side, and out came a galley towed by a boat, and from the windows they handed out to them, from one the cordage, from another the bread, from another the arms, and from another the balistas and mortars, and so from all sides everything which was required, and when the galley had reached the end of the street all the men required were on board, together with the complement of oars, and she was equipped from end to end. In this manner there came out ten galleys, fully armed, between the hours of three and nine."

He also records eighty galleys "in the water and on the stocks".

**Accuracy point:** Tafur describes **fitting-out**, not hull construction. Hulls were finished and then moved past stations. Say "moving fitting-out line", not "assembly line that built the ship". More general accounts add framing, planking and cabins, and final assembly as stages [S: Wikipedia], with hulls floated to a new shed at each step [S: World History Encyclopedia].

**Maps to:**
- **Hull** = one idea moving through the factory.
- **The water street** = the pipeline. It is the one screen that matters.
- **Windows** = fixed stations. Each one hands exactly one typed artifact to the hull: spec, plan, code, tests, build, preview. A hull cannot pass a closed window. This is the mechanism that makes the system dependable.
- **The towing boat** = the orchestrator.
- **Ten galleys in six hours** = the throughput readout. The game can show hulls per day against that benchmark.

Tafur's other scene: twenty men bring benches, tables and bags of money into the square, a trumpet sounds, "the great bell, which they call the Council Bell, was rung", and within an hour the square is full of men who are paid and go into the Arsenal. **Maps to** muster: a spend budget is laid out, agents are hired in, and the run starts.

### 7.2 Reference table

| Thing | Accurate facts | Confidence | Maps to |
|---|---|---|---|
| **The Arsenale** | Traditional date c. 1104, but "no evidence for such a precise date"; existed by early 13th c. Arsenale Nuovo 1320, Newest 1473, Galeazze canal 1564. About 24 ha, 15 m walls. Tana ropewalk 1579, 316 m long | S | The whole app |
| **Arsenalotti** | "Several thousand" at peak, varying with demand. Trades include shipwrights, sawyers, caulkers, smiths, riggers; women spun and sewed sails. Masters (*proti*) up to about a thousand. Daily wine, Saturday pay at the gate, funds for the injured, apprenticeships passing to children. Wine cost about 2% of state budget (Davis, abstract). A 1569 hours cut led to a riot. Night guards, fire response in the yard, Bucintoro rowers | S | Agents, with trades as roles. *Proti* = senior planning agents. Saturday pay = weekly usage report |
| **Marangona** | Largest bell of San Marco's campanile. Marked sunrise and sunset work hours for the Arsenal, and announced Great Council sessions. Named for *marangoni*, carpenters. Sole survivor of the 14 July 1902 collapse | S | Run started and ended |
| **Other bells** | **Nona** midday. **Trottiera** hurried the Council. **Mezza Terza / Pregadi** Senate. **Renghiera / Maleficio** executions. Four were recast in 1909 and installed 1910. Tower is 98.6 m | S | See 7.3 |
| **Bucintoro** | State barge. Name origin uncertain. Four major versions: 1311, 1526, 1606, 1727 (debut 1729). Last one about 35 m, two decks, 42 oars, 168 oarsmen. Broken up on Napoleon's order in 1798, gilded parts burned on San Giorgio Maggiore. 1:10 model at Museo Storico Navale | S | The publish vessel, shown only at release |
| **Sensa, Marriage of the Sea** | Linked to Pietro II Orseolo's Dalmatian expedition, c. 1000. On Ascension Day. Formula: *"Desponsamus te, mare, in signum veri perpetuique dominii."* Ended 1797. Revived since 1965, with the mayor in the doge's role. Next Ascension Thursday: **6 May 2027** (calculated) | S | The publish ceremony |
| **Bocche di leone** | Slots for written accusations; magistrates held the keys. Each major magistracy had its own. Rules: 1387, anonymous notes in the Ten's boxes to be burned; 1542, blasphemy charges needed three named witnesses; 1588 and 1635, petty matters destroyed, state matters could proceed with a four-fifths majority of the Ten. Inquisitors checked through spies first. Survive at the Doge's Palace, San Martino di Castello, San Pantalon, Santa Maria della Visitazione | S (Italian local history) | Steering and dissent inbox |
| **Portolan charts** | Manuscript charts on vellum. Carta Pisana c. 1280 is the earliest known. Vesconte's 1311 chart is the oldest signed and dated; Genoese, active in Venice. 32 directions; black 8 main winds, green half-winds, red quarter-winds. Names perpendicular to the coast. Black dots for rocks, red for shoals. A *portolano* is the written sailing directions. How they were made is unresolved | S | Project memory |
| **The eight winds** | Tramontana N, Greco NE, Levante E, Scirocco SE, Ostro S, Libeccio SW, Ponente W, Maestro NW | S | Radial nav, joystick |
| **Fra Mauro map** | c. 1450, Camaldolese monk of Murano. 2.4 m square, on vellum, **south up**. About 3,000 inscriptions. Used travellers' oral accounts. Commissioned by the Signoria | S | Portfolio view with provenance notes |
| **De' Barbari, *View of Venice*** | Titled VENETIE MD. Six pearwood blocks, 1498-1500, published by Anton Kolb. About 133 x 278 cm. Blocks in Museo Correr. 103 bell towers. Mercury above, Neptune in the harbor. Eight wind heads. Heights exaggerated; proportions compressed. Privilege granted 30 Oct 1500. Three states: the campanile was recut as the real tower changed | S; Cleveland for size | Home screen |
| **San Marco gold** | About 8,000 m² of mosaic, from the 11th c. over about six centuries. Tesserae are glass with gold leaf between layers. A thin glass foil (*cartellina*) covers the leaf; base glass tints the gold. Set at slight angles to scatter light | S (commercial sources for technique) | Earned progress wall |
| **Mariegola** | Statute book of a Venetian guild or confraternity. From *matricola*. Cumulative: amendments and confirmations were added over time, and books were recopied into new redactions. Guild statutes needed official confirmation for public legal force | S | Self-learning rulebook |
| **Muda** | State-run annual convoys, 1315-1533. Galleys leased by auction to merchants; a state Captain led. Left in spring, back in autumn | S | Scheduled release batches |
| **Doge election** | Rules from 1268 to 1797. Ten rounds alternating lot and vote; one family per committee; 25 of 41 approval. Mowbray and Gollmann analyzed it as a security protocol | S/P | Reviewer selection |
| **Council of Ten** | Created 1310. One-year terms, no consecutive terms, one member per family. Ended 1797 | S | Rotating audit agents |

Two lines worth using as flavor text:

Dante, *Inferno* XXI.7-9 [P: Wikisource]: *"Quale ne l'arzanà de' Viniziani / bolle l'inverno la tenace pece / a rimpalmare i legni lor non sani"*. Lines 10-15 go on to list the trades: new hulls, caulking, hammering, oars, ropes, sail patching.

Galileo, *Two New Sciences*, First Day (Crew and de Salvio trans.) [P: Wikisource]: *"The constant activity which you Venetians display in your famous arsenal suggests to the studious mind a large field for investigation"*. He goes on to praise artisans who learn "partly by inherited experience and partly by their own observations". This is the best historical statement of what self-learning means here.

### 7.3 Mappings worth building

**You are the Doge.** Agents do the work; you approve at gates, steer, and hold the ring.

**Five bells, five notification classes.** Each has its own sound, haptic pattern, and rule for whether it may interrupt.

| Bell | Historic role | Venezia event | Interrupts? |
|---|---|---|---|
| Marangona | Work starts, ends | Run started or finished | Finish only |
| Nona | Midday | Daily digest | No |
| Trottiera | Hurry the Council | Approval waiting, escalates over time | Yes |
| Pregadi | Summon the Senate | Decision needs you | Yes |
| Maleficio | Executions | Hull killed, rollback, budget stop | Yes |

**Bocca di leone: the steering slot.** Speak or type a note at any time. It goes into the hull's box, and the agent reads it at the next window, so steering never breaks a running step. Agents can use it too: any agent can file a concern against the plan. This follows the historical rules:
- Concerns without evidence are burned (the 1387 rule).
- A petty concern is dropped; a serious one must name its evidence (file, line, failing test), echoing the witness rule.
- Stopping the line needs a high threshold, echoing the four-fifths rule.

**Portolan and portolano: self-documentation.** Each project is a coast. The *portolano* is the text an agent writes after each run: where it docked, what worked. The chart is the visual. Black dots are hard hazards; red dots are shoals, such as flaky tests. Every voyage corrects the chart, which fits Fra Mauro's use of travellers' reports.

**Mariegola: the rules.** Learned rules are drafted by agents but enter as proposals. They only become law once you confirm them, as guild statutes needed confirmation. New entries are appended, so the history of changes is visible. This is how Venezia can self-learn while staying steerable. On disk it can be a rules file that is fed to Claude Code.

**Gold tesserae: honest progress.** One tile is set for each independently verified result, such as a passing test or a completed build. Tiles are never placed for an agent's own claim of success. Tiles render on a canvas with small random tilts, so the wall shimmers as you scroll or tilt the phone. Device orientation on iOS needs a permission prompt, so fall back to scroll.

**De' Barbari: the home screen.** A bird's-eye city, with quarters as projects and bell towers as live status beacons. Distortion is a feature: active projects can swell, as he inflated important buildings. Six tiles load as six "blocks". Each map update can be called a new "state". The Cleveland Museum lists its impression as public domain with a download option [P]. Check the file resolution before relying on it.

**Sensa: publishing.** Publishing is the irreversible step, so it should feel like a ceremony. The Bucintoro appears. You say or type a short phrase, for example "Desponsamus", or hold a control for two seconds. The ring drops. The published link goes to the Sensa fair, a gallery of everything launched. A prototype that stays local is a hull in the basin. A published one has been married to the sea.

**Muda: release trains.** Scheduled batches of ships leave together. This suits weekly publishing or batched updates.

**Doge election: review.** Reviewers are drawn by lot from a pool, never include the agent that wrote the code ("one per family"), and a change needs a qualified majority to pass.

### 7.4 Palette suggestion

Not historical data, a starting point: lagoon night `#0B1F24`, verdigris `#3E8E7E`, tessera gold `#D9A93A`, Bucintoro vermilion `#C8391F`, portolan green `#2F6B3F`, iron-gall ink `#1B1A17`, vellum `#EFE4CB`. Check contrast before use.

---

## 8. Accuracy traps for the game writers

| Avoid | Why | Say instead |
|---|---|---|
| "16,000 arsenalotti" | Wikipedia and blogs repeat it, but other accounts give 1,500-3,000 daily and up to about 5,000 on the rolls. Scholarly figures unconfirmed | "Thousands" |
| "A galley a day" as routine output | Marketing-style claim | Use Tafur's ten in one session, which is witnessed |
| "World's first assembly line built ships in a day" | Tafur saw fitting-out | "A moving fitting-out line" |
| "Founded in 1104" as a fact | No evidence for the exact date | "Traditionally 1104" |
| "Rhumb lines" on portolans | Scholars prefer windrose lines | "Wind lines" |
| Bocche as a free anonymous tip line | Anonymous notes were legally restricted | "Written accusations with rules" |
| A general two-witness rule | Source quality is weak; the rule I can cite is three witnesses for blasphemy, 1542 | Cite the 1542 rule |
| The ring in "1177" or "1176" | Wikipedia says 1176; 1177 is also repeated. It is a legend | "In the 1170s, by legend" |
| A Marangona casting date | Sources conflict | Only "survived 1902" |
| Tafur named the Marangona | He says "Council Bell". Identification is my inference, since the Marangona announced Council sessions | Keep as an inference |
| Henry III's "one hour" galley, 1574 | Sources vary from under an hour to about two; all popular | "During the king's banquet, the story goes" |
| Arsenalotti carrying the doge, guarding the Great Council | Could not source these | Leave out for now |
| Where the Fra Mauro map hangs | Wikipedia contradicts itself: Correr or Marciana | "In Venice" |
| Sensa date | Thursday Ascension or following Sunday, sources differ | "Ascension" |

**Not read directly:** Lane's *Venetian Ships and Shipbuilders of the Renaissance* and Davis's *Shipbuilders of the Venetian Arsenal*. Britannica, Smithsonian, and Smarthistory returned 403 errors. If the fiction becomes public-facing, check headcounts against these two books.

---

## 9. Real-phone test list

Ship the probe as a hidden `/probe` page in the app. The test version was kept at `$SCRATCH/surfaces/probe.html`, outside this repository.

Do these in order. Test 1 decides the cert design, and tests 2 to 4 decide whether voice works.

1. Does iOS accept and enforce the **name-constrained** root once trusted?
2. In the Home Screen app, does `getUserMedia` give audio, and does AudioWorklet run?
3. Mic latency: partials on the phone, over the LAN, using a real voice and a noisy room.
4. How often does the mic prompt return in standalone mode?
5. Does `wss://` connect under the trusted CA? And in tap-through mode?
6. Does the service worker register, and does Add to Home Screen keep the origin?
7. Does Web Push subscribe and deliver from the local-CA origin?
8. Does `venezia.local` resolve on the phone, including right after a Wi-Fi rejoin?
9. Is the session shared between Safari and the installed app?
10. Do `<input switch>` haptics fire inside a tap? From a socket event?
11. Does a gamepad connect in the installed app?
12. Does audio from the Mac keep playing with the screen locked?

Mac follow-ups: fix the helper's shutdown path, test the helper from a Node child process, and measure real memory for the Apple path.

---

## 10. Sources

**Browser and platform**
- [MDN: Using the Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API)
- [Web Speech on-device explainer](https://github.com/WebAudio/web-speech-api/blob/main/explainers/on-device-speech-recognition.md)
- [caniuse: speech recognition](https://caniuse.com/speech-recognition), [vibration](https://caniuse.com/vibration), [wake lock](https://caniuse.com/wake-lock), [gamepad](https://caniuse.com/gamepad), [WebHID](https://caniuse.com/webhid), [Web Serial](https://caniuse.com/web-serial), [gamepad rumble](https://caniuse.com/mdn-api_gamepad_vibrationactuator)
- [WebKit bug 225298: SpeechRecognition unavailable in Home Screen apps](https://bugs.webkit.org/show_bug.cgi?id=225298)
- [Apple forum: PWA webkitSpeechRecognition](https://developer.apple.com/forums/thread/748048), [Apple forum: interim results on iOS](https://developer.apple.com/forums/thread/775699)
- [qryptchat PR #323](https://github.com/profullstack/qryptchat-web/pull/323), [ovis issue #2343](https://github.com/devswha/ovis/issues/2343)
- [Addpipe: Deep dive into Web Speech](https://blog.addpipe.com/a-deep-dive-into-the-web-speech-api/)
- [MDN: getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [WebKit bug 215884 thread: recurring mic prompts in standalone](https://lists.webkit.org/pipermail/webkit-unassigned/2024-September/1183557.html)
- [WebKit features in Safari 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/), [Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/), [Safari 26.2](https://webkit.org/blog/17640/webkit-features-for-safari-26-2/), [Safari 27 beta](https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/)
- [WebKit: Meet Web Push](https://webkit.org/blog/12945/meet-web-push/), [Web Push on iOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), [Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/)
- [WebKit bug 254545: Wake Lock in Home Screen apps](https://bugs.webkit.org/show_bug.cgi?id=254545), [bug 255363: Wake Lock denied after visibilitychange](https://bugs.webkit.org/show_bug.cgi?id=255363)
- [openpwa: iOS Add to Home Screen](https://openpwa.net/reference/installation/ios-add-to-home-screen/)
- [WebHaptics article](https://azukiazusa.dev/en/blog/ios-safari-web-haptics), [Ionic issue 29942](https://github.com/ionic-team/ionic-framework/issues/29942)
- [testmu: speech synthesis support](https://www.testmuai.com/learning-hub/speech-synthesis-api-browser-support/), [w3cub: speech synthesis table](https://docs.w3cub.com/browser_support_tables/speech-synthesis), [IBM iX: speechless in the frontend](https://engineering.ibmix.de/blog/2024/08/speechless-in-the-frontend)

**Local speech**
- [WWDC25 session 277: SpeechAnalyzer](https://developer.apple.com/videos/play/wwdc2025/277/)
- [Addpipe: Apple SpeechAnalyzer](https://blog.addpipe.com/apple-speechanalyzer-api/)
- [Blake Crosley: SpeechAnalyzer vs SFSpeechRecognizer](https://blakecrosley.com/blog/speech-framework-vs-sfspeechrecognizer)
- [whisper.cpp models on Hugging Face](https://huggingface.co/ggerganov/whisper.cpp)
- [mac-whisper-speedtest](https://github.com/anvanvan/mac-whisper-speedtest), [silicon-asr](https://pypi.org/project/silicon-asr/)

**Network and certificates**
- [Apple: trust manually installed certificate profiles](https://support.apple.com/en-us/102390)
- [Apple: requirements for trusted certificates](https://support.apple.com/en-us/103769)
- [mkcert](https://github.com/FiloSottile/mkcert)
- [Red Hat bug 1885442](https://bugzilla.redhat.com/show_bug.cgi?id=1885442), [Cendio bug 7401](https://bugzilla.cendio.com/show_bug.cgi?id=7401), [Home Assistant forum](https://community.home-assistant.io/t/https-ssl-configuration-not-working-for-ios-safari/71563)
- [MSW: local HTTPS](https://mswjs.io/docs/recipes/using-local-https), [Dean Hume: service workers and self-signed certs](https://deanhume.com/testing-service-workers-locally-with-self-signed-certificates/)
- [Chrome: Local Network Access](https://developer.chrome.com/blog/local-network-access)
- [Rebex: mDNS and Apple devices](https://blog.rebex.net/multicast-dns-apple-and-local-domains), [Home Assistant: Android mDNS](https://community.home-assistant.io/t/detail-mdns-android-os-limitations-on-the-web-server-components-documentation/374099), [mdns-sd PR #469](https://github.com/keepsimple1/mdns-sd/pull/469)
- [Tailscale pricing](https://tailscale.com/pricing), [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel.md)
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/), [Tunnel changelog](https://developers.cloudflare.com/cloudflare-one/changelog/tunnel/index.md)
- [local-ip.sh](https://local-ip.sh/), [sslip.io wildcard docs](https://github.com/cunnie/sslip.io/blob/master/docs/wildcard.md), [qip.sh](https://qip.sh/)

**Physical input**
- [Chrome: WebHID](https://developer.chrome.com/docs/capabilities/hid)
- [MDN: Using the Gamepad API](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API/Using_the_Gamepad_API)
- [WebKit bug 263022 thread: rumble on iOS](https://lists.webkit.org/pipermail/webkit-unassigned/2023-October/1126856.html)
- [SecNews: APIs Safari refuses](https://www.secnews.gr/en/248291/apple-refused-to-implement-16-web-apis-in-safari/), [Mozilla: Add-On-Gated Web Serial](https://groups.google.com/a/mozilla.org/g/dev-platform/c/rwTxmEBoAvM)
- [QMK Raw HID](https://develop-docs.qmk.fm/features/rawhid), [@elgato-stream-deck/webhid](https://www.npmjs.com/package/%40elgato-stream-deck%2Fwebhid)
- [Axios: Codex Micro](https://www.axios.com/2026/07/15/openai-keyboard-codex-agents), [Engadget](https://www.engadget.com/2215952/openai-launches-a-physical-keypad-for-controlling-agents/), [Gizmodo](https://gizmodo.com/openai-just-launched-its-first-hardware-product-and-its-a-tiny-keyboard-for-bossing-around-ai-agents-2000786080)

**Venice**
- [Pero Tafur, Travels and Adventures, trans. Letts (1926)](https://depts.washington.edu/silkroad/texts/tafur.html)
- [Dante, Inferno XXI, Italian Wikisource](https://it.wikisource.org/wiki/Divina_Commedia/Inferno/Canto_XXI)
- [Galileo, Two New Sciences, First Day, Wikisource](https://en.wikisource.org/wiki/Dialogues_Concerning_Two_New_Sciences/First_Day)
- [Venetian Arsenal, Wikipedia](https://en.wikipedia.org/wiki/Venetian_Arsenal)
- [Arsenale, World History Encyclopedia](https://www.worldhistory.org/article/2776/arsenale/)
- [Davis, "Venetian Shipbuilders and the Fountain of Wine", abstract](https://go.gale.com/ps/i.do?id=GALE%7CA20059972&sid=googleScholar&v=2.1&it=r&linkaccess=abs&issn=00312746&p=AONE&sw=w), [Davis book review](https://premodeconhist.wordpress.com/2009/02/04/davis-r-1991-the-workers-of-venices-arsenal/)
- [Benátský arzenál (Czech), worker counts](https://wikiwand.com/cs/articles/Benátský_arzenál)
- [HistoryNet: Arsenal of Venice](https://historynet.com/arsenal-venice-worlds-first-weapons-factory/), [Arsenale walk, quoting Crowley](https://stroll-venice.com/walks/castello/arsenale/)
- [Galileo and the Challenge of the Arsenal (MPIWG)](https://echo.mpiwg-berlin.mpg.de/content/shipbuilding/venice_arsenal/lettura_gal)
- [St Mark's Campanile, Wikipedia](https://en.wikipedia.org/wiki/St_Mark%27s_Campanile), [The Bells of St Mark's Campanile](https://campanilevenice.com/the-bells/)
- [Bucentaur, Wikipedia](https://en.wikipedia.org/wiki/Bucentaur)
- [Marriage of the Sea, Wikipedia](https://en.wikipedia.org/wiki/Marriage_of_the_Sea_ceremony), [Festa della Sensa, Wikipedia](https://en.wikipedia.org/wiki/Festa_della_Sensa)
- [Conoscere Venezia: secret denunciations and bocche di leone](https://www.conoscerevenezia.it/?p=51340), [Inside the Lagoon: Bocca di Leone](https://insidethelagoon.com/venetian-culture/lions-mouth-council-of-ten/), [Council of Ten, Wikipedia](https://en.wikipedia.org/wiki/Council_of_Ten)
- [Portolan chart](https://en.wikipedia.org/wiki/Portolan_chart), [Rhumbline network](https://en.wikipedia.org/wiki/Rhumbline_network), [Pietro Vesconte](https://en.wikipedia.org/wiki/Pietro_Vesconte), [Compass rose](https://en.wikipedia.org/wiki/Compass_rose), [Fra Mauro map](https://en.wikipedia.org/wiki/Fra_Mauro_map)
- [View of Venice, Wikipedia](https://en.wikipedia.org/wiki/View_of_Venice), [Cleveland Museum of Art 1949.565](https://www.clevelandart.org/art/1949.565), [Wikimedia Commons file](https://commons.wikimedia.org/wiki/File:Jacopo_de'_Barbari_-_View_of_Venice_-_Google_Art_Project.jpg)
- [St Mark's Basilica guide](https://www.italyguides.it/en/veneto/venice/st-mark-s-square/st-mark-s-basilica), [St Mark's Basilica, Wikipedia](https://en.wikipedia.org/wiki/St_Mark%27s_Basilica), [gold tesserae decay and manufacture (ICCM)](https://iccm-mosaics.org/wp-content/uploads/2017/12/Loukopoulou.pdf), [See Venice: mosaics](https://www.seevenice.it/en/mosaics-in-venice-what-heaven-is-made-of)
- [Mariegola, Wikipedia](https://en.wikipedia.org/wiki/Mariegola), [Muda, Wikipedia](https://en.wikipedia.org/wiki/Muda_(convoy))
- [Mowbray and Gollmann, Electing the Doge of Venice (2007)](https://gwern.net/doc/cs/security/2007-mowbray.pdf), [Schneier summary](https://www.schneier.com/blog/archives/2007/07/security_analys_1.html), [Molinari et al. (2020)](https://moodle.epfl.ch/pluginfile.php/2849029/mod_resource/content/1/Molinari2020_Article_HowTheRepublicOfVeniceChoseIts.pdf)
