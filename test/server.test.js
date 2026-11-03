import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/hub.js';
import { createApp } from '../server.js';

async function start(token) {
  const hub = new Hub({ integrations: [{ type: 'demo' }], scenes: [{ id: 'aus', name: 'Aus', actions: [{ type: 'light', action: 'turn_off' }] }] }, { log: { warn() {}, info() {} } });
  await hub.refresh();
  const srv = createApp(hub, { token });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = (path, opts = {}) => fetch(base + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { hub, base, call, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) };
}

test('REST-API: Geräte, Befehle, Szenen', async () => {
  const app = await start();
  try {
    const list = await (await app.call('/api/devices')).json();
    assert.ok(list.length > 5);

    let r = await app.call('/api/devices/demo:kueche-licht/command', { method: 'POST', body: { action: 'turn_on' } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).state.on, true);

    r = await app.call('/api/devices/demo:kueche-licht/command', { method: 'POST', body: { action: 'fliegen' } });
    assert.equal(r.status, 400);

    r = await app.call('/api/scenes/aus/run', { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(app.hub.getDevice('demo:kueche-licht').state.on, false);

    r = await app.call('/api/command', { method: 'POST', body: { room: 'Küche', action: 'turn_on' } });
    assert.equal((await r.json()).length, 2);

    r = await app.call('/index.html');
    assert.match(r.headers.get('content-type'), /text\/html/);
    r = await app.call('/../package.json');
    assert.notEqual(r.status, 200);
  } finally {
    await app.close();
  }
});

test('Token-Schutz', async () => {
  const app = await start('geheim');
  try {
    assert.equal((await app.call('/api/devices')).status, 401);
    assert.equal((await app.call('/api/devices', { headers: { authorization: 'Bearer falsch' } })).status, 401);
    assert.equal((await app.call('/api/devices', { headers: { authorization: 'Bearer geheim' } })).status, 200);
    assert.equal((await app.call('/api/status?token=geheim')).status, 200);
    assert.equal((await app.call('/')).status, 200); // Oberfläche selbst ist öffentlich, Daten nicht
  } finally {
    await app.close();
  }
});

test('Live-Updates per Server-Sent Events', async () => {
  const app = await start();
  try {
    const ctrl = new AbortController();
    const res = await fetch(`${app.base}/api/events`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const waitFor = async (re) => {
      while (!re.test(buf)) buf += dec.decode((await reader.read()).value);
    };
    await waitFor(/event: init/);
    await app.call('/api/devices/demo:kueche-kaffee/command', { method: 'POST', body: { action: 'turn_on' } });
    await waitFor(/event: device\ndata: .*kueche-kaffee/);
    ctrl.abort();
  } finally {
    await app.close();
  }
});
