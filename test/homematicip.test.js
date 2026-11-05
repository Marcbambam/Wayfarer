import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { normalizeAccessPoint, clientAuth } from '../src/adapters/homematicip.js';
import { Hub } from '../src/hub.js';
import { Setup } from '../src/setup.js';

const quiet = { warn() {}, info() {} };
const AP = '3014F711A000000000000ABC';

// Nachgebaute Homematic-IP-Cloud (Lookup + REST)
async function fakeCloud({ pressAfter = 2, lockPin = '' } = {}) {
  const cloud = {
    calls: [], acknowledgedChecks: 0, token: 'TOKEN-XYZ',
    state: {
      home: { id: 'home1' },
      groups: {
        'g-wz': { id: 'g-wz', type: 'HEATING', label: 'Wohnzimmer', unreach: false, actualTemperature: 20.4, setPointTemperature: 21, humidity: 47, windowState: 'CLOSED', controlMode: 'AUTOMATIC', channels: [] },
        'g-bad': { id: 'g-bad', type: 'HEATING', label: 'Bad', unreach: false, actualTemperature: 22.1, setPointTemperature: 23, windowState: 'TILTED', channels: [] },
        'm-wz': { id: 'm-wz', type: 'META', label: 'Wohnzimmer', groups: ['g-wz'], channels: [] },
        'm-flur': { id: 'm-flur', type: 'META', label: 'Flur', groups: [], channels: [{ deviceId: 'd-dld', channelIndex: 1 }] },
      },
      devices: {
        'd-dld': {
          id: 'd-dld', type: 'DOOR_LOCK_DRIVE', label: 'Haustür',
          functionalChannels: {
            0: { index: 0, functionalChannelType: 'DEVICE_OPERATIONLOCK', unreach: false },
            1: { index: 1, functionalChannelType: 'DOOR_LOCK_CHANNEL', lockState: 'LOCKED', motorState: 'STOPPED' },
          },
        },
        'd-trv': { id: 'd-trv', type: 'HEATING_THERMOSTAT', label: 'Thermostat', functionalChannels: { 0: { index: 0, functionalChannelType: 'DEVICE_OPERATIONLOCK' } } },
      },
    },
  };
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const b = body ? JSON.parse(body) : {};
      cloud.calls.push({ url: req.url, body: b, headers: req.headers });
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(obj ? JSON.stringify(obj) : ''); };
      const port = srv.address().port;
      if (req.url === '/getHost') {
        if (b.id !== AP) return send(400, { errorCode: 'INVALID_ID' });
        return send(200, { urlREST: `http://127.0.0.1:${port}/`, urlWebSocket: 'wss://x' });
      }
      if (req.headers.clientauth !== clientAuth(AP) || req.headers['accesspoint-id'] !== AP || req.headers.version !== '12') {
        return send(403, { errorCode: 'INVALID_CLIENTAUTH' });
      }
      if (req.url === '/hmip/auth/connectionRequest') return b.sgtin === AP ? send(200, {}) : send(400, { errorCode: 'INVALID_SGTIN' });
      if (req.url === '/hmip/auth/isRequestAcknowledged') {
        cloud.acknowledgedChecks += 1;
        return cloud.acknowledgedChecks > pressAfter ? send(200, {}) : send(400, { errorCode: 'NOT_ACKNOWLEDGED' });
      }
      if (req.url === '/hmip/auth/requestAuthToken') return send(200, { authToken: cloud.token });
      if (req.url === '/hmip/auth/confirmAuthToken') return b.authToken === cloud.token ? send(200, { clientId: 'client-1' }) : send(403, {});
      if (req.headers.authtoken !== cloud.token) return send(403, {});
      if (req.url === '/hmip/home/getCurrentState') return send(200, cloud.state);
      if (req.url === '/hmip/group/heating/setSetPointTemperature') {
        cloud.state.groups[b.groupId].setPointTemperature = b.setPointTemperature;
        return send(200, null);
      }
      if (req.url === '/hmip/device/control/setLockState') {
        if (b.authorizationPin !== lockPin) return send(400, { errorCode: 'INVALID_AUTHORIZATION_PIN' });
        cloud.state.devices[b.deviceId].functionalChannels[b.channelIndex].lockState = b.targetLockState;
        return send(200, null);
      }
      return send(404, { errorCode: 'UNKNOWN' });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  cloud.lookupUrl = `http://127.0.0.1:${srv.address().port}/getHost`;
  cloud.close = () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); });
  return cloud;
}

test('Access-Point-ID und Client-Auth', () => {
  assert.equal(normalizeAccessPoint('3014-f711-a000-0000-0000-0abc'), AP);
  assert.throws(() => normalizeAccessPoint('1234'), /24 Zeichen/);
  assert.equal(clientAuth(AP), createHash('sha512').update(`${AP}jiLpVitHvWnIGD1yo7MA`).digest('hex').toUpperCase());
});

test('Homematic IP: koppeln mit blauer Taste, Heizung und Türschloss', async () => {
  const cloud = await fakeCloud({ pressAfter: 2, lockPin: '1234' });
  try {
    const hub = new Hub({ integrations: [] }, { log: quiet });
    const setup = new Setup(hub, {});
    const r = await setup.addHomematicIp({ accessPoint: '3014-F711-A000-0000-0000-0ABC', lockPin: '1234' }, { lookupUrl: cloud.lookupUrl, intervalMs: 10, waitMs: 2000 });
    assert.deepEqual(r, { heating: 2, locks: 1 });
    assert.equal(cloud.acknowledgedChecks, 3, 'hat auf die Taste gewartet');
    const saved = hub.config.integrations[0];
    assert.equal(saved.authToken, 'TOKEN-XYZ');
    assert.equal(saved.accessPoint, AP);
    assert.equal(saved.lockPin, '1234');

    const wz = hub.getDevice('hmip:heat-g-wz');
    assert.equal(wz.room, 'Wohnzimmer');
    assert.deepEqual(wz.capabilities, ['target_temp']);
    assert.equal(wz.state.temperature, 20.4);
    assert.equal(wz.state.target, 21);
    assert.equal(wz.state.humidity, 47);
    assert.equal(hub.getDevice('hmip:heat-g-bad').state.window, 'gekippt');
    assert.equal(hub.getDevice('hmip:heat-g-bad').room, 'Bad', 'ohne Raum-Gruppe: Name der Heizgruppe');

    const lock = hub.getDevice('hmip:lock-d-dld');
    assert.equal(lock.name, 'Haustür');
    assert.equal(lock.room, 'Flur');
    assert.equal(lock.state.locked, true);

    let d = await hub.command('hmip:heat-g-wz', { action: 'set_target_temp', value: 22.5 });
    assert.equal(d.state.target, 22.5);
    d = await hub.command('hmip:lock-d-dld', { action: 'unlatch' });
    assert.equal(d.state.lockState, 'open');
    d = await hub.command('hmip:lock-d-dld', { action: 'lock' });
    assert.equal(d.state.locked, true);
    const lockCall = cloud.calls.find((c) => c.url === '/hmip/device/control/setLockState');
    assert.deepEqual(lockCall.body, { deviceId: 'd-dld', channelIndex: 1, authorizationPin: '1234', targetLockState: 'OPEN' });

    // Sicherheitsregel gilt auch hier
    await assert.rejects(hub.commandMany({ room: 'Flur' }, { action: 'unlock' }), /einzelnes Gerät/);
    await hub.stop();
  } finally {
    await cloud.close();
  }
});

test('Homematic IP: Fehlerfälle', async () => {
  const cloud = await fakeCloud({ pressAfter: 1000, lockPin: '9999' });
  try {
    const setup = new Setup(new Hub({ integrations: [] }, { log: quiet }), {});
    await assert.rejects(
      setup.addHomematicIp({ accessPoint: AP }, { lookupUrl: cloud.lookupUrl, intervalMs: 10, waitMs: 60 }),
      /blaue Taste/,
    );
    await assert.rejects(setup.addHomematicIp({ accessPoint: 'falsch' }, { lookupUrl: cloud.lookupUrl }), /24 Zeichen/);

    // Falsche Berechtigungs-PIN fürs Schloss -> verständliche Meldung
    const hub = new Hub({ integrations: [{ type: 'homematicip', id: 'hmip', accessPoint: AP, authToken: cloud.token, lockPin: '0000', lookupUrl: cloud.lookupUrl }] }, { log: quiet });
    await hub.refresh();
    await assert.rejects(hub.command('hmip:lock-d-dld', { action: 'unlock' }), /Berechtigungs-PIN/);

    // Abgelaufene Anmeldung
    const bad = new Hub({ integrations: [{ type: 'homematicip', id: 'hmip', accessPoint: AP, authToken: 'alt', lookupUrl: cloud.lookupUrl }] }, { log: quiet });
    await bad.refresh();
    assert.match(bad.status().integrations[0].error, /neu verbinden/);
  } finally {
    await cloud.close();
  }
});

test('Homematic IP: Cloud wird nicht bei jeder Abfrage gefragt', async () => {
  const cloud = await fakeCloud();
  try {
    const hub = new Hub({ integrations: [{ type: 'homematicip', id: 'hmip', accessPoint: AP, authToken: cloud.token, lookupUrl: cloud.lookupUrl }] }, { log: quiet });
    await hub.refresh();
    await hub.refresh();
    await hub.refresh();
    assert.equal(cloud.calls.filter((c) => c.url === '/hmip/home/getCurrentState').length, 1);
    assert.equal(cloud.calls.filter((c) => c.url === '/getHost').length, 1);
  } finally {
    await cloud.close();
  }
});
