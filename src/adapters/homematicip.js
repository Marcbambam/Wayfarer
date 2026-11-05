import { createHash, randomUUID } from 'node:crypto';
import { Adapter } from './base.js';
import { makeDevice, HubError } from '../device.js';

// Homematic IP über die Cloud des Access Points (HAP / HmIP-HAP), wie die Homematic-IP-App.
// Inoffizielle Schnittstelle; Ablauf nachvollzogen anhand der Bibliothek "homematicip",
// die auch Home Assistant nutzt. Unterstützt: Heizung (Heizgruppen je Raum) und
// Türschlossantrieb (HmIP-DLD / DLP).
//
// config: { accessPoint: "3014F711A0000…" (24 Zeichen, vom Aufkleber),
//           authToken: "…" (bekommt man beim Koppeln mit der blauen Taste),
//           lockPin?: "…" (Berechtigungs-PIN fürs Türschloss, falls in der App vergeben),
//           pollSeconds?: 30 }

export const LOOKUP_URL = 'https://lookup.homematic.com:48335/getHost';
const CLIENT_SALT = 'jiLpVitHvWnIGD1yo7MA';
const LOCK_CHANNELS = ['DOOR_LOCK_CHANNEL', 'DOOR_LOCK_PRO_CHANNEL'];
const LOCK_TARGET = { lock: 'LOCKED', unlock: 'UNLOCKED', unlatch: 'OPEN' };

export function normalizeAccessPoint(id) {
  const ap = String(id ?? '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^[0-9A-F]{24}$/.test(ap)) {
    throw new HubError(400, 'Die Access-Point-ID hat 24 Zeichen (Ziffern und A–F), z. B. 3014-F711-A000-0000-0000-0000. Sie steht auf dem Aufkleber am Access Point.');
  }
  return ap;
}

export function clientAuth(ap) {
  return createHash('sha512').update(ap + CLIENT_SALT).digest('hex').toUpperCase();
}

function clientCharacteristics(ap) {
  return {
    clientCharacteristics: {
      apiVersion: '10',
      applicationIdentifier: 'wayfarer-smarthome',
      applicationVersion: '1.0',
      deviceManufacturer: 'none',
      deviceType: 'Computer',
      language: 'de_DE',
      osType: process.platform,
      osVersion: '',
    },
    id: ap,
  };
}

const ERROR_TEXT = {
  INVALID_PIN: 'Die PIN des Access Points ist falsch',
  ASSIGNMENT_LOCKED: 'Der Access Point ist gesperrt – bitte die blaue Taste drücken und erneut versuchen',
  INVALID_AUTHORIZATION_PIN: 'Die Berechtigungs-PIN fürs Türschloss ist falsch',
};

async function post(url, body, headers, timeout = 10000) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', VERSION: '12', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new HubError(502, 'Homematic-IP-Cloud nicht erreichbar – besteht eine Internetverbindung?');
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
  return { status: res.status, ok: res.ok, json };
}

function fail(r, what) {
  const code = r.json?.errorCode;
  if (r.status === 403 && !code) return new HubError(401, 'Homematic IP: Anmeldung ungültig – bitte im Dashboard neu verbinden');
  return new HubError(502, `Homematic IP: ${ERROR_TEXT[code] ?? `${what} fehlgeschlagen (${code ?? `HTTP ${r.status}`})`}`);
}

// Liefert die REST-Adresse für diesen Access Point.
export async function lookupRestUrl(ap, lookupUrl = LOOKUP_URL) {
  const r = await post(lookupUrl, clientCharacteristics(ap), {});
  if (!r.ok || !r.json?.urlREST) throw fail(r, 'Suche des Access Points');
  return r.json.urlREST.replace(/\/$/, '');
}

export class HomematicIpAdapter extends Adapter {
  constructor(id, config) {
    super(id, config);
    if (!config.accessPoint || !config.authToken) {
      throw new Error(`${id}: "accessPoint" und "authToken" sind für Homematic IP erforderlich`);
    }
    this.ap = normalizeAccessPoint(config.accessPoint);
    this.headers = { AUTHTOKEN: config.authToken, CLIENTAUTH: clientAuth(this.ap), 'ACCESSPOINT-ID': this.ap };
    this.restUrl = null;
    this.cache = null;
    this.fetchedAt = 0;
    this.minInterval = (config.pollSeconds ?? 30) * 1000; // Cloud nicht überlasten
  }

  async call(path, body) {
    this.restUrl ??= await lookupRestUrl(this.ap, this.config.lookupUrl);
    const r = await post(`${this.restUrl}/hmip/${path}`, body, this.headers);
    if (!r.ok) {
      if (r.status >= 500) this.restUrl = null; // beim nächsten Mal neu nachschlagen
      throw fail(r, 'Befehl');
    }
    return r.json;
  }

  async discover() {
    // Nach einem Befehl kurz öfter nachsehen (z. B. bis der Schlossmotor fertig ist)
    const interval = Date.now() < (this.fastUntil ?? 0) ? 4000 : this.minInterval;
    if (!this.cache || Date.now() - this.fetchedAt >= interval) {
      this.cache = await this.call('home/getCurrentState', clientCharacteristics(this.ap));
      this.fetchedAt = Date.now();
    }
    return this.toDevices(this.cache);
  }

  toDevices(st) {
    const groups = Object.values(st?.groups ?? {});
    const devices = st?.devices ?? {};
    const metas = groups.filter((g) => g.type === 'META');
    const roomOfGroup = (gid) => metas.find((m) => (m.groups ?? []).includes(gid))?.label;
    const roomOfDevice = (did) => metas.find((m) => (m.channels ?? []).some((c) => c.deviceId === did))?.label;
    const out = [];

    for (const g of groups) {
      if (g.type !== 'HEATING') continue;
      const state = {
        temperature: g.actualTemperature ?? undefined,
        target: g.setPointTemperature ?? undefined,
      };
      if (typeof g.humidity === 'number') state.humidity = g.humidity;
      if (g.windowState && g.windowState !== 'CLOSED') state.window = g.windowState === 'TILTED' ? 'gekippt' : 'offen';
      if (g.controlMode) state.mode = g.controlMode;
      out.push(makeDevice({
        id: this.deviceId(`heat-${g.id}`),
        adapter: this.id,
        name: 'Heizung',
        room: roomOfGroup(g.id) ?? g.label ?? 'Homematic IP',
        type: 'thermostat',
        online: g.unreach !== true,
        capabilities: ['target_temp'],
        state,
      }));
    }

    for (const d of Object.values(devices)) {
      const ch = Object.values(d.functionalChannels ?? {}).find((c) => LOCK_CHANNELS.includes(c.functionalChannelType));
      if (!ch) continue;
      const base = d.functionalChannels?.['0'] ?? {};
      const state = { locked: ch.lockState === 'LOCKED' };
      if (ch.lockState === 'OPEN') state.lockState = 'open';
      if (ch.motorState === 'OPENING') state.lockState = 'unlocking';
      if (ch.motorState === 'CLOSING') state.lockState = 'locking';
      out.push(makeDevice({
        id: this.deviceId(`lock-${d.id}`),
        adapter: this.id,
        name: d.label || 'Türschloss',
        room: roomOfDevice(d.id) ?? 'Homematic IP',
        type: 'lock',
        online: base.unreach !== true,
        capabilities: ['lock', 'lock_open'],
        state,
      }));
    }
    return out;
  }

  async execute(localId, { action, value }) {
    const [kind, ...rest] = localId.split('-');
    const id = rest.join('-');
    if (kind === 'heat' && action === 'set_target_temp') {
      await this.call('group/heating/setSetPointTemperature', { groupId: id, setPointTemperature: value });
    } else if (kind === 'lock' && LOCK_TARGET[action]) {
      const dev = this.cache?.devices?.[id];
      const ch = Object.values(dev?.functionalChannels ?? {}).find((c) => LOCK_CHANNELS.includes(c.functionalChannelType));
      await this.call('device/control/setLockState', {
        deviceId: id,
        channelIndex: ch?.index ?? 1,
        authorizationPin: this.config.lockPin ?? '',
        targetLockState: LOCK_TARGET[action],
      });
    } else {
      throw new HubError(400, `Aktion ${action} nicht unterstützt`);
    }
    this.fetchedAt = 0; // nach einem Befehl sofort frischen Zustand holen
    this.fastUntil = Date.now() + 20000;
  }
}

// Koppeln: Anfrage stellen, dann auf die blaue Taste am Access Point warten.
// Liefert { accessPoint, authToken }.
export async function pairHomematicIp(accessPoint, {
  pin, lookupUrl = LOOKUP_URL, waitMs = 120000, intervalMs = 2000, deviceName = 'Wayfarer Smart Home',
} = {}) {
  const ap = normalizeAccessPoint(accessPoint);
  const rest = await lookupRestUrl(ap, lookupUrl);
  const headers = { CLIENTAUTH: clientAuth(ap), 'ACCESSPOINT-ID': ap, ...(pin ? { PIN: String(pin) } : {}) };
  const deviceId = randomUUID();

  let r = await post(`${rest}/hmip/auth/connectionRequest`, { deviceId, deviceName, sgtin: ap }, headers);
  if (!r.ok) throw fail(r, 'Verbindungsanfrage');

  const until = Date.now() + waitMs;
  for (;;) {
    r = await post(`${rest}/hmip/auth/isRequestAcknowledged`, { deviceId, accessPointId: ap }, headers);
    if (r.status === 200) break;
    if (Date.now() + intervalMs > until) {
      throw new HubError(408, 'Die blaue Taste am Access Point wurde nicht rechtzeitig gedrückt');
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }

  r = await post(`${rest}/hmip/auth/requestAuthToken`, { deviceId }, headers);
  if (!r.ok || !r.json?.authToken) throw fail(r, 'Anmeldung');
  const { authToken } = r.json;
  r = await post(`${rest}/hmip/auth/confirmAuthToken`, { deviceId, authToken }, headers);
  if (!r.ok || !r.json?.clientId) throw fail(r, 'Bestätigung der Anmeldung');
  return { accessPoint: ap, authToken };
}
