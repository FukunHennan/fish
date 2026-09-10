import test from 'node:test';
import assert from 'node:assert/strict';
import {createMultiKeyboard, DEFAULT_KEYS} from './multiKeyboard.js';
test('independent devices release and stop independently', async () => {
 const commands=[];
 const a={deviceId:'a'}, b={deviceId:'b'};
 const driver=createMultiKeyboard({targets:()=>[
  {device:a,keys:DEFAULT_KEYS}, {device:b,keys:{forward:'KeyI',left:'KeyJ',right:'KeyL',stop:'KeyK'}}],
  send:async(d,m)=>commands.push([d.deviceId,m])});
 driver.key('KeyW',true); driver.key('KeyI',true); driver.key('KeyW',false);
 await driver.stop();
 assert.deepEqual(commands.filter(c=>c[0]==='a'),[['a','forward'],['a','stop']]);
 assert.deepEqual(commands.filter(c=>c[0]==='b'),[['b','forward'],['b','stop']]);
});
test('unowned devices cannot be controlled and losing target stops it',async()=>{
 let available=true; const calls=[];
 const driver=createMultiKeyboard({targets:()=>available?[{device:{deviceId:'a'},keys:DEFAULT_KEYS}]:[],send:async(d,m)=>calls.push(m)});
 driver.key('KeyW',true); available=false; driver.update(); await driver.stop();
 assert.deepEqual(calls,['forward','stop']);
 assert.equal(driver.key('KeyA',true),false);
});
test('explicit single fish stop cannot resume from a held key',async()=>{
 const a={deviceId:'a'},b={deviceId:'b'},calls=[];
 const driver=createMultiKeyboard({targets:()=>[{device:a,keys:DEFAULT_KEYS},{device:b,keys:{...DEFAULT_KEYS,forward:'KeyI'}}],send:async(d,m)=>calls.push([d.deviceId,m])});
 driver.key('KeyW',true);driver.key('KeyI',true);await driver.stop(a);driver.update();
 assert.deepEqual(driver.active().map(d=>d.deviceId),['b']);
 await driver.stop();
 assert.deepEqual(calls.filter(c=>c[0]==='a'),[['a','forward'],['a','stop']]);
});
