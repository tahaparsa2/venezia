import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../engine/config.mjs';
import {
  DENY_RULES, DOCTRINE_NOTE, sessionPermissionUpdates, workerEnv, workerSettings, writeWorkerSettings,
} from '../engine/doctrine/worker-settings.mjs';
import { testDir } from './helpers.mjs';

test('worker.json holds every rule SPEC 6 lists', (t) => {
  const config = loadConfig({ root: testDir(t) });
  const settings = workerSettings(config);
  assert.equal(settings.autoMemoryEnabled, false);
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  for (const dir of ['~/.ssh', '~/.claude', '~/.config/gh', '~/.aws']) {
    assert.ok(settings.sandbox.filesystem.denyRead.includes(dir), dir);
  }
  assert.deepEqual(settings.sandbox.network.allowedDomains, ['registry.npmjs.org']);
  assert.ok(settings.sandbox.filesystem.allowWrite.includes(config.npmCacheDir));
  for (const rule of ['Bash(gh *)', 'Bash(git push *)', 'Bash(vercel *)', 'Bash(wrangler *)', 'Bash(curl *)']) {
    assert.ok(settings.permissions.deny.includes(rule), rule);
  }
});

test('no bare allow rule, and no way to loosen the mode, ever appears', (t) => {
  const settings = workerSettings(loadConfig({ root: testDir(t) }));
  assert.equal(settings.permissions.allow, undefined);
  assert.equal(settings.permissions.defaultMode, undefined);
  assert.equal(JSON.stringify(settings).includes('bypassPermissions'), false);
  assert.equal(DENY_RULES.includes('Bash'), false);
});

test('worker.json follows the allowlist in config, and lives outside any yard', (t) => {
  const config = loadConfig({ root: testDir(t), sandbox: { allowedDomains: ['registry.npmjs.org', 'example.org'] } });
  const file = writeWorkerSettings(config);
  assert.ok(file.startsWith(config.dataDir));
  assert.equal(file.startsWith(config.yardsDir), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).sandbox.network.allowedDomains, ['registry.npmjs.org', 'example.org']);
  assert.ok(fs.statSync(config.npmCacheDir).isDirectory());
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')), []);
});

test('the environment loses CLAUDE variables and credentials, whatever their case', (t) => {
  const config = loadConfig({ root: testDir(t) });
  const env = workerEnv({
    PATH: '/bin', HOME: '/home/me', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1', claude_lower: 'x', AI_AGENT: 'x',
    ANTHROPIC_API_KEY: 'k', GH_TOKEN: 't', GITHUB_TOKEN: 't', NPM_TOKEN: 't', AWS_PROFILE: 'p', SSH_AUTH_SOCK: 's', UNSET: undefined,
  }, config);
  assert.deepEqual(Object.keys(env).sort(), ['GH_CONFIG_DIR', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'HOME', 'PATH', 'npm_config_cache', 'npm_config_userconfig']);
});

test('the empty gh folder stays empty and belongs to the host', (t) => {
  const config = loadConfig({ root: testDir(t) });
  const env = workerEnv({}, config);
  assert.deepEqual(fs.readdirSync(env.GH_CONFIG_DIR), []);
  assert.ok(env.GH_CONFIG_DIR.startsWith(config.dataDir));
  assert.equal(env.npm_config_cache, path.join(config.dataDir, 'npm-cache'));
});

test('"always" only keeps scoped command rules, for the session', () => {
  const scoped = { toolName: 'Bash', ruleContent: 'touch:*' };
  assert.deepEqual(sessionPermissionUpdates([
    { type: 'addRules', rules: [scoped], behavior: 'allow', destination: 'localSettings' },
  ]), [{ type: 'addRules', rules: [scoped], behavior: 'allow', destination: 'session' }]);

  const dropped = [
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
    { type: 'addDirectories', directories: ['/'], destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: '' }], behavior: 'allow', destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: '*' }], behavior: 'allow', destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: ':*' }], behavior: 'allow', destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '/**' }], behavior: 'allow', destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'Write', ruleContent: '/etc/**' }], behavior: 'allow', destination: 'session' },
    { type: 'addRules', rules: [scoped], behavior: 'deny', destination: 'session' },
    null,
  ];
  assert.deepEqual(sessionPermissionUpdates(dropped), []);
  assert.deepEqual(sessionPermissionUpdates(undefined), []);
  assert.deepEqual(sessionPermissionUpdates('addRules'), []);
});

test('doctrine has a note about long sleeps', () => {
  assert.match(DOCTRINE_NOTE, /sleep/);
});
