import { Adapter } from './base.js';
import { makeDevice, rgbToHex, hexToRgb, HubError } from '../device.js';

// Home Assistant über die REST-API.
// Damit sind praktisch alle Geräte erreichbar, die Home Assistant kennt
// (Zigbee, Z-Wave, Matter, Sonos, Tado, Nest, Fritz!DECT, …).
//
// config: { url: "http://homeassistant.local:8123", token: "<Long-Lived Token>",
//           domains?: [...], exclude?: ["entity_id", ...], rooms?: { "light.x": "Küche" } }
const DOMAIN_TYPES = {
  light: 'light',
  switch: 'switch',
  input_boolean: 'switch',
  fan: 'fan',
  climate: 'thermostat',
  cover: 'cover',
  lock: 'lock',
  media_player: 'media',
  sensor: 'sensor',
  binary_sensor: 'sensor',
};

export class HomeAssistantAdapter extends Adapter {
  constructor(id, config) {
    super(id, config);
    if (!config.url || !config.token) {
      throw new Error(`${id}: "url" und "token" sind für Home Assistant erforderlich`);
    }
    this.base = config.url.replace(/\/$/, '');
    this.domains = new Set(config.domains ?? Object.keys(DOMAIN_TYPES));
    this.exclude = new Set(config.exclude ?? []);
    this.rooms = config.rooms ?? {};
  }

  api(path, opts = {}) {
    return this.http(`${this.base}/api${path}`, {
      ...opts,
      headers: { authorization: `Bearer ${this.config.token}` },
    });
  }

  async discover() {
    const states = await this.api('/states');
    const out = [];
    for (const ent of states) {
      const [domain] = ent.entity_id.split('.');
      if (!this.domains.has(domain) || !DOMAIN_TYPES[domain] || this.exclude.has(ent.entity_id)) continue;
      out.push(this.toDevice(domain, ent));
    }
    return out;
  }

  toDevice(domain, ent) {
    const a = ent.attributes ?? {};
    const caps = [];
    const state = {};
    const on = ent.state === 'on';

    switch (domain) {
      case 'light': {
        caps.push('onoff');
        state.on = on;
        const modes = a.supported_color_modes ?? [];
        if (modes.some((m) => m !== 'onoff')) caps.push('brightness');
        if (modes.some((m) => ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'].includes(m))) caps.push('color');
        if (a.brightness != null) state.brightness = Math.round((a.brightness / 255) * 100);
        if (Array.isArray(a.rgb_color)) state.color = rgbToHex(a.rgb_color);
        break;
      }
      case 'switch':
      case 'input_boolean':
      case 'fan':
        caps.push('onoff');
        state.on = on;
        break;
      case 'climate':
        caps.push('onoff', 'target_temp');
        state.on = ent.state !== 'off';
        state.temperature = a.current_temperature;
        state.target = a.temperature;
        break;
      case 'cover':
        caps.push('position');
        state.position = a.current_position ?? (ent.state === 'open' ? 100 : 0);
        break;
      case 'lock':
        caps.push('lock');
        state.locked = ent.state === 'locked';
        break;
      case 'media_player':
        caps.push('onoff', 'media');
        state.on = ent.state !== 'off' && ent.state !== 'standby';
        state.playing = ent.state === 'playing';
        if (a.volume_level != null) state.volume = Math.round(a.volume_level * 100);
        break;
      case 'sensor':
        caps.push('read');
        state.value = Number.isNaN(Number(ent.state)) ? ent.state : Number(ent.state);
        state.unit = a.unit_of_measurement ?? '';
        break;
      case 'binary_sensor':
        caps.push('read');
        state.value = on ? 'an' : 'aus';
        state.unit = '';
        break;
      default:
    }

    return makeDevice({
      id: this.deviceId(ent.entity_id),
      adapter: this.id,
      name: a.friendly_name ?? ent.entity_id,
      room: this.rooms[ent.entity_id] ?? this.config.defaultRoom ?? 'Home Assistant',
      type: domain === 'switch' && a.device_class === 'outlet' ? 'plug' : DOMAIN_TYPES[domain],
      online: ent.state !== 'unavailable',
      capabilities: caps,
      state,
    });
  }

  async execute(entityId, { action, value }) {
    const [domain] = entityId.split('.');
    const call = (svc, data = {}, dom = domain) =>
      this.api(`/services/${dom}/${svc}`, { method: 'POST', body: { entity_id: entityId, ...data } });

    switch (action) {
      case 'turn_on': return call('turn_on');
      case 'turn_off': return call('turn_off');
      case 'toggle': return call('toggle');
      case 'set_brightness':
        return value === 0 ? call('turn_off') : call('turn_on', { brightness_pct: value });
      case 'set_color': return call('turn_on', { rgb_color: hexToRgb(value) });
      case 'set_target_temp': return call('set_temperature', { temperature: value });
      case 'set_position': return call('set_cover_position', { position: value });
      case 'open': return call('open_cover');
      case 'close': return call('close_cover');
      case 'stop': return call('stop_cover');
      case 'lock': return call('lock');
      case 'unlock': return call('unlock');
      case 'play': return call('media_play');
      case 'pause': return call('media_pause');
      case 'set_volume': return call('volume_set', { volume_level: value / 100 });
      default: throw new HubError(400, `Aktion ${action} nicht unterstützt`);
    }
  }
}
