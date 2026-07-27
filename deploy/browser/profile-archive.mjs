#!/usr/bin/env node
// Encrypt/decrypt the browser-profile tarball with AES-256-GCM.
//
// The plaintext profile lives under /work/.mari and is therefore excluded from
// normal workspace snapshots. Only this authenticated archive is persisted.
// Format: 8-byte magic, 12-byte nonce, ciphertext, 16-byte GCM tag.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('MARIBR1\0', 'ascii');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function usage() {
  throw new Error('usage: profile-archive.mjs encrypt|decrypt KEY_FILE INPUT OUTPUT');
}

async function readKey(path) {
  const { readFile } = await import('node:fs/promises');
  const encoded = (await readFile(path, 'utf8')).trim();
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error(`browser profile key must decode to 32 bytes, got ${key.length}`);
  return key;
}

function safeUnlink(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function encrypt(key, input, output) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const temp = `${output}.tmp`;
  safeUnlink(temp);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeSync(fd, MAGIC);
    writeSync(fd, nonce);
  } finally {
    closeSync(fd);
  }
  await pipeline(createReadStream(input), cipher, createWriteStream(temp, { flags: 'a', mode: 0o600 }));
  const tagFd = openSync(temp, 'a');
  try {
    writeSync(tagFd, cipher.getAuthTag());
  } finally {
    closeSync(tagFd);
  }
  renameSync(temp, output);
}

async function decrypt(key, input, output) {
  if (!existsSync(input)) return false;
  const fd = openSync(input, 'r');
  let size;
  const header = Buffer.alloc(MAGIC.length + NONCE_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    size = fstatSync(fd).size;
    if (size < header.length + TAG_BYTES) throw new Error('browser profile archive is truncated');
    readSync(fd, header, 0, header.length, 0);
    readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    closeSync(fd);
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('browser profile archive has an unknown format');
  }
  const nonce = header.subarray(MAGIC.length);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const temp = `${output}.tmp`;
  safeUnlink(temp);
  try {
    await pipeline(
      createReadStream(input, { start: header.length, end: size - TAG_BYTES - 1 }),
      decipher,
      createWriteStream(temp, { flags: 'wx', mode: 0o600 }),
    );
    renameSync(temp, output);
    return true;
  } catch (error) {
    safeUnlink(temp);
    throw error;
  }
}

const [mode, keyPath, input, output, ...extra] = process.argv.slice(2);
if (!mode || !keyPath || !input || !output || extra.length > 0) usage();
const key = await readKey(keyPath);
if (mode === 'encrypt') await encrypt(key, input, output);
else if (mode === 'decrypt') await decrypt(key, input, output);
else usage();
