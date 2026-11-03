import { Adapter } from './base.js';
import { makeDevice, HubError } from '../device.js';

// Generischer HTTP-Adapter für alles andere (eigene Bastelprojekte, ESPHome,
// IFTTT-Webhooks, Node-RED, …). Jede Aktion ist einfach eine URL.
// config: { devices: [
//   { id: "garage", name: "Garagentor", room: "Garage", type: "switch",
//     actions: { turn_on: "http://…/open", turn_off: { url: "http://…/close", method: "POST", body: {…} } },
//     status?: { url: "http://…/state", onPath: "state", onValue: "ON" } }
// ] }
export class WebhookAdapter extends Adapter {
  constructor(id, config) {
    super(id, config);
    this.list = config.devices ?? [];
    this.byId = new Map(this.list.map((d) => [d.id, d]));
    this.assumed = new Map(); // Zustand für Geräte ohne Status-URL merken
  }

  async discover() {
    return Promise.all(this.list.map(async (d) => {
      const actions = Object.keys(d.actions ?? {});
      const caps = [];
      if (actions.some((a) => ['turn_on', 'turn_off', 'toggle'].includes(a))) caps.push('onoff');
      if (actions.some((a) => ['open', 'close', 'set_position'].includes(a))) caps.push('position');
      if (actions.some((a) => ['lock', 'unlock'].includes(a))) caps.push('lock');
      const state = { ...(this.assumed.get(d.id) ?? {}) };
      let online = true;
      if (d.status?.url) {
        try {
          const res = await this.http(d.status.url);
          const v = (d.status.onPath ?? '').split('.').filter(Boolean).reduce((o, k) => o?.[k], res);
          state.on = d.status.onValue !== undefined ? v === d.status.onValue : Boolean(v);
        } catch {
          online = false;
        }
      }
      return makeDevice({
        id: this.deviceId(d.id), adapter: this.id, name: d.name ?? d.id,
        room: d.room ?? 'Allgemein', type: d.type ?? 'switch', online, capabilities: caps, state,
      });
    }));
  }

  async execute(localId, { action, value }) {
    const d = this.byId.get(localId);
    let spec = d.actions?.[action];
    if (!spec && action === 'toggle') {
      const on = this.assumed.get(localId)?.on;
      return this.execute(localId, { action: on ? 'turn_off' : 'turn_on' });
    }
    if (!spec) throw new HubError(400, `Aktion ${action} für ${d.name ?? d.id} nicht konfiguriert`);
    if (typeof spec === 'string') spec = { url: spec };
    const url = spec.url.replace('{value}', encodeURIComponent(value ?? ''));
    await this.http(url, { method: spec.method ?? 'GET', body: spec.body, headers: spec.headers });

    const s = { ...(this.assumed.get(localId) ?? {}) };
    if (action === 'turn_on') s.on = true;
    if (action === 'turn_off') s.on = false;
    if (action === 'lock') s.locked = true;
    if (action === 'unlock') s.locked = false;
    if (action === 'open') s.position = 100;
    if (action === 'close') s.position = 0;
    this.assumed.set(localId, s);
  }
}
