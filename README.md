# Venezia

Venezia is a one-person software factory that runs on your Mac. You say or type an idea. Claude
writes a contract for it, builds it, and your Mac tests the result in a real browser. Only code
that passes those mechanical checks gets a receipt, and only you can publish it. No model decides
that something is done.

## What you need

- A Mac. Voice typing needs macOS 26 or later. The keyboard works without it.
- Node 25 and Google Chrome.
- The `claude` command, signed in.

Real projects spend your Claude usage. The demo does not.

### Which Claude account

Venezia runs the unmodified `claude` command under your own sign-in. Check the terms for your
account before you run real projects:

- **A Claude subscription** is the default, and the only route tested. Anthropic's
  [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) bar access by bot or script,
  unless you use an API key or Anthropic permits it. Its
  [Claude Code terms](https://code.claude.com/docs/en/legal-and-compliance) allow signing in to the
  unmodified binary with your own subscription, and say advertised limits assume ordinary, individual
  use. Neither says whether unattended runs like these are allowed, and Anthropic has not confirmed it.
- **A Claude Console account** bills by API usage under Anthropic's
  [Commercial Terms](https://www.anthropic.com/legal/commercial-terms). Sign in with
  `claude auth login --console`. This has not been tried with Venezia. Cost figures become real
  charges, and the Treasury panel still describes a subscription. Setting `ANTHROPIC_API_KEY` does
  not work, because workers get a fixed environment that leaves it out.

## Start it

From this folder:

```
npm install
npm run doctor     # checks this machine, and calls no model
npm run sim        # the demo: made-up ships, nothing is built or spent
```

Open http://127.0.0.1:4800 and press around. Stop it with Ctrl-C.

For real work:

```
npm start
```

Then speak or type an idea on the page, or from another terminal:

```
node bin/vz.mjs new "A tip calculator for splitting a bill"
node bin/vz.mjs status
```

`node bin/vz.mjs` with no arguments lists every command.

## Use it from your phone

Your phone must be on the same Wi-Fi as your Mac.

```
node bin/vz.mjs serve --lan
```

In a second terminal:

```
node bin/vz.mjs pair
```

Say yes in the prompt on your Mac. Scan the QR code with your phone and enter the PIN it shows.
A paired phone can approve anything you can. `vz pair --list` shows paired devices, and
`vz pair --revoke <id>` removes one. Pairing is tested against the real server, but not yet on a
physical phone.

On the phone, hold Talk and speak. What it heard sits on a chip until you choose Nudge (fold it
in), Next (after this job) or Now (change course), so a mishearing costs one tap.

## How a project moves

Idea, then questions if it is unclear, then a contract that says what done means, then a build,
then the gate: tests, a secret scan, and a real browser on phone and desktop sizes. A separate
reviewer who did not build it checks the result. If it passes, you get a receipt and a local
prototype you can use. Publishing needs your say, and a public publish needs you to hold the button.

A finished project keeps its prototype for as long as its receipt holds. The Preview tab starts it
and shows **Open prototype** with its address, and `vz open Marea` does the same from the command
line. It always serves what the gate tested, never the working files. A restart stops every
prototype, and opening one brings it back. Three run at once by default (`maxPreviews` in the
config), and the one opened longest ago stops to make room. A voided receipt, a scuttled project
or a failed one has nothing to open.

## What is proven, and what is not

Two real projects have gone from idea to `done` on real Claude. The second, Gloria, is a focus timer with a
daily streak and a chime, and it was the first on the current models:

- It ran on opus for contract, build, repair and review, and sonnet for intake and scribe. The session
  logs confirm those models ran, and each run now records them as `ranModels`.
- It took 12 runs and 25 minutes to `ready`. No run passed 20% of its budget or
  20% of its turn limit, and the ship used under 5% of its budget. The rate limit guard never blocked.
- The gate passed, then the reviewer rejected it for a `fetch()` in the shipped bundle. A repair fixed
  that, and the whole gate ran again.
- A full 25 minutes ran in real Chrome: the chime played once and the streak survived a reload. The
  chime came about 12 seconds late with nobody at the tab. The likely cause is timer throttling, which
  was not proven.
- It still stopped on five tool cards at the highest autonomy. Tool cards now follow the autonomy
  setting, so confined work no longer stops at that level, and each such call goes on the log with
  the reason. A full real run of that has not finished: see below.

Marea, a tip calculator that splits a bill, came first:

- The gate passed first try, in 6.5 seconds, including its jail and browser checks. The reviewer
  accepted it, and the receipt is valid.
- It took 35 minutes. The rate limit guard never blocked.
- A steer landed while it was building, and a refit also ran on real Claude.
- Its prototype opens from the real server in Chrome, before and after a restart, and works there
  in the frame and in its own tab. `node test/ui/real-prototype.mjs` checks this and spends nothing.
- That run found five real problems, now fixed or handled: heredocs and `rm -rf` stopped workers,
  git died on `~/.gitconfig`, `listen` was refused, a hardcoded port slipped through, and deny
  rules blocked finished work.

The first real run of the autonomy policy did not finish. A coin flip started at the highest
autonomy from the command line, and intake ran on real Claude with no tool card and one logged
automatic allow. Then the rate limit guard held it at the start of the contract, because the
seven-day limit was over the guard's threshold, and the guard was left alone. The hook and the
prompt it forces were checked on real Claude, but writes, commands and the gate at this level
have only run on the fake Claude.

Not proven:

- Two small projects are two small projects. Larger ships (galleys with many items, galleasses) have not been
  run on real Claude from start to finish.
- Nothing has been published to the internet from a real run. Both launches were local, and the GitHub
  Pages path was only rehearsed.
- Marea's reviewer also raised a real flaw: on a phone the result sits below the fold. It was
  accepted and not fixed.

The automated tests use a fake Claude and do not spend usage. Run them with `npm test`, and the
browser checks with `npm run test:ui`. Real-Claude runs need `VENEZIA_E2E=1`.

Known limits are in [docs/ROADMAP.md](docs/ROADMAP.md). The binding design is in
[docs/SPEC.md](docs/SPEC.md).

## Security

Venezia runs code that a model wrote, on your Mac. Read [SECURITY.md](SECURITY.md) first, above all
before you use `--lan`. Changes are in [CHANGELOG.md](CHANGELOG.md).

## Acknowledgements

Venezia took inspiration from [3DMK](https://3dmk.com/), the agentic development stack documented
by Nick Olson. The research notes in [docs/research/01-3dmk.md](docs/research/01-3dmk.md) summarise
its documents, and the worker rule that a report is a claim, not proof, comes from it. That material
is under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit: "Nick Olson, 3dmk.com".
Venezia is an independent project, and it is not affiliated with or endorsed by Nick Olson or 3DMK.

The idea of a plain-code outer loop owes a lot to
[bmad-loop](https://github.com/bmad-code-org/bmad-loop) (MIT).

Fonts in `web/fonts/` are Cardo and DM Mono, under the SIL Open Font License 1.1. Runtime
dependencies are `ws` (MIT), `qrcode-generator` (MIT) and `playwright-core` (Apache-2.0).

## Licence

Not chosen yet, so for now all rights are reserved. See [docs/PUBLISHING.md](docs/PUBLISHING.md).
