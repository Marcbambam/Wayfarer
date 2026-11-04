import { Adapter } from './base.js';
import { makeDevice, hexToXy, xyToHex, HubError } from '../device.js';

// Philips Hue Bridge (lokale API v1).
// config: { bridge: "192.168.1.20", username: "<API-Key>", rooms?: { "1": "Küche" } }
// API-Key erzeugen: Link-Taste der Bridge drücken, dann `npm run hue-pair -- <bridge-ip>`.
export class HueAdapter extends Adapter {
  constructor(id, config) {
    super(id, config);
    if (!config.bridge || !config.username) {
      throw new Error(`${id}: "bridge" und "username" sind für Hue erforderlich`);
    }
    this.base = `http://${config.bridge}/api/${config.username}`;
    this.rooms = config.rooms ?? {};
  }

  async discover() {
    const [lights, groups] = await Promise.all([
      this.http(`${this.base}/lights`),
      this.http(`${this.base}/groups`).catch(() => ({})),
    ]);
    if (Array.isArray(lights) && lights[0]?.error) {
      throw new HubError(502, `${this.id}: ${lights[0].error.description}`);
    }

    // Raum-Zuordnung aus den Hue-Räumen übernehmen
    const roomOf = {};
    for (const g of Object.values(groups ?? {})) {
      if (g.type === 'Room') for (const l of g.lights ?? []) roomOf[l] = g.name;
    }

    return Object.entries(lights).map(([lid, l]) => {
      const caps = ['onoff'];
      if (l.state.bri !== undefined) caps.push('brightness');
      if (l.state.xy !== undefined) caps.push('color');
      const state = { on: l.state.on };
      if (l.state.bri !== undefined) state.brightness = Math.round((l.state.bri / 254) * 100);
      if (l.state.xy) state.color = xyToHex(l.state.xy);
      const isPlug = /plug|outlet/i.test(l.type);
      return makeDevice({
        id: this.deviceId(lid),
        adapter: this.id,
        name: l.name,
        room: this.rooms[lid] ?? roomOf[lid] ?? 'Hue',
        type: isPlug ? 'plug' : 'light',
        online: l.state.reachable !== false,
        capabilities: caps,
        state,
      });
    });
  }

  async execute(lid, { action, value }) {
    let body;
    switch (action) {
      case 'turn_on': body = { on: true }; break;
      case 'turn_off': body = { on: false }; break;
      case 'toggle': {
        const l = await this.http(`${this.base}/lights/${lid}`);
        body = { on: !l.state.on };
        break;
      }
      case 'set_brightness':
        body = value === 0 ? { on: false } : { on: true, bri: Math.max(1, Math.round((value / 100) * 254)) };
        break;
      case 'set_color': body = { on: true, xy: hexToXy(value) }; break;
      default: throw new HubError(400, `Aktion ${action} nicht unterstützt`);
    }
    const res = await this.http(`${this.base}/lights/${lid}/state`, { method: 'PUT', body });
    const err = Array.isArray(res) && res.find((r) => r.error);
    if (err) throw new HubError(502, `${this.id}: ${err.error.description}`);
  }
}

// Einmalig einen API-Key von der Bridge holen (Link-Taste vorher drücken).
export async function pairHueBridge(bridge) {
  const res = await fetch(`http://${bridge}/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ devicetype: 'wayfarer#smarthome' }),
    signal: AbortSignal.timeout(5000),
  });
  const [r] = await res.json();
  if (r.error) throw new Error(r.error.description);
  return r.success.username;
}

// Wiederholt die Kopplung, bis die Link-Taste gedrückt wurde.
export async function pairHueBridgeWithRetry(bridge, { attempts = 15, interval = 2000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await pairHueBridge(bridge);
    } catch (err) {
      if (!/link button/i.test(err.message)) throw err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, interval));
    }
  }
  throw new Error('Link-Taste auf der Hue Bridge wurde nicht rechtzeitig gedrückt');
}
