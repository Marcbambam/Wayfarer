import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createAdapter } from '../src/adapters/index.js';

// Kleiner Fake-Server, der alle Anfragen protokolliert.
async function fake(handler) {
  const calls = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const call = { method: req.method, url: req.url, body: body ? JSON.parse(body) : null, headers: req.headers };
      calls.push(call);
      const out = handler(call);
      res.writeHead(out === undefined ? 404 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out ?? { error: 'not found' }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${srv.address().port}`;
  return { host, calls, close: () => new Promise((r) => srv.close(r)) };
}

test('Home Assistant: Entitäten abbilden und Dienste aufrufen', async () => {
  const srv = await fake(({ method, url }) => {
    if (method === 'GET' && url === '/api/states') {
      return [
        { entity_id: 'light.kueche', state: 'on', attributes: { friendly_name: 'Küche', brightness: 128, supported_color_modes: ['xy'], rgb_color: [255, 0, 0] } },
        { entity_id: 'climate.wz', state: 'heat', attributes: { friendly_name: 'Heizung', current_temperature: 20, temperature: 22 } },
        { entity_id: 'sensor.temp', state: '21.3', attributes: { friendly_name: 'Temp', unit_of_measurement: '°C', device_class: 'temperature' } },
        { entity_id: 'sensor.akku', state: '80', attributes: { friendly_name: 'Akku', device_class: 'battery' } },
        { entity_id: 'sensor.temp_ohne_raum', state: '19', attributes: { device_class: 'temperature' } },
        { entity_id: 'switch.steckdose', state: 'unavailable', attributes: { device_class: 'outlet' } },
        { entity_id: 'automation.x', state: 'on', attributes: {} },
        { entity_id: 'lock.haustuer', state: 'locked', attributes: { friendly_name: 'Haustür', supported_features: 1 } },
        { entity_id: 'vacuum.dreame', state: 'docked', attributes: { friendly_name: 'Dreame', battery_level: 87 } },
        { entity_id: 'alarm_control_panel.lupus', state: 'armed_away', attributes: { friendly_name: 'Lupus', supported_features: 3, code_format: 'number', code_arm_required: false } },
        { entity_id: 'media_player.lg', state: 'off', attributes: { friendly_name: 'LG TV', device_class: 'tv' } },
      ];
    }
    if (method === 'POST' && url === '/api/template') {
      return [['light.kueche', 'Küche'], ['sensor.temp', 'Wohnzimmer'], ['sensor.akku', 'Wohnzimmer'], ['vacuum.dreame', 'Wohnzimmer']];
    }
    if (method === 'POST' && url.startsWith('/api/services/')) return [];
    return undefined;
  });
  try {
    const ha = createAdapter({ type: 'homeassistant', id: 'ha', url: `http://${srv.host}`, token: 'abc' });
    const devs = await ha.discover();
    const ids = devs.map((d) => d.id).sort();
    assert.deepEqual(ids, [
      'ha:alarm_control_panel.lupus', 'ha:climate.wz', 'ha:light.kueche', 'ha:lock.haustuer',
      'ha:media_player.lg', 'ha:sensor.temp', 'ha:switch.steckdose', 'ha:vacuum.dreame',
    ]);
    const get = (id) => devs.find((d) => d.id === `ha:${id}`);
    const light = get('light.kueche');
    assert.deepEqual(light.capabilities, ['onoff', 'brightness', 'color']);
    assert.equal(light.state.brightness, 50);
    assert.equal(light.state.color, '#ff0000');
    assert.equal(light.room, 'Küche', 'Raum aus HA-Bereich');
    assert.equal(get('sensor.temp').state.value, 21.3);
    assert.equal(get('climate.wz').room, 'Home Assistant');
    const plug = get('switch.steckdose');
    assert.equal(plug.type, 'plug');
    assert.equal(plug.online, false);
    assert.deepEqual(get('lock.haustuer').capabilities, ['lock', 'lock_open']);
    assert.deepEqual(get('vacuum.dreame').state, { status: 'docked', battery: 87 });
    assert.deepEqual(get('alarm_control_panel.lupus').state, { alarm: 'armed_away', modes: ['home', 'away'], codeRequired: true, codeArmRequired: false });
    assert.equal(get('media_player.lg').type, 'tv');
    assert.equal(srv.calls[0].headers.authorization, 'Bearer abc');

    await ha.execute('light.kueche', { action: 'set_brightness', value: 30 });
    await ha.execute('climate.wz', { action: 'set_target_temp', value: 21 });
    await ha.execute('lock.haustuer', { action: 'unlatch' });
    await ha.execute('vacuum.dreame', { action: 'start' });
    await ha.execute('vacuum.dreame', { action: 'pause' });
    await ha.execute('alarm_control_panel.lupus', { action: 'disarm', value: '4711' });
    await ha.execute('alarm_control_panel.lupus', { action: 'arm_home' });
    const posts = srv.calls.filter((c) => c.method === 'POST' && c.url.startsWith('/api/services/'));
    assert.deepEqual(posts.map((p) => [p.url.replace('/api/services/', ''), p.body]), [
      ['light/turn_on', { entity_id: 'light.kueche', brightness_pct: 30 }],
      ['climate/set_temperature', { entity_id: 'climate.wz', temperature: 21 }],
      ['lock/open', { entity_id: 'lock.haustuer' }],
      ['vacuum/start', { entity_id: 'vacuum.dreame' }],
      ['vacuum/pause', { entity_id: 'vacuum.dreame' }],
      ['alarm_control_panel/alarm_disarm', { entity_id: 'alarm_control_panel.lupus', code: '4711' }],
      ['alarm_control_panel/alarm_arm_home', { entity_id: 'alarm_control_panel.lupus' }],
    ]);

    // sensors: "all" holt alle Sensoren
    const all = await createAdapter({ type: 'homeassistant', url: `http://${srv.host}`, token: 'abc', sensors: 'all' }).discover();
    assert.equal(all.filter((d) => d.type === 'sensor').length, 3);
  } finally {
    await srv.close();
  }
});

test('Hue: Lampen, Räume und Befehle', async () => {
  const srv = await fake(({ method, url }) => {
    if (url === '/api/key/lights') {
      return {
        1: { name: 'Sofa', type: 'Extended color light', state: { on: true, bri: 254, xy: [0.3127, 0.329], reachable: true } },
        2: { name: 'Stecker', type: 'On/Off plug-in unit', state: { on: false, reachable: false } },
      };
    }
    if (url === '/api/key/groups') return { 1: { name: 'Wohnzimmer', type: 'Room', lights: ['1'] } };
    if (method === 'PUT') return [{ success: {} }];
    return undefined;
  });
  try {
    const hue = createAdapter({ type: 'hue', bridge: srv.host, username: 'key' });
    const devs = await hue.discover();
    const sofa = devs.find((d) => d.id === 'hue:1');
    assert.equal(sofa.room, 'Wohnzimmer');
    assert.equal(sofa.state.brightness, 100);
    assert.deepEqual(sofa.capabilities, ['onoff', 'brightness', 'color']);
    const plug = devs.find((d) => d.id === 'hue:2');
    assert.equal(plug.type, 'plug');
    assert.equal(plug.online, false);

    await hue.execute('1', { action: 'set_brightness', value: 50 });
    const put = srv.calls.find((c) => c.method === 'PUT');
    assert.equal(put.url, '/api/key/lights/1/state');
    assert.deepEqual(put.body, { on: true, bri: 127 });
  } finally {
    await srv.close();
  }
});

test('Shelly Gen1 und Gen2', async () => {
  const srv = await fake(({ url }) => {
    if (url === '/relay/0') return { ison: true };
    if (url.startsWith('/relay/0?')) return { ison: false };
    if (url === '/rpc/Switch.GetStatus?id=0') return { output: false };
    if (url.startsWith('/rpc/Switch.Set')) return { was_on: false };
    if (url === '/roller/0') return { current_pos: 40 };
    if (url.startsWith('/roller/0?')) return {};
    return undefined;
  });
  try {
    const shelly = createAdapter({
      type: 'shelly',
      devices: [
        { id: 'a', host: srv.host, gen: 1 },
        { id: 'b', host: srv.host, gen: 2, kind: 'plug' },
        { id: 'c', host: srv.host, gen: 1, kind: 'cover' },
        { id: 'tot', host: '127.0.0.1:1', gen: 1 },
      ],
    });
    const devs = await shelly.discover();
    assert.equal(devs[0].state.on, true);
    assert.equal(devs[1].state.on, false);
    assert.equal(devs[1].type, 'plug');
    assert.equal(devs[2].state.position, 40);
    assert.equal(devs[3].online, false);

    await shelly.execute('a', { action: 'turn_off' });
    await shelly.execute('b', { action: 'turn_on' });
    await shelly.execute('c', { action: 'set_position', value: 75 });
    const urls = srv.calls.map((c) => c.url);
    assert.ok(urls.includes('/relay/0?turn=off'));
    assert.ok(urls.includes('/rpc/Switch.Set?id=0&on=true'));
    assert.ok(urls.includes('/roller/0?go=to_pos&roller_pos=75'));
  } finally {
    await srv.close();
  }
});

test('Tasmota: Status lesen und Befehle', async () => {
  const srv = await fake(({ url }) => {
    const cmnd = new URL(url, 'http://x').searchParams.get('cmnd');
    if (cmnd === 'State') return { POWER: 'ON', Dimmer: 60, Color: 'FF8800' };
    return { ok: cmnd };
  });
  try {
    const t = createAdapter({ type: 'tasmota', devices: [{ id: 'strip', host: srv.host, kind: 'light', color: true }] });
    const [d] = await t.discover();
    assert.deepEqual(d.state, { on: true, brightness: 60, color: '#ff8800' });
    await t.execute('strip', { action: 'set_color', value: '#00ff00' });
    await t.execute('strip', { action: 'set_brightness', value: 20 });
    const cmds = srv.calls.map((c) => new URL(c.url, 'http://x').searchParams.get('cmnd'));
    assert.deepEqual(cmds.slice(1), ['Color 00ff00', 'Dimmer 20']);
  } finally {
    await srv.close();
  }
});

test('Webhook: Aktionen als URLs', async () => {
  const srv = await fake(() => ({ ok: true }));
  try {
    const w = createAdapter({
      type: 'webhook',
      devices: [{ id: 'tor', type: 'cover', actions: { open: `http://${srv.host}/auf`, close: { url: `http://${srv.host}/zu`, method: 'POST', body: { x: 1 } } } }],
    });
    const [d] = await w.discover();
    assert.deepEqual(d.capabilities, ['position']);
    await w.execute('tor', { action: 'close' });
    assert.equal(srv.calls[0].method, 'POST');
    assert.equal(srv.calls[0].url, '/zu');
    const [after] = await w.discover();
    assert.equal(after.state.position, 0);
  } finally {
    await srv.close();
  }
});

test('Unbekannter Integrationstyp gibt hilfreiche Fehlermeldung', () => {
  assert.throws(() => createAdapter({ type: 'zigbee' }), /Verfügbar: demo/);
});
