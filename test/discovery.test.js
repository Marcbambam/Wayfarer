import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cidrHosts, localSubnets, probeHost, scanNetwork, markConfigured } from '../src/discovery.js';
import { Hub } from '../src/hub.js';
import { Setup } from '../src/setup.js';
import { createApp } from '../server.js';

async function fake(routes) {
  const srv = createServer((req, res) => {
    const out = routes[req.url];
    if (out === 401) { res.writeHead(401); return res.end(); }
    res.writeHead(out === undefined ? 404 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out ?? {}));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) };
}
const NO_HA = 1; // geschlossener Port
const NO_LG = { ws: 1, wss: 1 };
const quiet = { warn() {}, info() {} };

test('Subnetze berechnen', () => {
  const hosts = cidrHosts('192.168.1.77/24');
  assert.equal(hosts.length, 254);
  assert.equal(hosts[0], '192.168.1.1');
  assert.equal(hosts.at(-1), '192.168.1.254');
  assert.throws(() => cidrHosts('10.0.0.0/8'), /22/);
  assert.throws(() => cidrHosts('quatsch'), /Ungültig/);
  const nets = localSubnets({
    lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
    eth0: [{ family: 'IPv4', address: '192.168.178.23', netmask: '255.255.255.0', internal: false }],
    wlan: [{ family: 'IPv4', address: '10.1.2.3', netmask: '255.0.0.0', internal: false }],
  });
  assert.deepEqual(nets, ['192.168.178.0/24', '10.1.2.0/24']);
});

test('Shelly Gen1 (Rollladen) und Gen2 (2 Kanäle) erkennen', async () => {
  const g1 = await fake({
    '/shelly': { type: 'SHSW-25', mac: 'AA', auth: false },
    '/status': { relays: [{}, {}], rollers: [{}] },
    '/settings': { mode: 'roller', name: 'Rollo Bad' },
  });
  const g2 = await fake({
    '/shelly': { id: 'shellyplus2pm-1', gen: 2, app: 'Plus2PM', name: null, auth_en: false },
    '/rpc/Shelly.GetStatus': { 'switch:0': {}, 'switch:1': {}, sys: {} },
  });
  try {
    const [a] = await probeHost('127.0.0.1', { port: g1.port, haPort: NO_HA, lgPorts: NO_LG });
    assert.equal(a.type, 'shelly');
    assert.equal(a.name, 'Rollo Bad');
    assert.deepEqual(a.devices, [{ name: 'Rollo Bad', host: '127.0.0.1', gen: 1, kind: 'cover', channel: 0 }]);
    const [b] = await probeHost('127.0.0.1', { port: g2.port, haPort: NO_HA, lgPorts: NO_LG });
    assert.equal(b.gen, 2);
    assert.deepEqual(b.devices.map((d) => [d.name, d.kind, d.channel]), [['Shelly Plus2PM 1', 'switch', 0], ['Shelly Plus2PM 2', 'switch', 1]]);
  } finally {
    await g1.close(); await g2.close();
  }
});

test('Tasmota, Hue und Home Assistant erkennen', async () => {
  const tas = await fake({
    '/cm?cmnd=Status': { Status: { Module: 18, DeviceName: 'LED Strip', FriendlyName: ['LED Strip'] } },
    '/cm?cmnd=State': { POWER: 'ON', Dimmer: 50, Color: 'FF00AA' },
  });
  const hue = await fake({ '/api/config': { name: 'Philips hue', bridgeid: '001788FFFE123456', modelid: 'BSB002' } });
  const ha = await fake({ '/manifest.json': { name: 'Home Assistant', short_name: 'Assistant' } });
  try {
    const [t] = await probeHost('127.0.0.1', { port: tas.port, haPort: NO_HA, lgPorts: NO_LG });
    assert.deepEqual(t.devices, [{ name: 'LED Strip', host: '127.0.0.1', kind: 'light', color: true }]);
    const [h] = await probeHost('127.0.0.1', { port: hue.port, haPort: NO_HA, lgPorts: NO_LG });
    assert.equal(h.type, 'hue');
    assert.equal(h.needsPairing, true);
    const found = await probeHost('127.0.0.1', { port: NO_HA, haPort: ha.port, lgPorts: NO_LG });
    assert.equal(found.length, 1);
    assert.equal(found[0].type, 'homeassistant');
    assert.equal(found[0].url, `http://127.0.0.1:${ha.port}`);
  } finally {
    await tas.close(); await hue.close(); await ha.close();
  }
});

test('Passwortgeschützte Geräte werden gemeldet, fremde Server ignoriert', async () => {
  const locked = await fake({ '/shelly': { type: 'SHPLG-S', auth: true }, '/status': 401, '/settings': 401 });
  const other = await fake({ '/': { hello: 'world' }, '/api/config': { name: 'Router' } });
  try {
    const [s] = await probeHost('127.0.0.1', { port: locked.port, haPort: NO_HA, lgPorts: NO_LG });
    assert.equal(s.needsAuth, true);
    assert.deepEqual(await probeHost('127.0.0.1', { port: other.port, haPort: NO_HA, lgPorts: NO_LG }), []);
  } finally {
    await locked.close(); await other.close();
  }
});

test('scanNetwork und Abgleich mit vorhandener Konfiguration', async () => {
  const sh = await fake({ '/shelly': { type: 'SHPLG-S', auth: false }, '/status': { relays: [{}] }, '/settings': { name: 'Kaffee' } });
  try {
    const { scanned, results } = await scanNetwork({ subnets: ['127.0.0.0/30'], port: sh.port, haPort: NO_HA, lgPorts: NO_LG, timeout: 500 });
    assert.equal(scanned, 2);
    assert.equal(results.length, 1);
    assert.equal(results[0].devices[0].kind, 'plug');
    const marked = markConfigured({ integrations: [{ type: 'shelly', devices: [{ host: '127.0.0.1', channel: 0 }] }] }, results);
    assert.equal(marked[0].configured, true);
    assert.equal(markConfigured({ integrations: [] }, results)[0].configured, false);
  } finally {
    await sh.close();
  }
});

test('Gefundene Geräte übernehmen: config.json wird geschrieben, Demo verschwindet', async () => {
  const sh = await fake({ '/relay/0': { ison: true } });
  const dir = await mkdtemp(join(tmpdir(), 'sh-'));
  const configPath = join(dir, 'config.json');
  const hub = new Hub({ integrations: [{ type: 'demo' }] }, { log: quiet });
  await hub.refresh();
  const setup = new Setup(hub, { configPath, autoDemo: true });
  try {
    const host = `127.0.0.1:${sh.port}`;
    const added = await setup.addDevices('shelly', [{ name: 'Kaffeemaschine', room: 'Küche', host, gen: 1, kind: 'plug', channel: 0, evil: 'x' }]);
    assert.deepEqual(added, ['shelly:kaffeemaschine']);
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(saved.integrations, [{ type: 'shelly', id: 'shelly', devices: [{ name: 'Kaffeemaschine', room: 'Küche', host, gen: 1, kind: 'plug', channel: 0, id: 'kaffeemaschine' }] }]);
    const devs = hub.listDevices();
    assert.equal(devs.length, 1);
    assert.equal(devs[0].state.on, true);
    assert.equal(devs[0].room, 'Küche');

    // Doppelt hinzufügen wird ignoriert, gleicher Name bekommt eindeutige ID
    assert.deepEqual(await setup.addDevices('shelly', [{ name: 'Kaffeemaschine', host, gen: 1, kind: 'plug', channel: 0 }]), []);
    assert.deepEqual(await setup.addDevices('shelly', [{ name: 'Kaffeemaschine', host, gen: 1, kind: 'plug', channel: 1 }]), ['shelly:kaffeemaschine-2']);

    await assert.rejects(setup.addDevices('shelly', [{ name: 'x', host: 'a b', kind: 'plug' }]), /Host/);
    await assert.rejects(setup.addDevices('shelly', [{ name: 'x', host: '1.2.3.4', kind: 'toaster' }]), /Geräteart/);
  } finally {
    await sh.close();
    await rm(dir, { recursive: true });
  }
});

test('Home Assistant per Token verbinden', async () => {
  const srv = createServer((req, res) => {
    const ok = req.headers.authorization === `Bearer ${'t'.repeat(30)}`;
    if (req.url === '/api/') { res.writeHead(ok ? 200 : 401); return res.end('{"message":"API running."}'); }
    if (req.url === '/api/states') { res.writeHead(200); return res.end(JSON.stringify([{ entity_id: 'light.flur', state: 'off', attributes: { friendly_name: 'Flur' } }])); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const hub = new Hub({ integrations: [] }, { log: quiet });
  const setup = new Setup(hub, {});
  try {
    await assert.rejects(setup.addHomeAssistant(url, 'f'.repeat(30)), /abgelehnt/);
    await setup.addHomeAssistant(url, 't'.repeat(30));
    assert.equal(hub.getDevice('ha:light.flur').name, 'Flur');
  } finally {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
});

test('API: /api/discover und /api/setup/devices', async () => {
  const sh = await fake({ '/shelly': { type: 'SHSW-1', auth: false }, '/status': { relays: [{}] }, '/settings': { name: 'Licht Keller' } });
  const hub = new Hub({ integrations: [] }, { log: quiet });
  const app = createApp(hub, { scanOptions: { subnets: ['127.0.0.0/30'], port: sh.port, haPort: NO_HA, lgPorts: NO_LG, timeout: 500 } });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const r = await (await post('/api/discover', {})).json();
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].configured, false);
    assert.equal((await post('/api/discover', { subnet: '10.0.0.0/8' })).status, 400);
    const res = await post('/api/setup/devices', { type: 'shelly', devices: r.results[0].devices.map((d) => ({ ...d, host: `${d.host}:${sh.port}` })) });
    assert.equal(res.status, 201);
    assert.deepEqual((await res.json()).added, ['shelly:licht-keller']);
  } finally {
    app.closeAllConnections();
    await new Promise((r) => app.close(r));
    await sh.close();
  }
});

test('Beispielgeräte ausblenden und wieder einblenden', async () => {
  const hub = new Hub({ integrations: [{ type: 'demo' }] }, { log: quiet });
  await hub.refresh();
  const setup = new Setup(hub, {});
  await setup.setDemo(false);
  assert.equal(hub.listDevices().length, 0);
  assert.deepEqual(hub.config.integrations, []);
  await setup.setDemo(true);
  assert.ok(hub.listDevices().length > 5);
});
