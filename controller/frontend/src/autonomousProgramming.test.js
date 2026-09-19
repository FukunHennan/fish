import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const playerInterface = readFileSync(
  new URL("../public/competition/player_interface.html", import.meta.url),
  "utf8",
);
const competitionAdapter = readFileSync(
  new URL("../public/competition/competition-adapter.js", import.meta.url),
  "utf8",
);

const paletteStart = playerInterface.indexOf("const blockLibrary = [");
const paletteEnd = playerInterface.indexOf("const challengeOptions", paletteStart);
const palette = paletteStart >= 0 && paletteEnd > paletteStart
  ? playerInterface.slice(paletteStart, paletteEnd)
  : "";

test("基础积木只保留虚拟按键和等待语义", () => {
  assert.match(palette, /label:'前进多少秒'/);
  assert.match(palette, /label:'左转多少秒'/);
  assert.match(palette, /label:'右转多少秒'/);
  assert.match(palette, /label:'等待多少秒'/);
  assert.doesNotMatch(palette, /op:'speed'|op:'follow'|op:'stop'|angle:/);
});

test("基础积木按钮绑定点击和拖拽添加事件", () => {
  assert.match(playerInterface, /querySelectorAll\('\.simplePaletteBlock, \.paletteBlock'\)\.forEach\(btn=>\{/);
  assert.match(playerInterface, /btn\.addEventListener\('click',\(\)=>addAutonomousBlock/);
  assert.match(playerInterface, /btn\.addEventListener\('dragstart'/);
});

test("积木工作区提供清晰的顺序编辑能力", () => {
  assert.match(playerInterface, /class="sequenceStep"/);
  assert.match(playerInterface, /data-duplicate-block/);
  assert.match(playerInterface, /function duplicateBlockAtPath/);
  assert.match(playerInterface, /function moveTopLevelBlock/);
  assert.match(playerInterface, /data-sortable-step="true"/);
  assert.match(playerInterface, /addEventListener\('pointerdown'/);
  assert.match(playerInterface, /addEventListener\('pointerup'/);
  assert.match(playerInterface, /拖动步骤可排序/);
});

test("空程序提供真实动作起步组合", () => {
  assert.match(playerInterface, /data-program-preset="straight"/);
  assert.match(playerInterface, /data-program-preset="turnLeft"/);
  assert.match(playerInterface, /data-program-preset="turnRight"/);
  assert.match(playerInterface, /function applyProgramPreset/);
  assert.match(playerInterface, /straight:\[\['motion','forward',2\]\]/);
});

test("编辑积木只局部刷新程序区而不重建视频页面", () => {
  const addStart = playerInterface.indexOf("function addAutonomousBlock");
  const addEnd = playerInterface.indexOf("function generatedProgramText", addStart);
  const addBlock = playerInterface.slice(addStart, addEnd);
  const refreshStart = playerInterface.indexOf("function refreshProgramEditor");
  const refreshEnd = playerInterface.indexOf("function bindProgramWorkspace", refreshStart);
  const refreshBlock = playerInterface.slice(refreshStart, refreshEnd);

  assert.match(addBlock, /stopAutoSimulation\(\);\s*refreshProgramEditor\(\)/);
  assert.doesNotMatch(addBlock, /\brender\(\)/);
  assert.match(refreshBlock, /const replacement=workspace\.cloneNode\(false\)/);
  assert.match(refreshBlock, /replacement\.innerHTML=renderWorkspaceBlocks\(\)/);
  assert.match(refreshBlock, /workspace\.replaceWith\(replacement\)/);
  assert.match(refreshBlock, /bindProgramWorkspace\(replacement\)/);
  assert.match(refreshBlock, /\[data-program-count\]/);
  assert.doesNotMatch(refreshBlock, /root\.innerHTML|missionsPage\(\)|matchPool\(\)/);
});

test("拖动排序按动画帧节流且不在移动时遍历全部积木", () => {
  const bindStart = playerInterface.indexOf("function bindProgramWorkspace");
  const bindEnd = playerInterface.indexOf("function bindInteractions", bindStart);
  const bindBlock = playerInterface.slice(bindStart, bindEnd);
  const dragStart = bindBlock.indexOf("workspace.addEventListener('dragover'");
  const dragEnd = bindBlock.indexOf("workspace.addEventListener('dragleave'", dragStart);
  const dragBlock = bindBlock.slice(dragStart, dragEnd);

  assert.match(bindBlock, /requestAnimationFrame\(paintDropPreview\)/);
  assert.match(bindBlock, /cancelAnimationFrame\(dragFrame\)/);
  assert.match(bindBlock, /nextTarget===activeTarget&&nextSide===activeSide/);
  assert.doesNotMatch(dragBlock, /querySelectorAll|getBoundingClientRect|classList\.remove/);
  assert.match(bindBlock, /setPointerCapture\(e\.pointerId\)/);
  assert.match(bindBlock, /document\.elementFromPoint\(e\.clientX,e\.clientY\)/);
  assert.match(bindBlock, /moveTopLevelBlock[\s\S]*?refreshProgramEditor\(\)/);
});

test("转向和前进都使用持续秒数", () => {
  assert.match(palette, /op:'forward'[\s\S]*?params:\{seconds:1\}/);
  assert.match(palette, /op:'left'[\s\S]*?params:\{seconds:0\.5\}/);
  assert.match(palette, /op:'right'[\s\S]*?params:\{seconds:0\.5\}/);
  assert.match(playerInterface, /case 'left': await animateTurn\(p\.seconds,'left',token\)/);
  assert.match(playerInterface, /case 'right': await animateTurn\(p\.seconds,'right',token\)/);
});

test("持续时间使用与积木一致的深色步进器", () => {
  assert.match(playerInterface, /case 'forward': return '<b>前进<\/b><span class="parameterLabel">持续<\/span>'/);
  assert.match(playerInterface, /case 'wait': return '<b>等待<\/b><span class="parameterLabel">持续<\/span>'/);
  assert.match(playerInterface, /data-param-step="-1"/);
  assert.match(playerInterface, /data-param-step="1"/);
  assert.match(playerInterface, /-webkit-text-fill-color:#f1fcff!important/);
  assert.match(playerInterface, /input\.dispatchEvent\(new Event\('change',\{bubbles:true\}\)\)/);
  assert.doesNotMatch(playerInterface, /background:#f5fbff!important/);
});

test("设备程序通过真实键盘事件启动并保证释放", () => {
  assert.match(playerInterface, /phase:'start',key/);
  assert.match(playerInterface, /phase:'end',key/);
  assert.match(playerInterface, /document\.dispatchEvent\(new CustomEvent\('fish-control-key'/);
  assert.match(playerInterface, /finally\{\s*if\(key\)releaseProgramControl\(key\)/);
  assert.match(playerInterface, /case 'wait': releaseAllProgramControls\(\);await simDelay/);
  assert.match(playerInterface, /function stopAutoSimulation[\s\S]*?releaseAllProgramControls\(\)/);
});

test("进阶控制与手动键盘入口相互独立", () => {
  assert.match(playerInterface, /label: "进阶控制"/);
  assert.match(playerInterface, /<span>进阶模式<\/span><h2>编程控制<\/h2>/);
  assert.match(playerInterface, /它与手动操控相互独立/);
  assert.match(playerInterface, /仅点击启动后发送控制/);
  assert.doesNotMatch(playerInterface, /MISSION_MANUAL_ACTIONS|dispatchMissionManualControl/);
});

test("离开进阶控制时释放指令并保留程序为暂停状态", () => {
  assert.match(playerInterface, /function setAdvancedProgramPaused[\s\S]*?releaseAllProgramControls\(\)/);
  assert.match(playerInterface, /renderedPage==='missions'&&nextPage!=='missions'/);
  assert.match(playerInterface, /setAdvancedProgramPaused\(true,'已离开进阶控制，程序自动暂停'\)/);
  assert.match(playerInterface, /if\(autonomousState\.paused\)setAdvancedProgramPaused\(false,'继续执行编程控制'\)/);
});

test("进阶控制只显示并驱动真实绑定设备", () => {
  assert.match(playerInterface, /class="advancedDeviceTarget/);
  assert.match(playerInterface, /Go 服务器 → ESP32/);
  assert.match(playerInterface, /真实设备未连接，没有发送运动指令/);
  assert.match(playerInterface, /runButton\.disabled=!targetOnline/);
  assert.doesNotMatch(playerInterface, /function simFish\(|\n\s*simFish\(\) \+/);
});

test("设备在线状态不依赖比赛操控卡片是否显示", () => {
  assert.match(competitionAdapter, /function publishPlayerDeviceAvailability\(localPlayer\)/);
  assert.match(competitionAdapter, /state\.bound\[localPlayer\] === deviceId/);
  assert.match(competitionAdapter, /PLAYERS\.forEach\(publishPlayerDeviceAvailability\)/);
});

test("进阶控制复用选手端真实视频流", () => {
  assert.match(playerInterface, /class="advancedProgramVideo"/);
  assert.match(playerInterface, /裁判视频源 · 有效区 · YOLO 识别框/);
  assert.match(playerInterface, /advancedProgramVideo[\s\S]*?\+matchPool\(\)\+/);
  assert.match(competitionAdapter, /return document\.querySelector\("\.poolStage\.matchPool"\)/);
});
