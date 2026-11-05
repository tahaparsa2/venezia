// A small stand-in for a real bundler, with no dependency, so the gate tests run offline.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

if (fs.existsSync('build.config.mjs')) await import(`${process.cwd()}/build.config.mjs`);

execFileSync(process.execPath, ['--check', 'src/main.js'], { stdio: 'inherit' });
fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist');
fs.cpSync('src', 'dist', { recursive: true });
if (fs.existsSync('public')) fs.cpSync('public', 'dist', { recursive: true });
fs.copyFileSync('index.html', 'dist/index.html');
