// A reproducible tarball, written by hand. Nothing about the machine or the moment gets in,
// so the same files always give the same SHA-256 (research 05, section 5.4).

import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const BLOCK = 512;

function header(name, size) {
  const block = Buffer.alloc(BLOCK);
  let prefix = '';
  let shortName = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.indexOf('/', Math.max(0, name.length - 101));
    if (cut < 0 || cut > 155 || Buffer.byteLength(name) > 255) throw new Error(`${name} is too long for a tar header`);
    prefix = name.slice(0, cut);
    shortName = name.slice(cut + 1);
  }
  const octal = (value, length) => value.toString(8).padStart(length - 1, '0');
  block.write(shortName, 0);
  block.write(octal(0o644, 8), 100);
  block.write(octal(0, 8), 108);
  block.write(octal(0, 8), 116);
  block.write(octal(size, 12), 124);
  block.write(octal(0, 12), 136);
  block.fill(' ', 148, 156);
  block.write('0', 156);
  block.write('ustar', 257);
  block.write('00', 263);
  block.write(prefix, 345);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${octal(sum, 7)}\0 `, 148);
  return block;
}

/**
 * Pack files, in sorted order, with fixed owner, mode and time.
 * @param {string} root
 * @param {string[]} files paths relative to `root`, with forward slashes
 * @returns {Buffer} gzipped tar
 */
export function packTarball(root, files) {
  const blocks = [];
  for (const file of [...files].sort()) {
    const body = fs.readFileSync(path.join(root, file));
    blocks.push(header(file, body.length), body);
    const padding = (BLOCK - (body.length % BLOCK)) % BLOCK;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}
