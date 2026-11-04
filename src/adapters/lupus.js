import { timingSafeEqual } from 'node:crypto';
import { Adapter } from './base.js';
import { makeDevice, HubError } from '../device.js';

// LUPUSEC-Alarmanlagen XT2 Plus / XT3 / XT4, direkt über die Weboberfläche der Zentrale.
// Schnittstelle nach dem Vorbild von lupupy (MIT), das auch Home Assistant nutzt:
//   GET  /action/tokenGet       -> { message: "<token>" }   (Header X-Token, ca. 60 s gültig)
//   GET  /action/panelCondGet   -> { updates: { mode_a1: "{AREA_MODE_0}", mode_a2: … } }
//   POST /action/panelCondPost  area=1&mode=0|1|2            (0 unscharf, 1 scharf, 2 zuhause)
//   GET  /action/deviceListGet  -> { senrows: [ { sid, name, type, status|openClose } ] }
//
// config: { host: "192.168.1.30", username: "…", password: "…",
//           pin?: "1234",            // Dashboard fragt beim Unscharfschalten danach
//           name?: "Alarmanlage", room?: "Flur", sensors?: true }

const MODE_TO_STATE = {
  '{AREA_MODE_0}': 'disarmed',
  '{AREA_MODE_1}': 'armed_away',
  '{AREA_MODE_2}': 'armed_home',
  '{AREA_MODE_3}': 'armed_home',
  '{AREA_MODE_4}': 'armed_home',
};
const ACTION_TO_MODE = { disarm: 0, arm_away: 1, arm_home: 2 };
const CONTACT_TYPES = new Set([4, '4']);

// Antworten enthalten teils Steuerzeichen (Tabs, Zeilenumbrüche in Strings) → vor dem Parsen entfernen.
export function parseLupusJson(text) {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new HubError(502, 'Unerwartete Antwort der LUPUS-Zentrale');
  }
}

export class LupusAdapter extends Adapter {
  constructor(id, config) {
    super(id, config);
    if (!config.host || !config.username || !config.password) {
      throw new Error(`${id}: "host", "username" und "password" sind für LUPUS erforderlich`);
    }
    this.base = `http://${config.host}/action`;
    this.auth = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
    this.token = null;
    this.tokenAt = 0;
    this.areas = ['1'];
  }

  async raw(path, { method = 'GET', form, retry = true } = {}) {
    if (path !== 'tokenGet' && (!this.token || Date.now() - this.tokenAt > 50_000)) await this.refreshToken();
    const headers = { authorization: this.auth };
    if (this.token && path !== 'tokenGet') headers['x-token'] = this.token;
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    let res;
    try {
      res = await fetch(`${this.base}/${path}`, { method, headers, body, signal: AbortSignal.timeout(this.config.timeout ?? 8000) });
    } catch {
      throw new HubError(502, `LUPUS-Zentrale unter ${this.config.host} nicht erreichbar`);
    }
    if (res.status === 401) {
      if (retry && path !== 'tokenGet') {
        this.token = null;
        return this.raw(path, { method, form, retry: false });
      }
      throw new HubError(401, 'LUPUS: Benutzername oder Passwort falsch');
    }
    if (!res.ok) throw new HubError(502, `LUPUS antwortet mit HTTP ${res.status}`);
    return parseLupusJson(await res.text());
  }

  async refreshToken() {
    const r = await this.raw('tokenGet');
    if (!r?.message) throw new HubError(502, 'LUPUS: kein Token erhalten – ist das wirklich eine XT2 Plus/XT3/XT4?');
    this.token = r.message;
    this.tokenAt = Date.now();
  }

  async discover() {
    const panel = await this.raw('panelCondGet');
    const upd = panel.updates ?? {};
    this.areas = Object.keys(upd).filter((k) => /^mode_a\d+$/.test(k)).map((k) => k.slice(6)).sort();
    if (!this.areas.length) throw new HubError(502, 'LUPUS: Alarmstatus nicht gefunden');
    const name = this.config.name ?? 'Alarmanlage';
    const devices = this.areas.map((a) => makeDevice({
      id: this.deviceId(`area${a}`),
      adapter: this.id,
      name: this.areas.length > 1 ? `${name} Bereich ${a}` : name,
      room: this.config.room ?? 'Flur',
      type: 'alarm',
      capabilities: ['alarm'],
      state: {
        alarm: MODE_TO_STATE[upd[`mode_a${a}`]] ?? 'unknown',
        modes: ['away', 'home'],
        codeRequired: Boolean(this.config.pin),
        codeArmRequired: false,
      },
    }));

    if (this.config.sensors !== false) {
      try {
        const list = await this.raw('deviceListGet');
        for (const s of list.senrows ?? []) {
          if (!CONTACT_TYPES.has(s.type) || !s.sid) continue;
          const st = s.openClose ?? s.status ?? '';
          const open = st === '{WEB_MSG_DC_OPEN}' || st === 'Offen' || st === '1' || st === 1;
          devices.push(makeDevice({
            id: this.deviceId(String(s.sid).replace(/[^\w.-]/g, '_')),
            adapter: this.id,
            name: s.name || 'Kontakt',
            room: this.config.sensorRoom ?? 'Tür- & Fensterkontakte',
            type: 'sensor',
            capabilities: ['read'],
            state: { value: open ? 'Offen' : 'Geschlossen', unit: '', open },
          }));
        }
      } catch { /* Sensoren sind optional */ }
    }
    return devices;
  }

  checkPin(value) {
    const pin = String(this.config.pin);
    const given = Buffer.from(String(value ?? ''));
    const ok = given.length === Buffer.byteLength(pin) && timingSafeEqual(given, Buffer.from(pin));
    if (!ok) throw new HubError(400, 'Falscher Code');
  }

  async execute(localId, { action, value }) {
    const area = /^area(\d+)$/.exec(localId)?.[1];
    if (!area) throw new HubError(400, 'Kontakte können nicht geschaltet werden');
    if (!(action in ACTION_TO_MODE)) throw new HubError(400, `Aktion ${action} nicht unterstützt`);
    if (action === 'disarm' && this.config.pin) this.checkPin(value);
    const r = await this.raw('panelCondPost', { method: 'POST', form: { area, mode: ACTION_TO_MODE[action] } });
    if (r && (r.result === 0 || r.result === '0')) {
      throw new HubError(502, `LUPUS hat den Befehl abgelehnt${r.message ? `: ${r.message}` : ''}`);
    }
  }
}

// Zugangsdaten prüfen (für die Einrichtung im Dashboard)
export async function testLupus(config) {
  const a = new LupusAdapter('test', config);
  const devices = await a.discover();
  return { areas: a.areas.length, sensors: devices.filter((d) => d.type === 'sensor').length };
}
