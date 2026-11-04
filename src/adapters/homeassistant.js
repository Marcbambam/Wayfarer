import { Adapter } from './base.js';
import { makeDevice, rgbToHex, hexToRgb, HubError } from '../device.js';

// Home Assistant über die REST-API.
// Damit sind praktisch alle Geräte erreichbar, die Home Assistant kennt
// (Zigbee, Z-Wave, Matter, Sonos, Tado, Nest, Fritz!DECT, …).
//
// config: { url: "http://homeassistant.local:8123", token: "<Long-Lived Token>",
//           domains?: [...], exclude?: ["entity_id", ...], rooms?: { "light.x": "Küche" },
//           sensors?: "auto" | "all" }
//
// Räume werden automatisch aus den Bereichen (Areas) in Home Assistant übernommen.
// Sensoren: standardmäßig nur Temperatur, Luftfeuchte und Tür-/Fensterkontakte, die
// einem Bereich zugeordnet sind – sonst wird das Dashboard mit Akku-, WLAN- und
// Diagnose-Sensoren überflutet. Mit sensors: "all" kommen alle.
const DOMAIN_TYPES = {
  light: 'light',
  switch: 'switch',
  input_boolean: 'switch',
  fan: 'fan',
  climate: 'thermostat',
  cover: 'cover',
  lock: 'lock',
  media_player: 'media',
  vacuum: 'vacuum',
  alarm_control_panel: 'alarm',
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
    this.sensorMode = config.sensors ?? 'auto';
    this.areas = {};
    this.areasFetched = 0;
  }

  // entity_id -> Bereichsname, über die Template-API (alle 60 s aktualisiert)
  async loadAreas() {
    if (Date.now() - this.areasFetched < 60_000) return;
    this.areasFetched = Date.now();
    const template = '{% set ns = namespace(out=[]) %}{% for s in states %}{% set a = area_name(s.entity_id) %}'
      + '{% if a %}{% set ns.out = ns.out + [[s.entity_id, a]] %}{% endif %}{% endfor %}{{ ns.out | tojson }}';
    try {
      let pairs = await this.api('/template', { method: 'POST', body: { template } });
      if (typeof pairs === 'string') pairs = JSON.parse(pairs);
      this.areas = Object.fromEntries(pairs);
    } catch {
      // Ältere Versionen oder fehlende Rechte: dann eben ohne Bereiche
    }
  }

  wantSensor(domain, ent) {
    if (this.sensorMode === 'all' || this.config.domains) return true;
    if (!this.areas[ent.entity_id]) return false;
    const dc = ent.attributes?.device_class;
    if (domain === 'sensor') return ['temperature', 'humidity'].includes(dc);
    return ['door', 'window', 'opening', 'garage_door'].includes(dc);
  }

  api(path, opts = {}) {
    return this.http(`${this.base}/api${path}`, {
      ...opts,
      headers: { authorization: `Bearer ${this.config.token}` },
    });
  }

  async discover() {
    const [states] = await Promise.all([this.api('/states'), this.loadAreas()]);
    const out = [];
    for (const ent of states) {
      const [domain] = ent.entity_id.split('.');
      if (!this.domains.has(domain) || !DOMAIN_TYPES[domain] || this.exclude.has(ent.entity_id)) continue;
      if ((domain === 'sensor' || domain === 'binary_sensor') && !this.wantSensor(domain, ent)) continue;
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
        if ((a.supported_features ?? 0) & 1) caps.push('lock_open'); // LockEntityFeature.OPEN
        state.locked = ent.state === 'locked';
        if (['jammed', 'locking', 'unlocking', 'open', 'opening'].includes(ent.state)) state.lockState = ent.state;
        break;
      case 'vacuum':
        caps.push('vacuum');
        state.status = ent.state; // cleaning, docked, returning, paused, idle, error
        if (a.battery_level != null) state.battery = a.battery_level;
        break;
      case 'alarm_control_panel': {
        caps.push('alarm');
        const f = a.supported_features ?? 0;
        state.alarm = ent.state; // disarmed, armed_home, armed_away, armed_night, arming, pending, triggered
        state.modes = [[1, 'home'], [2, 'away'], [4, 'night']].filter(([bit]) => f & bit).map(([, m]) => m);
        state.codeRequired = a.code_format != null;
        state.codeArmRequired = state.codeRequired && a.code_arm_required !== false;
        break;
      }
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
      room: this.rooms[ent.entity_id] ?? this.areas[ent.entity_id] ?? this.config.defaultRoom ?? 'Home Assistant',
      type: (domain === 'switch' && a.device_class === 'outlet' && 'plug')
        || (domain === 'media_player' && a.device_class === 'tv' && 'tv')
        || DOMAIN_TYPES[domain],
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
      case 'stop': return call(domain === 'vacuum' ? 'stop' : 'stop_cover');
      case 'lock': return call('lock');
      case 'unlock': return call('unlock');
      case 'unlatch': return call('open');
      case 'play': return call('media_play');
      case 'pause': return call(domain === 'vacuum' ? 'pause' : 'media_pause');
      case 'start': return call('start');
      case 'return_to_base': return call('return_to_base');
      case 'locate': return call('locate');
      case 'arm_away':
      case 'arm_home':
      case 'arm_night':
        return call(`alarm_${action}`, value ? { code: value } : {});
      case 'disarm': return call('alarm_disarm', value ? { code: value } : {});
      case 'set_volume': return call('volume_set', { volume_level: value / 100 });
      default: throw new HubError(400, `Aktion ${action} nicht unterstützt`);
    }
  }
}
