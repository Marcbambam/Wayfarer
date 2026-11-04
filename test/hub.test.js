import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/hub.js';
import { hexToXy, xyToHex, validateCommand } from '../src/device.js';

const quiet = { warn() {}, info() {} };

async function demoHub(extra = {}) {
  const hub = new Hub({ integrations: [{ type: 'demo' }], ...extra }, { log: quiet });
  await hub.refresh();
  return hub;
}

test('Demo-Geräte werden geladen und nach Raum sortiert', async () => {
  const hub = await demoHub();
  const list = hub.listDevices();
  assert.ok(list.length >= 10);
  const rooms = list.map((d) => d.room);
  assert.deepEqual(rooms, [...rooms].sort((a, b) => a.localeCompare(b, 'de')));
});

test('Befehle ändern den Zustand', async () => {
  const hub = await demoHub();
  let d = await hub.command('demo:wz-stehlampe', { action: 'turn_on' });
  assert.equal(d.state.on, true);
  d = await hub.command('demo:wz-stehlampe', { action: 'set_brightness', value: 55 });
  assert.equal(d.state.brightness, 55);
  d = await hub.command('demo:sz-rollo', { action: 'close' });
  assert.equal(d.state.position, 0);
});

test('Ungültige Befehle werden abgelehnt', async () => {
  const hub = await demoHub();
  await assert.rejects(hub.command('demo:kueche-kaffee', { action: 'set_brightness', value: 50 }), /unterstützt/);
  await assert.rejects(hub.command('demo:wz-stehlampe', { action: 'set_brightness', value: 500 }), /0 und 100/);
  await assert.rejects(hub.command('demo:gibtsnicht', { action: 'turn_on' }), /nicht gefunden/);
  assert.throws(() => validateCommand({ name: 'x', capabilities: ['color'] }, { action: 'set_color', value: 'rot' }), /#rrggbb/);
});

test('Gruppenbefehl schaltet nur passende Geräte', async () => {
  const hub = await demoHub();
  await hub.command('demo:kueche-kaffee', { action: 'turn_on' });
  const res = await hub.commandMany({ type: 'light' }, { action: 'turn_off' });
  assert.ok(res.length >= 3 && res.every((r) => r.ok));
  assert.ok(hub.listDevices().filter((d) => d.type === 'light').every((d) => !d.state.on));
  assert.equal(hub.getDevice('demo:kueche-kaffee').state.on, true);
});

test('Szenen aus Konfiguration und gespeicherte Szenen', async () => {
  const hub = await demoHub({
    scenes: [{ id: 'nacht', name: 'Nacht', actions: [{ type: 'light', action: 'turn_off' }, { device: 'demo:flur-tuer', action: 'lock' }] }],
  });
  await hub.command('demo:flur-tuer', { action: 'unlock' });
  await hub.runScene('nacht');
  assert.equal(hub.getDevice('demo:flur-tuer').state.locked, true);

  await hub.command('demo:sz-licht', { action: 'set_brightness', value: 33 });
  const scene = await hub.captureScene('Lesen', ['demo:sz-licht']);
  assert.equal(scene.id, 'lesen');
  await hub.command('demo:sz-licht', { action: 'turn_off' });
  await hub.runScene('lesen');
  assert.equal(hub.getDevice('demo:sz-licht').state.brightness, 33);
  assert.equal(hub.getDevice('demo:sz-licht').state.on, true);

  await assert.rejects(hub.deleteScene('nacht'), /config\.json/);
  await hub.deleteScene('lesen');
  assert.equal(hub.listScenes().length, 1);
});

test('Zeitpläne laufen zur richtigen Minute und nur einmal', async () => {
  const hub = await demoHub({
    automations: [
      { at: '07:00', days: [1], actions: [{ device: 'demo:kueche-kaffee', action: 'turn_on' }] },
      { at: '07:00', days: [2], actions: [{ device: 'demo:kueche-licht', action: 'turn_on' }] },
    ],
  });
  const monday = new Date(2026, 10, 2, 7, 0, 10); // Mo, 2.11.2026
  assert.equal(hub.runAutomations(monday).length, 1);
  assert.equal(hub.runAutomations(monday).length, 0); // gleiche Minute -> nicht nochmal
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(hub.getDevice('demo:kueche-kaffee').state.on, true);
  assert.equal(hub.getDevice('demo:kueche-licht').state.on, false);
});

test('Überschreibungen aus der Konfiguration', async () => {
  const hub = await demoHub({ devices: { 'demo:wz-tv': { name: 'Sonos', room: 'Küche' }, 'demo:flur-temp': { hidden: true } } });
  const d = hub.getDevice('demo:wz-tv');
  assert.equal(d.name, 'Sonos');
  assert.equal(d.room, 'Küche');
  assert.ok(!hub.listDevices().some((x) => x.id === 'demo:flur-temp'));
});

test('Farbumrechnung xy <-> hex ist stabil', () => {
  for (const hex of ['#ff0000', '#00ff00', '#0000ff']) {
    const back = xyToHex(hexToXy(hex));
    assert.equal(back, hex);
  }
});

test('Sicherheit: Entriegeln/Öffnen/Unscharf nie als Gruppenbefehl', async () => {
  const hub = await demoHub();
  await assert.rejects(hub.commandMany({ room: 'Flur' }, { action: 'unlock' }), /einzelnes Gerät/);
  await assert.rejects(hub.commandMany({}, { action: 'unlatch' }), /einzelnes Gerät/);
  await assert.rejects(hub.commandMany({ type: 'alarm' }, { action: 'disarm', value: '1234' }), /einzelnes Gerät/);
  // Einzeln geht es
  await hub.command('demo:flur-tuer', { action: 'unlatch' });
  assert.equal(hub.getDevice('demo:flur-tuer').state.locked, false);
  // Szenen aus dem aktuellen Zustand entriegeln nie
  const scene = await hub.captureScene('Test', ['demo:flur-tuer']);
  assert.deepEqual(scene.actions, []);
});

test('Saugroboter und Alarmanlage', async () => {
  const hub = await demoHub();
  let d = await hub.command('demo:wz-sauger', { action: 'start' });
  assert.equal(d.state.status, 'cleaning');
  d = await hub.command('demo:wz-sauger', { action: 'pause' });
  assert.equal(d.state.status, 'paused');
  d = await hub.command('demo:flur-alarm', { action: 'arm_away' });
  assert.equal(d.state.alarm, 'armed_away');
  await assert.rejects(hub.command('demo:flur-alarm', { action: 'arm_night' }), /Modus/);
  await assert.rejects(hub.command('demo:flur-alarm', { action: 'disarm', value: '0000' }), /Falscher Code/);
  d = await hub.command('demo:flur-alarm', { action: 'disarm', value: '1234' });
  assert.equal(d.state.alarm, 'disarmed');
  // "pause" auf eine Gruppe trifft Sauger und Medien, aber nichts anderes
  const res = await hub.commandMany({ room: 'Wohnzimmer' }, { action: 'pause' });
  assert.deepEqual(res.map((r) => r.id).sort(), ['demo:wz-fernseher', 'demo:wz-sauger', 'demo:wz-tv']);
});

test('Geräte im Dashboard umbenennen, verschieben, ausblenden', async () => {
  const hub = await demoHub();
  let d = await hub.setDeviceSettings('demo:wz-stehlampe', { name: 'Leselampe', room: 'Büro' });
  assert.equal(d.name, 'Leselampe');
  assert.equal(d.room, 'Büro');
  assert.equal(d.defaultName, 'Stehlampe');
  await hub.refresh();
  assert.equal(hub.getDevice('demo:wz-stehlampe').room, 'Büro', 'bleibt nach Aktualisierung');
  await hub.setDeviceSettings('demo:wz-stehlampe', { hidden: true });
  assert.ok(!hub.listDevices().some((x) => x.id === 'demo:wz-stehlampe'));
  assert.ok(hub.listDevices({ includeHidden: true }).some((x) => x.id === 'demo:wz-stehlampe'));
  d = await hub.setDeviceSettings('demo:wz-stehlampe', { name: '', room: '', hidden: false });
  assert.equal(d.name, 'Stehlampe');
  assert.equal(d.room, 'Wohnzimmer');
  assert.equal(d.hidden, undefined);
  assert.deepEqual(hub.deviceSettings, {});
  await assert.rejects(hub.setDeviceSettings('demo:wz-stehlampe', { name: 42 }), /Ungültiger Name/);
});
