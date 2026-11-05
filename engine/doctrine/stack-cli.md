# Stack guidance: commands and libraries

The gate tests what a stranger would receive. It packs the project, installs the tarball into an empty folder and runs the contract's `golden` commands, comparing exit code and output. It does not run your working tree.

**Default: Node 25 ES modules with no runtime dependencies.** Add a dependency only when the idea needs it. Use Node even if another language would suit: locked scripts and test counting are built around npm, so a project in another language is a gap to raise.

## Node command

```json
{
  "name": "tide",
  "version": "0.1.0",
  "type": "module",
  "bin": { "tide": "bin/tide.js" },
  "files": ["bin", "src"],
  "scripts": { "test": "node --test --test-reporter=tap" }
}
```

- The `bin` file starts with `#!/usr/bin/env node`.
- Exit 0 on success and non-zero on failure. Errors go to stderr, results to stdout.
- `--help` works and says how to use the command.
- `golden` commands reach the command through `$BIN/tide`.

## Node library

- Set `exports` and make sure each path it names is in `files`. A file left out of the tarball passes your tests and fails the gate.
- A golden command runs a real import: `node -e "import('name').then(m => console.log(m.add(2, 2)))"`, from the installed package.

## What the gate needs

- A lockfile, if there is a `package.json`. Install must work with `npm ci --ignore-scripts`.
- Everything the program imports is declared in `dependencies`, not just present in `node_modules` by luck.
- Output is deterministic: no timestamps, random values or absolute paths in stdout that a golden check reads.
- No network at run time and no reading files outside the arguments given.
- Tests use `node:test` and print TAP, so the gate can count them.
