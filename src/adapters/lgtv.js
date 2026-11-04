import { createSocket } from 'node:dgram';
import { Adapter } from './base.js';
import { makeDevice, HubError } from '../device.js';
import { WsClient } from '../ws.js';

// LG-Fernseher mit webOS, direkt im Heimnetz (SSAP über WebSocket).
// Protokoll nach dem Vorbild von aiowebostv (Apache-2.0), wie es Home Assistant nutzt.
//
// config: { devices: [ { id: "wohnzimmer", name: "Fernseher", room: "Wohnzimmer",
//                        host: "192.168.1.40", key: "<client-key>", mac: "aa:bb:…" } ] }
// "key" bekommt man beim Koppeln (Abfrage auf dem Fernseher bestätigen),
// "mac" wird zum Einschalten per Wake-on-LAN gebraucht und beim Koppeln ausgelesen.

const OFF_STATES = ['Power Off', 'Suspend', 'Active Standby'];

const REGISTRATION = {
  forcePairing: false,
  pairingType: 'PROMPT',
  manifest: {
    appVersion: '1.1',
    manifestVersion: 1,
    permissions: [
      'APP_TO_APP', 'CLOSE', 'CONTROL_AUDIO', 'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK',
      'CONTROL_INPUT_MEDIA_PLAYBACK', 'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_TEXT',
      'CONTROL_INPUT_TV', 'CONTROL_MOUSE_AND_KEYBOARD', 'CONTROL_POWER', 'CONTROL_TV_SCREEN',
      'LAUNCH', 'LAUNCH_WEBAPP', 'READ_APP_STATUS', 'READ_COUNTRY_INFO', 'READ_CURRENT_CHANNEL',
      'READ_INPUT_DEVICE_LIST', 'READ_INSTALLED_APPS', 'READ_LGE_SDX', 'READ_LGE_TV_INPUT_EVENTS',
      'READ_NETWORK_STATE', 'READ_NOTIFICATIONS', 'READ_POWER_STATE', 'READ_RUNNING_APPS',
      'READ_SETTINGS', 'READ_TV_CHANNEL_LIST', 'READ_TV_CURRENT_TIME', 'READ_UPDATE_INFO',
      'SEARCH', 'TEST_OPEN', 'TEST_PROTECTED', 'TEST_SECURE', 'UPDATE_FROM_REMOTE_APP',
      'WRITE_NOTIFICATION_ALERT', 'WRITE_NOTIFICATION_TOAST', 'WRITE_SETTINGS',
    ],
  },
};

// Eine Verbindung zu einem Fernseher. ws:// auf 3000, sonst wss:// auf 3001 (neuere Firmware).
export class WebOsConnection {
  constructor(host, { ports = { ws: 3000, wss: 3001 }, timeout = 4000 } = {}) {
    this.host = host;
    this.ports = ports;
    this.timeout = timeout;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  get connected() {
    return Boolean(this.ws?.open);
  }

  async open() {
    try {
      this.ws = await WsClient.connect(`ws://${this.host}:${this.ports.ws}`, { timeout: this.timeout });
    } catch {
      this.ws = await WsClient.connect(`wss://${this.host}:${this.ports.wss}`, { timeout: this.timeout });
    }
    this.ws.on('message', (text) => this.onMessage(text));
    this.ws.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('Verbindung zum Fernseher getrennt'));
      this.pending.clear();
    });
    this.ws.on('error', () => {});
  }

  onMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    const p = this.pending.get(msg.id);
    if (p) p.handle(msg);
  }

  // Schickt eine Nachricht und wartet auf die passende Antwort.
  // accept(msg) -> true (fertig) | false (weiter warten); wirft bei Fehler.
  exchange(message, { timeout = this.timeout, accept = () => true } = {}) {
    const id = message.id ?? `m${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Fernseher antwortet nicht')); }, timeout);
      const done = (fn, v) => { clearTimeout(timer); this.pending.delete(id); fn(v); };
      this.pending.set(id, {
        reject: (e) => done(reject, e),
        handle: (msg) => {
          if (msg.type === 'error') return done(reject, new Error(msg.error || 'Fehler vom Fernseher'));
          try {
            if (accept(msg)) done(resolve, msg);
          } catch (e) { done(reject, e); }
        },
      });
      try { this.ws.send(JSON.stringify({ ...message, id })); } catch (e) { done(reject, e); }
    });
  }

  async request(uri, payload = {}) {
    const msg = await this.exchange({ type: 'request', uri: `ssap://${uri}`, payload });
    if (msg.payload?.returnValue === false) throw new Error(msg.payload.errorText || `Befehl ${uri} fehlgeschlagen`);
    return msg.payload ?? {};
  }

  async hello() {
    const msg = await this.exchange({ id: 'hello', type: 'hello', payload: {} });
    return msg.payload ?? {};
  }

  // Mit gespeichertem Schlüssel anmelden oder (ohne Schlüssel) die Abfrage am Fernseher auslösen.
  async register(key, { pairTimeout = 60000 } = {}) {
    await this.hello().catch(() => {});
    // Neuere webOS-Versionen wollen vor der Registrierung eine Systemabfrage sehen
    await this.request('system/getSystemInfo').catch(() => {});
    const payload = structuredClone(REGISTRATION);
    if (key) payload['client-key'] = key;
    const msg = await this.exchange({ type: 'register', payload }, {
      timeout: key ? this.timeout : pairTimeout,
      accept: (m) => m.type === 'registered',
    });
    const clientKey = msg.payload?.['client-key'];
    if (!clientKey) throw new Error('Kopplung fehlgeschlagen');
    return clientKey;
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}

export async function sendWakeOnLan(mac, { address = '255.255.255.255', port = 9 } = {}) {
  const hex = String(mac).replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) throw new HubError(400, 'Ungültige MAC-Adresse');
  const macBuf = Buffer.from(hex, 'hex');
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(macBuf)]);
  return new Promise((resolve, reject) => {
    const sock = createSocket('udp4');
    sock.once('error', (e) => { sock.close(); reject(e); });
    sock.bind(() => {
      sock.setBroadcast(true);
      sock.send(packet, port, address, (err) => {
        sock.close();
        if (err) reject(err); else resolve();
      });
    });
  });
}

export class LgTvAdapter extends Adapter {
  constructor(id, config) {
    super(id, config);
    this.list = config.devices ?? [];
    this.byId = new Map(this.list.map((d) => [d.id, d]));
    this.conns = new Map(); // id -> WebOsConnection
    this.nextTry = new Map(); // id -> Zeitpunkt des nächsten Verbindungsversuchs
    this.appTitles = new Map(); // id -> Map(appId -> Titel)
    this.connOpts = config.connOpts ?? {};
  }

  async connection(d) {
    const existing = this.conns.get(d.id);
    if (existing?.connected) return existing;
    if (Date.now() < (this.nextTry.get(d.id) ?? 0)) return null;
    const conn = new WebOsConnection(d.host, this.connOpts);
    try {
      await conn.open();
      await conn.register(d.key);
      this.conns.set(d.id, conn);
      this.nextTry.delete(d.id);
      this.loadAppTitles(d, conn);
      return conn;
    } catch (err) {
      conn.close();
      // Ausgeschalteter Fernseher: nicht bei jeder Abfrage neu versuchen
      this.nextTry.set(d.id, Date.now() + (this.connOpts.retryMs ?? 15000));
      if (/Kopplung|denied|rejected|cancel/i.test(err.message)) this.lastError = err.message;
      return null;
    }
  }

  async loadAppTitles(d, conn) {
    try {
      const res = await conn.request('com.webos.applicationManager/listLaunchPoints');
      this.appTitles.set(d.id, new Map((res.launchPoints ?? []).map((a) => [a.id, a.title])));
    } catch { /* nicht wichtig */ }
  }

  async discover() {
    return Promise.all(this.list.map((d) => this.read(d)));
  }

  async read(d) {
    const base = {
      id: this.deviceId(d.id), adapter: this.id, name: d.name ?? 'Fernseher', room: d.room ?? 'Wohnzimmer',
      type: 'tv', capabilities: ['onoff', 'media'],
    };
    const conn = await this.connection(d);
    if (!conn) return makeDevice({ ...base, state: { on: false } });
    const state = { on: true };
    try {
      const p = await conn.request('com.webos.service.tvpower/power/getPowerState').catch(() => null);
      if (p?.state && OFF_STATES.includes(p.state)) state.on = false;
      if (p?.state === 'Screen Off') state.screenOff = true;
      if (state.on) {
        const [vol, app] = await Promise.all([
          conn.request('audio/getVolume').catch(() => null),
          conn.request('com.webos.applicationManager/getForegroundAppInfo').catch(() => null),
        ]);
        const v = vol?.volumeStatus ?? vol;
        if (typeof v?.volume === 'number') state.volume = v.volume;
        if (v?.muteStatus !== undefined || v?.muted !== undefined) state.muted = Boolean(v.muteStatus ?? v.muted);
        if (app?.appId) state.source = this.appTitles.get(d.id)?.get(app.appId) ?? app.appId;
      }
    } catch {
      conn.close();
      return makeDevice({ ...base, state: { on: false } });
    }
    return makeDevice({ ...base, state });
  }

  async execute(localId, { action, value }) {
    const d = this.byId.get(localId);
    if (action === 'turn_on') {
      const conn = this.conns.get(d.id);
      if (conn?.connected) {
        // Bildschirm aus / Standby mit noch offener Verbindung
        await conn.request('system/turnOn').catch(() => {});
        await conn.request('com.webos.service.tvpower/power/turnOnScreen').catch(() => {});
      }
      if (!d.mac && !conn?.connected) {
        throw new HubError(400, `${d.name ?? 'Fernseher'} ist aus. Zum Einschalten fehlt die MAC-Adresse (siehe Anleitung).`);
      }
      if (d.mac) await sendWakeOnLan(d.mac, this.config.wol);
      this.nextTry.delete(d.id); // gleich wieder verbinden
      return;
    }
    const conn = await this.connection(d);
    if (!conn) throw new HubError(409, `${d.name ?? 'Fernseher'} ist aus oder nicht erreichbar`);
    switch (action) {
      case 'turn_off': return conn.request('system/turnOff');
      case 'toggle': return this.execute(localId, { action: (await this.read(d)).state.on ? 'turn_off' : 'turn_on' });
      case 'set_volume': return conn.request('audio/setVolume', { volume: Math.round(value) });
      case 'play': return conn.request('media.controls/play');
      case 'pause': return conn.request('media.controls/pause');
      default: throw new HubError(400, `Aktion ${action} nicht unterstützt`);
    }
  }

  async stop() {
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
  }
}

// Koppeln: Abfrage am Fernseher auslösen und auf "Zulassen" warten.
// Liefert { key, mac, model }.
export async function pairLgTv(host, { pairTimeout = 60000, connOpts = {} } = {}) {
  const conn = new WebOsConnection(host, connOpts);
  try {
    await conn.open();
    const key = await conn.register(null, { pairTimeout });
    let mac;
    try {
      const info = await conn.request('com.webos.service.connectionmanager/getinfo');
      mac = info.wiredInfo?.macAddress || info.wifiInfo?.macAddress || undefined;
    } catch { /* MAC optional */ }
    let model;
    try { model = (await conn.request('system/getSystemInfo')).modelName; } catch { /* egal */ }
    return { key, mac, model };
  } finally {
    conn.close();
  }
}
