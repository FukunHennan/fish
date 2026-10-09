#!/usr/bin/env node
// Fail CI/push if a generated or transient file was force-added to Git.
import { execFileSync } from 'node:child_process';

const revision = process.argv[2] ?? 'HEAD';
const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', revision], { encoding: 'utf8' }).split('\0').filter(Boolean);
const forbidden = paths.filter(path =>
  path.startsWith('controller/diagnostics/runs/') ||
  path.startsWith('controller/diagnostics/restored/') ||
  path.startsWith('output/vision/recordings/') ||
  path.startsWith('vision/.venv/') ||
  path.startsWith('controller/frontend/node_modules/') ||
  /(^|\/)__pycache__\//.test(path) ||
  /^controller\/\.runtime\/users\.json(?:\.sessions\.json.*|\.previous|\.reservations\.json\.previous)$/.test(path) ||
  /^controller\/\.runtime\/.*\.(?:exe|pid)$/.test(path) ||
  /^controller\/\.runtime\/cloudflared-live\.yml$/.test(path) ||
  /\.(?:mp4|avi|mkv|mov|webm)$/i.test(path)
);
if (forbidden.length) {
  console.error(`Transient or downloaded files are tracked by ${revision}:\n${forbidden.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Repository content check passed (${revision}).`);
}
