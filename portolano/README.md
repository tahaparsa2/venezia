# Portolano

The factory's memory, in files you can read. A portolano was a sailor's book of harbours, hazards and courses, written down by those who had been there.

| File | What it is | Who writes it |
|---|---|---|
| `mariegola.md` | The rulebook: lessons you confirmed as law | The factory appends. Nothing is ever edited in place |
| `ATLAS.md` | An index of every project | Regenerated from the event log |
| `lessons/*.md` | One file per lesson, with its record | Regenerated from the event log |

The event log is the source of truth, and these files mirror it. To change what workers are told, use the lesson commands, not these files:

- `vz lessons` lists lessons.
- Promote a lesson to make it a rule. Only you can do that.
- Burn a lesson to throw it away. Burning a rule adds a "Withdrawn" entry to the Mariegola, and the original stays.

Each lesson file has a notes line near its end. Anything you write below that line is kept whenever the file is rewritten.

Lessons are screened for anything shaped like a secret before they get here.

Your memory stays on this machine. `ATLAS.md` and `lessons/*` are ignored by git, because they hold your project history. Git tracks only this README and the empty `mariegola.md` template, so a promoted rule shows up as a local change to `mariegola.md`. Do not commit that change to a public repository.
