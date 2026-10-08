#!/usr/bin/env node
// Install the Windows computer-side dependencies from a checkout or ZIP.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 1;
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = new Set(process.argv.slice(2));
const allowed = new Set(['--check', '--local', '--cpu', '--firmware', '--help']);
if ([...options].some((option) => !allowed.has(option))) {
  throw new Error('未知参数。运行 node scripts/setup-windows.mjs --help 查看用法。');
}
if (options.has('--help')) {
  console.log('用法：node scripts/setup-windows.mjs [--check] [--local] [--cpu] [--firmware]');
  console.log('默认安装 Go、Python 3.12、视觉依赖和前端依赖，并构建电脑端。');
  console.log('--local 关闭本机 tunnel.json 中的公网隧道；--cpu 将本机 YOLO 设备设为 cpu。');
  console.log('--firmware 额外安装 PlatformIO 并构建固件。');
  console.log('--check 只检查当前环境，不安装或改动文件。');
  process.exit(0);
}
if (process.platform !== 'win32') {
  throw new Error('此脚本仅适用于 Windows；Linux/macOS 请参照 docs/程序/环境与构建.md。');
}

const checkOnly = options.has('--check');
const withFirmware = options.has('--firmware');
const localOnly = options.has('--local');
const cpuOnly = options.has('--cpu');
if (checkOnly && (withFirmware || localOnly || cpuOnly)) {
  throw new Error('--check 不能与会安装依赖或修改配置的选项同时使用。');
}
const frontend = join(root, 'controller', 'frontend');
const vision = join(root, 'vision');
const runtime = join(root, 'controller', '.runtime');
const venvPython = join(vision, '.venv', 'Scripts', 'python.exe');
const tunnelFile = join(root, 'config', 'tunnel.json');
const programFile = join(root, 'config', 'program.json');

function run(executable, args, { cwd = root, env = process.env, quiet = false, timeout = 0 } = {}) {
  const result = spawnSync(executable, args, {
    cwd, env, timeout: timeout || undefined, windowsHide: true,
    encoding: 'utf8', stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  return { ok: !result.error && result.status === 0, output: quiet ? `${result.stdout || ''}${result.stderr || ''}`.trim() : '', error: result.error };
}

function mustRun(executable, args, settings = {}) {
  console.log(`\n> ${basename(executable)} ${args.join(' ')}`);
  const result = run(executable, args, settings);
  if (!result.ok) throw new Error(`${basename(executable)} 执行失败${result.error ? `：${result.error.message}` : ''}`);
}

function versionAt(executable, args, pattern) {
  if (!executable) return null;
  const result = run(executable, args, { quiet: true, timeout: 15000 });
  const match = result.ok ? result.output.match(pattern) : null;
  return match ? { executable, version: match[1] } : null;
}

function findGo() {
  const candidates = [
    'go.exe',
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Go', 'bin', 'go.exe'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Go', 'bin', 'go.exe'),
  ];
  for (const candidate of candidates) {
    const found = versionAt(candidate, ['version'], /\bgo(\d+\.\d+(?:\.\d+)?)\b/);
    if (found && compareVersion(found.version, '1.23') >= 0) return found;
  }
  return null;
}

function compareVersion(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  }
  return 0;
}

function findPython312() {
  const candidates = [
    venvPython,
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Python312', 'python.exe'),
    'python.exe',
  ];
  for (const candidate of candidates) {
    const found = versionAt(candidate, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], /\b(3\.12)\b/);
    if (found) return found;
  }
  const launcher = run('py.exe', ['-3.12', '-c', 'import sys; print(sys.executable)'], { quiet: true, timeout: 15000 });
  if (launcher.ok && existsSync(launcher.output)) return { executable: launcher.output, version: '3.12' };
  return null;
}

function wingetInstall(packageId, extra = []) {
  if (!run('winget.exe', ['--version'], { quiet: true, timeout: 15000 }).ok) {
    throw new Error(`缺少 winget，无法自动安装 ${packageId}。请安装 Windows App Installer 后重试。`);
  }
  mustRun('winget.exe', [
    'install', '--id', packageId, '--exact', '--source', 'winget', '--silent',
    '--accept-package-agreements', '--accept-source-agreements', ...extra,
  ]);
}

function nodeSupported() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22;
}

function findCloudflared() {
  const candidates = [join(runtime, 'cloudflared.exe'),
    join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
    'cloudflared.exe'];
  const packageRoots = [
    join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'WinGet', 'Packages'),
  ];
  for (const packages of packageRoots) {
    if (existsSync(packages)) {
      for (const name of readdirSync(packages).filter((name) => name.startsWith('Cloudflare.cloudflared_'))) {
        candidates.push(join(packages, name, 'cloudflared.exe'));
      }
    }
  }
  for (const candidate of candidates) {
    if (versionAt(candidate, ['--version'], /cloudflared version ([^\s]+)/i)) return candidate;
  }
  return null;
}

function loadTunnel() {
  return JSON.parse(readFileSync(tunnelFile, 'utf8'));
}

if (!nodeSupported()) throw new Error(`Node.js ${process.versions.node} 不符合当前前端依赖要求；请使用 20.19+ 或 22.12+。`);
if (!run('cmd.exe', ['/d', '/s', '/c', 'npm.cmd --version'], { quiet: true, timeout: 15000 }).ok) {
  throw new Error('没有找到 npm.cmd；请安装包含 npm 的 Node.js。');
}

let go = findGo();
let python = findPython312();
let tunnel = loadTunnel();
console.log(`Node.js: ${process.versions.node}`);
console.log(`Go: ${go ? go.version : '缺失（需要 1.23+）'}`);
console.log(`Python: ${python ? python.version : '缺失（建议 3.12）'}`);
console.log(`前端依赖: ${existsSync(join(frontend, 'node_modules')) ? '已安装' : '未安装'}`);
console.log(`隧道: ${tunnel.enabled ? '配置为启用' : '关闭'}`);
if (checkOnly) {
  let ready = !!go && !!python && existsSync(join(frontend, 'node_modules'));
  const visionReady = existsSync(venvPython) && run(venvPython, [
    '-c', 'import cv2, numpy, flask, ultralytics, aiortc, av',
  ], { quiet: true, timeout: 60000 }).ok;
  console.log(`视觉 Python 依赖: ${visionReady ? '可导入' : '缺失或无法导入'}`);
  ready = ready && visionReady;
  if (tunnel.enabled) {
    const binary = findCloudflared();
    const credentials = !!tunnel.credentialsFile && existsSync(tunnel.credentialsFile);
    console.log(`cloudflared: ${binary || '缺失'}`);
    console.log(`隧道凭据: ${credentials ? '存在' : '缺失或指向其他电脑'}`);
    ready = ready && !!binary && credentials;
  }
  process.exit(ready ? 0 : 1);
}

if (!go) {
  wingetInstall('GoLang.Go');
  go = findGo();
  if (!go) throw new Error('Go 安装后仍未找到；请重新打开终端并检查 Go 安装路径。');
}
if (!python) {
  wingetInstall('Python.Python.3.12');
  python = findPython312();
  if (!python) throw new Error('Python 3.12 安装后仍未找到；请重新打开终端并重试。');
}

if (!existsSync(venvPython)) mustRun(python.executable, ['-m', 'venv', join(vision, '.venv')]);
mustRun(venvPython, ['-m', 'pip', 'install', '-r', join(vision, 'requirements.txt')]);
mustRun('cmd.exe', ['/d', '/s', '/c', 'npm.cmd ci'], { cwd: frontend });
mustRun('cmd.exe', ['/d', '/s', '/c', 'npm.cmd run build'], { cwd: frontend });
mkdirSync(runtime, { recursive: true });
const goEnv = { ...process.env, GOPROXY: process.env.GOPROXY || 'https://goproxy.cn' };
mustRun(go.executable, ['build', '-o', join(runtime, 'fish-controller.exe'), './cmd/fish-controller'], { cwd: join(root, 'controller'), env: goEnv });

if (localOnly && tunnel.enabled) {
  tunnel.enabled = false;
  writeFileSync(tunnelFile, `${JSON.stringify(tunnel, null, 2)}\n`, 'utf8');
  console.log('已将 config/tunnel.json 的 enabled 改为 false；隧道其他设置保留。');
}
if (cpuOnly) {
  const program = JSON.parse(readFileSync(programFile, 'utf8'));
  program.environment.FISH_YOLO_DEVICE = 'cpu';
  writeFileSync(programFile, `${JSON.stringify(program, null, 2)}\n`, 'utf8');
  console.log('已将 config/program.json 的 FISH_YOLO_DEVICE 改为 cpu；推理速度需在新电脑实测。');
}
tunnel = loadTunnel();
let tunnelReady = true;
if (tunnel.enabled) {
  let binary = findCloudflared();
  if (!binary) {
    wingetInstall('Cloudflare.cloudflared');
    binary = findCloudflared();
  }
  if (!binary) throw new Error('cloudflared 已尝试安装，但没有找到可执行文件；请将 cloudflared.exe 放入 controller/.runtime/。');
  const target = join(runtime, 'cloudflared.exe');
  if (resolve(binary).toLowerCase() !== resolve(target).toLowerCase()) copyFileSync(binary, target);
  if (!tunnel.credentialsFile || !existsSync(tunnel.credentialsFile)) {
    tunnelReady = false;
    console.warn('电脑端依赖已安装，但本机缺少隧道凭据。请更新 config/tunnel.json 的 credentialsFile，或重新运行本脚本并加 --local。');
  }
}

if (withFirmware) {
  const pioHome = join(process.env.USERPROFILE || '', '.platformio', 'penv');
  const pioPython = join(pioHome, 'Scripts', 'python.exe');
  if (!existsSync(pioPython)) mustRun(python.executable, ['-m', 'venv', pioHome]);
  mustRun(pioPython, ['-m', 'pip', 'install', 'platformio>=6.2,<6.3']);
  mustRun(join(pioHome, 'Scripts', 'pio.exe'), ['run', '-e', 'seeed_xiao_esp32c3'], { cwd: join(root, 'firmware') });
}

console.log('\n电脑端依赖和构建已完成。');
console.log('新电脑仍需核对相机编号、FISH_YOLO_DEVICE、ESP32 Wi-Fi，以及隧道凭据。');
if (!tunnelReady) throw new Error('隧道凭据未就绪；当前配置下 scripts\\start.bat 无法启动。');
console.log('运行 scripts\\start.bat 启动项目。');
