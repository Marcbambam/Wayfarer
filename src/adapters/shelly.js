import { Adapter } from './base.js';
import { makeDevice, HubError } from '../device.js';

// Shelly-Geräte (lokale HTTP-API, Gen1 und Gen2/Plus/Pro).
// config: { devices: [
//   { id: "kaffee", name: "Kaffeemaschine", room: "Küche", host: "192.168.1.50",
//     gen: 2, kind: "switch" | "plug" | "light" | "cover", channel: 0, password?: "…" }
// ] }
export class ShellyAdapter extends Adapter {
  constructor(id, config) {
    super(id, config);
    this.list = (config.devices ?? []).map((d) => ({ gen: 1, kind: 'switch', channel: 0, ...d }));
    this.byId = new Map(this.list.map((d) => [d.id, d]));
  }

  headers(d) {
    if (!d.password) return {};
    // Gen1: Basic Auth. (Gen2 nutzt Digest – für Gen2 bitte Auth deaktivieren oder Home Assistant nutzen.)
    return { authorization: `Basic ${Buffer.from(`${d.user ?? 'admin'}:${d.password}`).toString('base64')}` };
  }

  get(d, path) {
    return this.http(`http://${d.host}${path}`, { headers: this.headers(d) });
  }

  async discover() {
    return Promise.all(this.list.map((d) => this.read(d)));
  }

  async read(d) {
    const base = {
      id: this.deviceId(d.id),
      adapter: this.id,
      name: d.name ?? d.id,
      room: d.room ?? 'Shelly',
      type: d.kind === 'switch' ? 'switch' : d.kind,
    };
    try {
      const ch = d.channel;
      if (d.kind === 'cover') {
        const pos = d.gen >= 2
          ? (await this.get(d, `/rpc/Cover.GetStatus?id=${ch}`)).current_pos
          : (await this.get(d, `/roller/${ch}`)).current_pos;
        return makeDevice({ ...base, capabilities: ['position'], state: { position: pos ?? 0 } });
      }
      if (d.kind === 'light') {
        const s = d.gen >= 2
          ? await this.get(d, `/rpc/Light.GetStatus?id=${ch}`)
          : await this.get(d, `/light/${ch}`);
        return makeDevice({
          ...base,
          capabilities: ['onoff', 'brightness'],
          state: { on: s.output ?? s.ison, brightness: s.brightness },
        });
      }
      const on = d.gen >= 2
        ? (await this.get(d, `/rpc/Switch.GetStatus?id=${ch}`)).output
        : (await this.get(d, `/relay/${ch}`)).ison;
      return makeDevice({ ...base, capabilities: ['onoff'], state: { on } });
    } catch {
      const caps = { cover: ['position'], light: ['onoff', 'brightness'] }[d.kind] ?? ['onoff'];
      return makeDevice({ ...base, online: false, capabilities: caps, state: {} });
    }
  }

  async execute(localId, { action, value }) {
    const d = this.byId.get(localId);
    const ch = d.channel;
    const g2 = d.gen >= 2;

    if (d.kind === 'cover') {
      const map = {
        open: g2 ? `/rpc/Cover.Open?id=${ch}` : `/roller/${ch}?go=open`,
        close: g2 ? `/rpc/Cover.Close?id=${ch}` : `/roller/${ch}?go=close`,
        stop: g2 ? `/rpc/Cover.Stop?id=${ch}` : `/roller/${ch}?go=stop`,
        set_position: g2 ? `/rpc/Cover.GoToPosition?id=${ch}&pos=${value}` : `/roller/${ch}?go=to_pos&roller_pos=${value}`,
      };
      if (!map[action]) throw new HubError(400, `Aktion ${action} nicht unterstützt`);
      return this.get(d, map[action]);
    }

    const comp = d.kind === 'light' ? 'Light' : 'Switch';
    const g1path = d.kind === 'light' ? 'light' : 'relay';
    switch (action) {
      case 'turn_on':
        return this.get(d, g2 ? `/rpc/${comp}.Set?id=${ch}&on=true` : `/${g1path}/${ch}?turn=on`);
      case 'turn_off':
        return this.get(d, g2 ? `/rpc/${comp}.Set?id=${ch}&on=false` : `/${g1path}/${ch}?turn=off`);
      case 'toggle':
        return this.get(d, g2 ? `/rpc/${comp}.Toggle?id=${ch}` : `/${g1path}/${ch}?turn=toggle`);
      case 'set_brightness':
        if (d.kind !== 'light') break;
        if (value === 0) return this.execute(localId, { action: 'turn_off' });
        return this.get(d, g2
          ? `/rpc/Light.Set?id=${ch}&on=true&brightness=${value}`
          : `/light/${ch}?turn=on&brightness=${value}`);
      default:
    }
    throw new HubError(400, `Aktion ${action} nicht unterstützt`);
  }
}
