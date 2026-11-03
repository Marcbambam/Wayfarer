import { Adapter } from './base.js';
import { makeDevice, hexToRgb, rgbToHex, HubError } from '../device.js';

// Geräte mit Tasmota-Firmware (Steckdosen, Lampen, LED-Strips) über HTTP.
// config: { devices: [
//   { id: "strip", name: "LED-Strip", room: "Büro", host: "192.168.1.60",
//     kind: "plug" | "switch" | "light", color?: true, relay?: 1, password?: "…" }
// ] }
export class TasmotaAdapter extends Adapter {
  constructor(id, config) {
    super(id, config);
    this.list = (config.devices ?? []).map((d) => ({ kind: 'plug', relay: 1, ...d }));
    this.byId = new Map(this.list.map((d) => [d.id, d]));
  }

  cmnd(d, command) {
    const q = new URLSearchParams({ cmnd: command });
    if (d.password) {
      q.set('user', d.user ?? 'admin');
      q.set('password', d.password);
    }
    return this.http(`http://${d.host}/cm?${q}`);
  }

  powerKey(d, s) {
    return s[`POWER${d.relay}`] !== undefined ? `POWER${d.relay}` : 'POWER';
  }

  async discover() {
    return Promise.all(this.list.map(async (d) => {
      const caps = ['onoff'];
      if (d.kind === 'light') caps.push('brightness');
      if (d.kind === 'light' && d.color) caps.push('color');
      const base = {
        id: this.deviceId(d.id), adapter: this.id, name: d.name ?? d.id,
        room: d.room ?? 'Tasmota', type: d.kind, capabilities: caps,
      };
      try {
        const s = await this.cmnd(d, 'State');
        const state = { on: s[this.powerKey(d, s)] === 'ON' };
        if (s.Dimmer !== undefined) state.brightness = s.Dimmer;
        if (typeof s.Color === 'string' && /^[0-9A-F]{6}/i.test(s.Color)) {
          state.color = `#${s.Color.slice(0, 6).toLowerCase()}`;
        }
        return makeDevice({ ...base, state });
      } catch {
        return makeDevice({ ...base, online: false, state: {} });
      }
    }));
  }

  async execute(localId, { action, value }) {
    const d = this.byId.get(localId);
    const p = d.relay > 1 ? `Power${d.relay}` : 'Power';
    switch (action) {
      case 'turn_on': return this.cmnd(d, `${p} On`);
      case 'turn_off': return this.cmnd(d, `${p} Off`);
      case 'toggle': return this.cmnd(d, `${p} Toggle`);
      case 'set_brightness': return value === 0 ? this.cmnd(d, `${p} Off`) : this.cmnd(d, `Dimmer ${value}`);
      case 'set_color': return this.cmnd(d, `Color ${rgbToHex(hexToRgb(value)).slice(1)}`);
      default: throw new HubError(400, `Aktion ${action} nicht unterstützt`);
    }
  }
}
