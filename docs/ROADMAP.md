# Roadmap: known limits

This is what Venezia does not do yet, or does not do well. Nothing here is hidden behind a
feature that claims otherwise.

## Proof

- Three small real projects have gone end to end on real Claude (Marea, Gloria and Tiziano). That is thin evidence. Multi-item
  galleys and galleasses are tested on a fake Claude only.
- GitHub Pages has published real projects live (Gloria and Tiziano). `vercel` and `cloudflare` are probes that
  report what setup is needed, not adapters.
- A real iPhone has linked and used Venezia. Android, and installing the certificate for the phone's
  microphone, are still untried.
- Voice is tested with real speech through Chrome's audio capture and the real speech helper. A physical
  microphone, the first-time permission prompt and Bluetooth headsets are still to be confirmed.

## The factory

- Resuming a project took up to 60 seconds in the proof run. `recover()` does not go through that path.
- A retrospective can blame the wrong thing. Marea's named only the port.
- The reviewer can accept a project with a major finding open. Marea's phone layout flaw stands.
- A prototype's address only holds while the engine runs. After a restart a ship can come back on a different port, so a `local` publish keeps the address it had, and the Preview tab is the one to trust.
- Only npm projects can be contracted. Python is out for v1.
- Worker cost is a list-price meter, not your real bill.
- The rate limit guard reads Claude's own signals, and has never been tested at the real limit.

## Voice

- With the web client transcribe-only, even a safe command such as stop takes one more tap.
- A spoken "yes" after a read-back gives you a chip to tap. It does not run the command.
- When the grammar cannot read a sentence the server may still call the small classifier, so
  transcribe-only is not free of model use.

## Surfaces

- Evidence from gate runs before the `screenshots` list shows no pictures in the folio. That
  includes Marea. The files are still in `data/evidence/`.
- The `/api/health` alarm reaches the page by polling every 30 seconds, so it can lag. The message
  is the host's own and can be technical.
- The demo's questions and contract are scripted, and your idea does not shape them.
- Zoom at 300% and 400% hides the deck and leaves the card scrolling. That has not been judged
  against the accessibility bar.
- Dawn and noon world contrast, the mosaic void, the first-run wall at 1440 wide and some fiction
  words in intake and Settings are open design items.
- Minors not examined: tap target edge cases, key legend contrast, first-load size, idle power,
  reduced motion, radio groups, heading order.

## Platform

- macOS only for the sandbox and voice helper. Voice typing needs macOS 26.
- One person, one machine. There are no accounts, and a paired device can approve anything.

## Bring your own model

- API key support: let a person run Venezia on their own Anthropic API key. Workers leave `ANTHROPIC_API_KEY`
  out of their environment today, so this needs a deliberate change and a real test.
- Other providers: Venezia is built around Claude Code, so supporting other models means a worker adapter.
