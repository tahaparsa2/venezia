# Security

Venezia is a local tool for one person on one Mac. It has not had an outside security review. Read this before you run it, and before you turn on LAN access.

## What Venezia runs

- A Node server on your Mac, which holds the state and decides what happens next.
- `claude` worker processes on your existing Claude Code login. Venezia needs no API keys of its own.
- Your system Chrome, for the gate's browser checks.
- **Generated code.** Claude writes the projects, and Venezia then runs what it wrote: builds, tests, start scripts and contract checks. Treat all of it as untrusted.

## How generated code is contained

- Workers run in Claude Code's sandbox with an explicit tool list, deny rules for publishing commands, and no reads of the usual credential folders (`~/.ssh`, `~/.aws`, `~/.config/gh` and others). Network access is limited to an allowlist, which is `registry.npmjs.org` by default. Anything else asks you first.
- The autonomy setting decides when a tool call stops for you, and only inside those limits. At the highest level, work confined to the project and the sandbox runs without asking, and each such call is on the log with the reason. No level opens a write outside the project, a credential path, a publishing command or a new network host, and a worker cannot change the setting itself.
- Yard code runs in a macOS Seatbelt jail: writes only to its own folders, no reads of the host, the other yards or any credential, and loopback only on its own port. There is no fallback. If the jail cannot start, no yard code runs.
- Both layers depend on macOS. Do not expect the same protection on another platform.
- A sandbox reduces the damage a mistake can do. It is not a promise against a determined attacker, so do not build things you would not run on this Mac.

## Network

- The server binds `127.0.0.1:4800` by default, and it refuses to serve plain HTTP on any other address.
- Every request and WebSocket upgrade is checked for Host and Origin, which stops DNS rebinding and cross-site requests.
- Preview servers run on their own port for each project, so a project is a separate origin.

## Phone access and pairing

Phone access is off until you ask. Press Link a phone in Settings, run `./vz pair`, or start with `./vz serve --lan`. It then listens on port 8443 by default, over HTTPS only. Turn it off in Settings or with `./vz pair --off`: that closes the listener and disconnects every device. It is off again after a restart without `--lan`.

- HTTPS uses a local certificate authority that Venezia creates in `data/net/`. Its root is name-constrained to `.local`, `localhost` and private addresses, so a stolen key cannot intercept public sites. Installing that root on a phone is still a real trust decision.
- Link a phone gives a QR code that holds only an address. The PIN appears in one place: a box on the Mac, shown by the host. It is in no HTTP answer, and it reaches the box on stdin, so it is not in the process list either. That is the whole check: anything local that sends a browser's headers can start a link, but it learns nothing, and a person has to carry the PIN to a device.
- The PIN works once, expires after 5 minutes, allows 5 tries, and wrong tries are also limited per address. Only one box shows at a time, and six in ten minutes. Cancel closes the box and puts phone access back as it was.
- Turning phone access off, listing devices and removing a device need no proof, because they only look or take access away. So a local process that forges a browser can disconnect your phone. It cannot let anything in.
- Before pairing, the LAN can reach only the pairing page, the claim endpoint and the certificate downloads.
- **A paired device can approve anything you can**, for up to a year, until revoked. Removing a device cuts every connection it has open. Turning phone access off does not unpair anything. List devices with `./vz pair --list` and remove one with `./vz pair --revoke <id>`.
- A phone that has not installed your certificate cannot tell who it is talking to, so nothing secret goes in the QR. That leaves one gap: on a hostile network, a fake page at the same address could ask for the PIN. Link on your own Wi-Fi. To be sure, compare the fingerprint under Check this is your Mac on both screens. A PIN taken that way still works only once and only while the box is open.
- A device paired in the demo is kept apart, and cannot open the real factory.
- Linking is tested against the real server on a real network address, but not yet on a physical phone.

## Publishing

Only the host can publish, and only an artifact that passed the gate, matched by hash. Public publishing needs a hold on a button or `./vz approve --confirm`, every time, at every autonomy level. Voice and MCP can ask for it but cannot approve it. No model decides that something is safe to publish.

The gate's secret scan matches known secret shapes. It will not catch everything.

## What stays on your machine

`data/`, `yards/` and the generated memory in `portolano/` hold your project history, evidence, the local CA and pairing records. `.gitignore` keeps them out of this repository. Keep it that way, and take care when sharing logs or evidence from them.

## Reporting a problem

Please do not open a public issue for a vulnerability. Use private vulnerability reporting on this repository's GitHub page: the Security tab, then "Report a vulnerability". Include the steps to reproduce it and the version from `package.json`.

This is a personal project, so there is no response time promise. Only the latest version on `main` is supported.
