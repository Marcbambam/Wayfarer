import { Adapter } from './base.js';
import { makeDevice, HubError } from '../device.js';

// Simulierte Geräte – zum Ausprobieren ohne echte Hardware.
export class DemoAdapter extends Adapter {
  constructor(id, config) {
    super(id, config);
    const d = (localId, f) => makeDevice({ id: this.deviceId(localId), adapter: id, ...f });
    this.devices = new Map(
      [
        d('wz-decke', {
          name: 'Deckenlicht', room: 'Wohnzimmer', type: 'light',
          capabilities: ['onoff', 'brightness', 'color'],
          state: { on: true, brightness: 70, color: '#ffd8a8' },
        }),
        d('wz-stehlampe', {
          name: 'Stehlampe', room: 'Wohnzimmer', type: 'light',
          capabilities: ['onoff', 'brightness'],
          state: { on: false, brightness: 40 },
        }),
        d('wz-tv', {
          name: 'Lautsprecher', room: 'Wohnzimmer', type: 'media',
          capabilities: ['onoff', 'media'],
          state: { on: true, playing: false, volume: 30 },
        }),
        d('wz-heizung', {
          name: 'Heizung', room: 'Wohnzimmer', type: 'thermostat',
          capabilities: ['onoff', 'target_temp'],
          state: { on: true, temperature: 20.5, target: 21.5 },
        }),
        d('kueche-licht', {
          name: 'Küchenlicht', room: 'Küche', type: 'light',
          capabilities: ['onoff', 'brightness'],
          state: { on: false, brightness: 100 },
        }),
        d('kueche-kaffee', {
          name: 'Kaffeemaschine', room: 'Küche', type: 'plug',
          capabilities: ['onoff'],
          state: { on: false },
        }),
        d('sz-licht', {
          name: 'Nachttischlampe', room: 'Schlafzimmer', type: 'light',
          capabilities: ['onoff', 'brightness', 'color'],
          state: { on: false, brightness: 20, color: '#ff9f43' },
        }),
        d('sz-rollo', {
          name: 'Rollladen', room: 'Schlafzimmer', type: 'cover',
          capabilities: ['position'],
          state: { position: 100 },
        }),
        d('sz-luefter', {
          name: 'Ventilator', room: 'Schlafzimmer', type: 'fan',
          capabilities: ['onoff'],
          state: { on: false },
        }),
        d('flur-tuer', {
          name: 'Haustür', room: 'Flur', type: 'lock',
          capabilities: ['lock', 'lock_open'],
          state: { locked: true },
        }),
        d('flur-alarm', {
          name: 'Alarmanlage', room: 'Flur', type: 'alarm',
          capabilities: ['alarm'],
          state: { alarm: 'disarmed', modes: ['home', 'away'], codeRequired: true, codeArmRequired: false },
        }),
        d('wz-sauger', {
          name: 'Saugroboter', room: 'Wohnzimmer', type: 'vacuum',
          capabilities: ['vacuum'],
          state: { status: 'docked', battery: 100 },
        }),
        d('wz-fernseher', {
          name: 'Fernseher', room: 'Wohnzimmer', type: 'tv',
          capabilities: ['onoff', 'media'],
          state: { on: false, playing: false, volume: 12 },
        }),
        d('flur-temp', {
          name: 'Luftfeuchtigkeit', room: 'Flur', type: 'sensor',
          capabilities: ['read'],
          state: { value: 48, unit: '%' },
        }),
      ].map((dev) => [dev.id.split(':').slice(1).join(':'), dev]),
    );
  }

  async discover() {
    // Kleine Simulation: Raumtemperatur nähert sich dem Ziel.
    const h = this.devices.get('wz-heizung');
    if (h) {
      const goal = h.state.on ? h.state.target : 17;
      h.state.temperature = +(h.state.temperature + Math.sign(goal - h.state.temperature) * Math.min(0.1, Math.abs(goal - h.state.temperature))).toFixed(1);
    }
    const v = this.devices.get('wz-sauger');
    if (v) {
      const st = v.state;
      if (st.status === 'cleaning') st.battery = Math.max(5, st.battery - 1);
      if (st.status === 'cleaning' && st.battery <= 20) st.status = 'returning';
      else if (st.status === 'returning') st.status = 'docked';
      else if (st.status === 'docked') st.battery = Math.min(100, st.battery + 2);
    }
    const s = this.devices.get('flur-temp');
    if (s) s.state.value = Math.max(35, Math.min(65, s.state.value + Math.round(Math.random() * 2 - 1)));
    return [...this.devices.values()].map((dev) => structuredClone(dev));
  }

  async execute(localId, { action, value }) {
    const dev = this.devices.get(localId);
    const s = dev.state;
    switch (action) {
      case 'turn_on': s.on = true; break;
      case 'turn_off': s.on = false; break;
      case 'toggle': s.on = !s.on; break;
      case 'set_brightness': s.brightness = value; s.on = value > 0; break;
      case 'set_color': s.color = value; s.on = true; break;
      case 'set_target_temp': s.target = value; break;
      case 'set_position': s.position = value; break;
      case 'open': s.position = 100; break;
      case 'close': s.position = 0; break;
      case 'stop': if (dev.type === 'vacuum') s.status = 'idle'; break;
      case 'lock': s.locked = true; break;
      case 'unlock': s.locked = false; break;
      case 'unlatch': s.locked = false; break;
      case 'play': s.playing = true; s.on = true; break;
      case 'pause':
        if (dev.type === 'vacuum') s.status = 'paused';
        else s.playing = false;
        break;
      case 'start': s.status = 'cleaning'; break;
      case 'return_to_base': s.status = 'returning'; break;
      case 'locate': break;
      case 'arm_away': s.alarm = 'armed_away'; break;
      case 'arm_home': s.alarm = 'armed_home'; break;
      case 'disarm':
        if (s.codeRequired && value !== (this.config.alarmCode ?? '1234')) throw new HubError(400, 'Falscher Code');
        s.alarm = 'disarmed';
        break;
      case 'set_volume': s.volume = value; break;
      default:
    }
  }
}
