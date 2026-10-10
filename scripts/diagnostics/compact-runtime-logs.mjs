#!/usr/bin/env node
// Preserve completed diagnostic sessions as verified gzip archives and a small index.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const mode = args[0] ?? '--apply';
const rootArg = args.indexOf('--root');
const projectRoot = rootArg >= 0 ? resolve(args[rootArg + 1] ?? '') : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const diagnostics = join(projectRoot, 'controller', 'diagnostics');
const runs = join(diagnostics, 'runs');
const archives = join(diagnostics, 'archives');
const indexPath = join(diagnostics, 'ARCHIVE_INDEX.md');
const restored = join(diagnostics, 'restored');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const validId = id => /^\d{8}-\d{6}-\d+$/.test(id);

function assertInside(parent, target) {
  const rel = relative(resolve(parent), resolve(target));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(rel) === rel) {
    throw new Error(`Unsafe path: ${target}`);
  }
}

function filesIn(dir) {
  const result = [];
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink in diagnostic session: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result.push(path);
      else throw new Error(`Unsupported file type: ${path}`);
    }
  }
  visit(dir);
  return result.sort();
}

function makeArchive(id, dir) {
  const files = filesIn(dir).map(path => {
    const data = readFileSync(path);
    return { path: relative(dir, path).replaceAll('\\', '/'), sha256: sha256(data), data: data.toString('base64') };
  });
  if (!files.length) throw new Error(`Empty diagnostic session: ${id}`);
  return { version: 1, id, files };
}

function decodeArchive(path) {
  const archive = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'));
  if (archive.version !== 1 || !validId(archive.id) || basename(path) !== `${archive.id}.json.gz` || !Array.isArray(archive.files)) {
    throw new Error(`Invalid archive: ${path}`);
  }
  const seen = new Set();
  for (const file of archive.files) {
    const normalized = file.path.replaceAll('/', sep);
    if (!file.path || file.path.includes('\\') || seen.has(file.path)) throw new Error(`Invalid archive member: ${file.path}`);
    assertInside(join(diagnostics, 'restored', archive.id), join(diagnostics, 'restored', archive.id, normalized));
    seen.add(file.path);
    if (sha256(Buffer.from(file.data, 'base64')) !== file.sha256) throw new Error(`Archive checksum mismatch: ${file.path}`);
  }
  return archive;
}

function summarize(archive, compressedBytes) {
  const stats = { INFO: 0, WARN: 0, ERROR: 0, HTTP4xx: 0, HTTP5xx: 0 };
  const events = new Map();
  const structured = archive.files.find(file => file.path === 'controller.jsonl');
  if (structured) {
    for (const line of Buffer.from(structured.data, 'base64').toString('utf8').split(/\r?\n/)) {
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const level = String(event.level ?? '').toUpperCase();
      if (level in stats) stats[level]++;
      const status = Number(event.status ?? event.status_code ?? 0);
      if (status >= 400 && status < 500) stats.HTTP4xx++;
      if (status >= 500 && status < 600) stats.HTTP5xx++;
      if (level === 'WARN' || level === 'ERROR') {
        const name = String(event.msg ?? 'unknown').replaceAll('|', '/').slice(0, 80);
        events.set(name, (events.get(name) ?? 0) + 1);
      }
    }
  }
  const rawBytes = archive.files.reduce((sum, file) => sum + Buffer.from(file.data, 'base64').length, 0);
  const notable = [...events.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3)
    .map(([name, count]) => `${name} ×${count}`).join('；') || '—';
  return `| ${archive.id} | ${archive.files.length} | ${stats.INFO}/${stats.WARN}/${stats.ERROR} | ${stats.HTTP4xx}/${stats.HTTP5xx} | ${notable} | ${rawBytes}/${compressedBytes} | [下载](archives/${archive.id}.json.gz) |`;
}

function buildIndex() {
  const rows = existsSync(archives) ? readdirSync(archives).filter(name => name.endsWith('.json.gz')).sort().reverse().map(name => {
    const path = join(archives, name);
    return summarize(decodeArchive(path), readFileSync(path).length);
  }) : [];
  return `# 诊断日志归档索引\n\n每次上传前，已结束的会话会压缩保存；运行中的最新会话只保留在本机。归档保留原始文件及 SHA-256 校验，字节数一栏为原始/压缩大小。录像只在本机保存。\n\n| 会话 | 文件数 | INFO/WARN/ERROR | HTTP 4xx/5xx | 主要异常事件 | 字节数 原始/压缩 | 归档 |\n| --- | ---: | ---: | ---: | --- | ---: | --- |\n${rows.join('\n')}${rows.length ? '\n' : ''}\n恢复单次会话：\`node scripts/diagnostics/compact-runtime-logs.mjs --restore <会话编号>\`，文件写入 \`controller/diagnostics/restored/\`。\n`;
}

function activeId() {
  const path = join(runs, 'LATEST.txt');
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
}

function processStillRunning(dir) {
  try {
    const pid = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8')).pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    return false;
  }
}

function completedRuns() {
  if (!existsSync(runs)) return [];
  const active = activeId();
  return readdirSync(runs, { withFileTypes: true }).filter(entry => entry.isDirectory() && validId(entry.name) && entry.name !== active && !processStillRunning(join(runs, entry.name))).map(entry => entry.name).sort();
}

try {
  if (mode === '--restore') {
    const id = args[1];
    if (!validId(id)) throw new Error('Provide a valid session ID.');
    const archive = decodeArchive(join(archives, `${id}.json.gz`));
    const target = join(restored, id);
    if (existsSync(target)) throw new Error(`Restore target already exists: ${target}`);
    for (const file of archive.files) {
      const path = join(target, file.path.replaceAll('/', sep));
      assertInside(target, path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(file.data, 'base64'));
    }
    console.log(`Restored ${archive.files.length} files to ${target}`);
  } else if (mode === '--apply' || mode === '--check') {
    const pending = completedRuns();
    if (mode === '--check' && pending.length) throw new Error(`${pending.length} completed diagnostic sessions have not been archived. Run --apply before committing.`);
    if (mode === '--apply') {
      mkdirSync(archives, { recursive: true });
      for (const id of pending) {
        const dir = join(runs, id);
        assertInside(runs, dir);
        if (!lstatSync(dir).isDirectory()) throw new Error(`Not a directory: ${dir}`);
        const source = makeArchive(id, dir);
        const path = join(archives, `${id}.json.gz`);
        if (existsSync(path)) {
          const prior = decodeArchive(path);
          if (JSON.stringify(prior) !== JSON.stringify(source)) throw new Error(`Existing archive differs from source: ${id}`);
        } else {
          writeFileSync(path, gzipSync(Buffer.from(JSON.stringify(source)), { level: 9 }));
        }
        if (JSON.stringify(decodeArchive(path)) !== JSON.stringify(source)) throw new Error(`Archive verification failed: ${id}`);
        // Only remove a completed session after the archive is written and verified.
        rmSync(dir, { recursive: true });
      }
    }
    const index = buildIndex();
    if (mode === '--check') {
      if (!existsSync(indexPath) || readFileSync(indexPath, 'utf8') !== index) throw new Error('Diagnostic archive index is stale. Run --apply.');
      console.log('Diagnostic archives and index verified.');
    } else {
      writeFileSync(indexPath, index);
      console.log(`Archived ${pending.length} completed sessions; index covers ${readdirSync(archives).filter(name => name.endsWith('.json.gz')).length}.`);
    }
  } else {
    throw new Error('Usage: node scripts/diagnostics/compact-runtime-logs.mjs [--apply|--check|--restore ID] [--root PATH]');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
