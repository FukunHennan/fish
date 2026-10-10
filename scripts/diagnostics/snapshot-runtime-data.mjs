#!/usr/bin/env node
// Copy durable account and reservation state into Git snapshots before upload.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = JSON.parse(readFileSync(join(root, 'config', 'program.json'), 'utf8'));
const configuredPath = config?.environment?.FISH_AUTH_USERS ?? config?.FISH_AUTH_USERS;
if (typeof configuredPath !== 'string' || !configuredPath.trim()) {
  console.error('FISH_AUTH_USERS is not configured; account snapshot was not refreshed.');
  process.exitCode = 1;
} else {
  const source = isAbsolute(configuredPath) ? configuredPath : resolve(root, configuredPath);
  const targetDir = join(root, 'controller', '.runtime');
  if (!existsSync(source)) {
    if (existsSync(join(targetDir, 'users.json'))) {
      console.log('Live account database is not present; keeping the existing repository snapshot.');
    } else {
      console.error(`Account database and repository snapshot are missing: ${source}`);
      process.exitCode = 1;
    }
  } else {
    mkdirSync(targetDir, { recursive: true });
    for (const suffix of ['', '.reservations.json']) {
      const from = `${source}${suffix}`;
      if (!existsSync(from)) continue;
      const data = readFileSync(from);
      JSON.parse(data.toString('utf8')); // Do not snapshot a partially written JSON file.
      writeFileSync(join(targetDir, `users.json${suffix}`), data);
    }
    console.log('Durable account and reservation snapshots refreshed.');
  }
}
