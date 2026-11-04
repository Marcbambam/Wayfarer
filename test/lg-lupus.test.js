import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { createHash } from 'node:crypto';
import { encodeFrame, decodeFrames } from '../src/ws.js';
import { createAdapter } from '../src/adapters/index.js';
import { sendWakeOnLan } from '../src/adapters/lgtv.js';
import { parseLupusJson } from '../src/adapters/lupus.js';
import { probeHost } from '../src/discovery.js';
import { Hub } from '../src/hub.js';
import { Setup } from '../src/setup.js';

const quiet = { warn() {}, info() {} };
const CLOSED = 1;

// ---- Fake-LG-Fernseher (webOS SSAP über WebSocket) ----------------------

async function fakeTv({ approve = true } = {}) {
  const tv = { power: 'Active', volume: 11, received: [], key: 'KEY123' };
  const srv = createServer();
  const sockets = new Set();
  srv.on('upgrade', (req, sock) => {
    sockets.add(sock);
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    const send = (obj) => sock.write(encodeFrame(JSON.stringify(obj), { mask: false }));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const f of frames) {
        if (f.opcode === 8) { sock.end(); return; }
        const msg = JSON.parse(f.payload.toString());
        tv.received.push(msg);
        const reply = (payload) => send({ type: 'response', id: msg.id, payload: { returnValue: true, ...payload } });
        if (msg.type === 'hello') send({ type: 'hello', id: msg.id, payload: { deviceOS: 'webOS', deviceType: 'tv', deviceModel: 'OLED55C3', deviceOSVersion: '7.3' } });
        else if (msg.type === 'register') {
          if (msg.payload['client-key'] === tv.key) send({ type: 'registered', id: msg.id, payload: { 'client-key': tv.key } });
          else {
            reply({ pairingType: 'PROMPT' });
            setTimeout(() => (approve
              ? send({ type: 'registered', id: msg.id, payload: { 'client-key': tv.key } })
              : send({ type: 'error', id: msg.id, error: '403 User denied access' })), 30);
          }
        } else {
          const uri = msg.uri.replace('ssap://', '');
          if (uri === 'system/getSystemInfo') reply({ modelName: 'OLED55C3' });
          else if (uri === 'com.webos.service.tvpower/power/getPowerState') reply({ state: tv.power });
          else if (uri === 'audio/getVolume') reply({ volumeStatus: { volume: tv.volume, muteStatus: false } });
          else if (uri === 'audio/setVolume') { tv.volume = msg.payload.volume; reply({}); }
          else if (uri === 'com.webos.applicationManager/getForegroundAppInfo') reply({ appId: 'netflix' });
          else if (uri === 'com.webos.applicationManager/listLaunchPoints') reply({ launchPoints: [{ id: 'netflix', title: 'Netflix' }] });
          else if (uri === 'com.webos.service.connectionmanager/getinfo') reply({ wiredInfo: { macAddress: 'aa:bb:cc:dd:ee:ff' } });
          else if (uri === 'system/turnOff') { tv.power = 'Suspend'; reply({}); }
          else if (uri === 'media.controls/pause') reply({});
          else send({ type: 'error', id: msg.id, error: '404 no such service' });
        }
      }
    });
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  tv.ports = { ws: srv.address().port, wss: CLOSED };
  tv.close = () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(r); });
  return tv;
}

test('WebSocket-Frames: kurz, mittel, lang', () => {
  for (const len of [5, 300, 70000]) {
    const text = 'x'.repeat(len);
    const { frames, rest } = decodeFrames(encodeFrame(text));
    assert.equal(frames[0].payload.toString(), text);
    assert.equal(rest.length, 0);
  }
  const half = encodeFrame('hallo').subarray(0, 4);
  assert.equal(decodeFrames(half).frames.length, 0);
});

test('LG: Fernseher finden, koppeln, Zustand lesen, steuern', async () => {
  const tv = await fakeTv();
  const connOpts = { ports: tv.ports, timeout: 1000 };
  try {
    const found = await probeHost('127.0.0.1', { port: CLOSED, haPort: CLOSED, lgPorts: tv.ports, timeout: 800 });
    assert.equal(found.length, 1);
    assert.equal(found[0].type, 'lgtv');
    assert.equal(found[0].name, 'LG OLED55C3');

    const hub = new Hub({ integrations: [] }, { log: quiet });
    const setup = new Setup(hub, {});
    const r = await setup.addLgTv({ host: '127.0.0.1', name: 'Fernseher', room: 'Wohnzimmer' }, { pairTimeout: 2000, connOpts });
    assert.deepEqual(r, { id: 'lgtv:fernseher', mac: 'aa:bb:cc:dd:ee:ff' });
    const saved = hub.config.integrations[0].devices[0];
    assert.equal(saved.key, 'KEY123');
    assert.equal(saved.mac, 'aa:bb:cc:dd:ee:ff');

    const reg = tv.received.filter((m) => m.type === 'register');
    assert.equal(reg[0].payload.pairingType, 'PROMPT');
    assert.ok(reg[0].payload.manifest.permissions.includes('CONTROL_POWER'));
    assert.equal(reg.at(-1).payload['client-key'], 'KEY123', 'danach mit gespeichertem Schlüssel');

    await new Promise((res) => setTimeout(res, 50)); // App-Titel laden lassen
    await hub.refresh();
    let d = hub.getDevice('lgtv:fernseher');
    assert.equal(d.type, 'tv');
    assert.equal(d.room, 'Wohnzimmer');
    assert.equal(d.state.on, true);
    assert.equal(d.state.volume, 11);
    assert.equal(d.state.source, 'Netflix');

    d = await hub.command('lgtv:fernseher', { action: 'set_volume', value: 25 });
    assert.equal(tv.volume, 25);
    assert.equal(d.state.volume, 25);
    await hub.command('lgtv:fernseher', { action: 'pause' });
    d = await hub.command('lgtv:fernseher', { action: 'turn_off' });
    assert.equal(d.state.on, false);
    await hub.stop();
  } finally {
    await tv.close();
  }
});

test('LG: abgelehnte Kopplung und ausgeschalteter Fernseher', async () => {
  const tv = await fakeTv({ approve: false });
  try {
    const setup = new Setup(new Hub({ integrations: [] }, { log: quiet }), {});
    await assert.rejects(setup.addLgTv({ host: '127.0.0.1' }, { pairTimeout: 1000, connOpts: { ports: tv.ports, timeout: 500 } }), /abgelehnt|denied/);
  } finally {
    await tv.close();
  }
  // Fernseher aus (nichts lauscht): Gerät erscheint als "aus", Einschalten ohne MAC gibt klaren Hinweis
  const a = createAdapter({ type: 'lgtv', connOpts: { ports: { ws: CLOSED, wss: CLOSED }, timeout: 300 }, devices: [{ id: 'tv', host: '127.0.0.1', key: 'K' }] });
  const [d] = await a.discover();
  assert.equal(d.state.on, false);
  assert.equal(d.online, true);
  await assert.rejects(a.execute('tv', { action: 'turn_on' }), /MAC-Adresse/);
  await assert.rejects(a.execute('tv', { action: 'set_volume', value: 3 }), /aus oder nicht erreichbar/);
});

test('Wake-on-LAN-Paket', async () => {
  const rx = createSocket('udp4');
  await new Promise((r) => rx.bind(0, '127.0.0.1', r));
  const got = new Promise((r) => rx.once('message', r));
  await sendWakeOnLan('AA:BB:CC:DD:EE:FF', { address: '127.0.0.1', port: rx.address().port });
  const pkt = await got;
  rx.close();
  assert.equal(pkt.length, 102);
  assert.equal(pkt.subarray(0, 6).toString('hex'), 'ffffffffffff');
  assert.equal(pkt.subarray(6, 12).toString('hex'), 'aabbccddeeff');
  await assert.rejects(sendWakeOnLan('kaputt'), /MAC/);
});

// ---- Fake-LUPUS-Zentrale -------------------------------------------------

async function fakeLupus() {
  const panel = { mode: 0, posts: [] };
  const auth = `Basic ${Buffer.from('admin:geheim').toString('base64')}`;
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/') { res.writeHead(200); return res.end('<html><title>LUPUSEC XT2 Plus</title></html>'); }
      if (req.headers.authorization !== auth) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="LUPUSEC"' });
        return res.end();
      }
      if (req.url === '/action/tokenGet') { res.writeHead(200); return res.end('{"result":1,"message":"TOK1"}'); }
      if (req.headers['x-token'] !== 'TOK1') { res.writeHead(401); return res.end(); }
      if (req.url === '/action/panelCondGet') {
        res.writeHead(200);
        // Steuerzeichen wie im Original
        return res.end(`{"updates":{\n\t"mode_a1":"{AREA_MODE_${panel.mode}}",\n\t"battery":""}}`);
      }
      if (req.url === '/action/deviceListGet') {
        res.writeHead(200);
        return res.end(JSON.stringify({ senrows: [
          { sid: 'RF:0001', name: 'Haustür', type: 4, openClose: '{WEB_MSG_DC_OPEN}' },
          { sid: 'RF:0002', name: 'Küchenfenster', type: 4, status: '{WEB_MSG_DC_CLOSE}' },
          { sid: 'RF:0003', name: 'Rauchmelder', type: 11, status: '' },
        ] }));
      }
      if (req.url === '/action/panelCondPost' && req.method === 'POST') {
        const p = new URLSearchParams(body);
        panel.posts.push(Object.fromEntries(p));
        panel.mode = Number(p.get('mode'));
        res.writeHead(200);
        return res.end('{"result":1,"message":"OK"}');
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  panel.host = `127.0.0.1:${srv.address().port}`;
  panel.port = srv.address().port;
  panel.close = () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); });
  return panel;
}

test('LUPUS: JSON mit Steuerzeichen', () => {
  assert.deepEqual(parseLupusJson('{"a":\n\t"b\tc"}'), { a: 'bc' });
  assert.throws(() => parseLupusJson('<html>'), /Unerwartete Antwort/);
});

test('LUPUS: finden, einrichten, Status, scharf/unscharf mit PIN', async () => {
  const lp = await fakeLupus();
  try {
    const found = await probeHost('127.0.0.1', { port: lp.port, haPort: CLOSED, lgPorts: { ws: CLOSED, wss: CLOSED }, timeout: 800 });
    assert.deepEqual(found.map((f) => f.type), ['lupus']);

    const hub = new Hub({ integrations: [] }, { log: quiet });
    const setup = new Setup(hub, {});
    await assert.rejects(setup.addLupus({ host: lp.host, username: 'admin', password: 'falsch' }), /Benutzername oder Passwort/);
    const info = await setup.addLupus({ host: lp.host, username: 'admin', password: 'geheim', pin: '4711', room: 'Flur' });
    assert.deepEqual(info, { areas: 1, sensors: 2 });

    let alarm = hub.getDevice('lupus:area1');
    assert.equal(alarm.state.alarm, 'disarmed');
    assert.equal(alarm.state.codeRequired, true);
    assert.equal(alarm.room, 'Flur');
    assert.equal(hub.getDevice('lupus:RF_0001').state.value, 'Offen');
    assert.equal(hub.getDevice('lupus:RF_0002').state.value, 'Geschlossen');
    assert.ok(!hub.listDevices().some((d) => d.name === 'Rauchmelder'));

    alarm = await hub.command('lupus:area1', { action: 'arm_away' });
    assert.equal(alarm.state.alarm, 'armed_away');
    alarm = await hub.command('lupus:area1', { action: 'arm_home' });
    assert.equal(alarm.state.alarm, 'armed_home');
    await assert.rejects(hub.command('lupus:area1', { action: 'disarm', value: '0000' }), /Falscher Code/);
    await assert.rejects(hub.command('lupus:area1', { action: 'disarm' }), /Falscher Code/);
    assert.equal(lp.mode, 2, 'falscher Code schickt nichts an die Zentrale');
    alarm = await hub.command('lupus:area1', { action: 'disarm', value: '4711' });
    assert.equal(alarm.state.alarm, 'disarmed');
    assert.deepEqual(lp.posts, [{ area: '1', mode: '1' }, { area: '1', mode: '2' }, { area: '1', mode: '0' }]);
    await assert.rejects(hub.command('lupus:area1', { action: 'arm_night' }), /Modus/);
    await hub.stop();
  } finally {
    await lp.close();
  }
});
