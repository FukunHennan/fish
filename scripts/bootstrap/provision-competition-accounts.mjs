import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run once with three environment variables. This writes the active account store.
const passwords = [
  process.env.FISH_BLUE_PASSWORD,
  process.env.FISH_RED_PASSWORD,
  process.env.FISH_REFEREE_PASSWORD,
];
if (passwords.some((password) => !password)) {
  throw new Error('请设置 FISH_BLUE_PASSWORD、FISH_RED_PASSWORD、FISH_REFEREE_PASSWORD');
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const program = JSON.parse(readFileSync(join(root, 'config', 'program.json'), 'utf8'));
const configuredPath = process.env.FISH_AUTH_USERS || program.environment?.FISH_AUTH_USERS || '../Pro1-runtime/users.json';
const base = isAbsolute(configuredPath) ? configuredPath : resolve(root, configuredPath);
const now = new Date().toISOString();
const definitions = [
  ['1', '蓝队', 'User'],
  ['2', '红队', 'User'],
  ['3', '裁判', 'Admin'],
];
const users = {};
for (const [index, [email, name, role]] of definitions.entries()) {
  const salt = randomBytes(16).toString('hex');
  users[email] = {
    id: randomBytes(12).toString('hex'), name, email, role, status: 'active',
    passwordSalt: salt,
    passwordHash: createHash('sha256').update(`${salt}\0${passwords[index]}`).digest('hex'),
    createdAt: now,
  };
}
mkdirSync(dirname(base), { recursive: true });
const backupSuffix = `.backup-${Date.now()}`;
if (existsSync(base)) {
  // Validate before replacing; the original data remains in the backup.
  JSON.parse(readFileSync(base, 'utf8'));
  renameSync(base, base + backupSuffix);
}
const sessionsPath = base + '.sessions.json';
if (existsSync(sessionsPath)) renameSync(sessionsPath, sessionsPath + backupSuffix);
writeFileSync(base + '.tmp', JSON.stringify(users, null, 2), { mode: 0o600 });
renameSync(base + '.tmp', base);
writeFileSync(sessionsPath, '{}', { mode: 0o600 });
console.log('已配置三个账号：1=蓝队，2=红队，3=裁判。原账户文件已备份。');
