// Gemeinsames Gerätemodell, das alle Adapter liefern.
//
// Device = {
//   id:           eindeutige ID, "<adapterId>:<lokaleId>"
//   name:         Anzeigename
//   room:         Raum (für Gruppierung im Dashboard)
//   type:         light | switch | plug | fan | thermostat | cover | lock | media | sensor
//   adapter:      ID der Integration
//   online:       boolean
//   capabilities: Teilmenge von CAPABILITIES
//   state:        { on, brightness (0-100), color ("#rrggbb"), temperature,
//                   target, position (0-100), locked, value, unit, playing, volume,
//                   status + battery (Sauger), alarm + modes + codeRequired (Alarmanlage) }
// }

export const DEVICE_TYPES = [
  'light', 'switch', 'plug', 'fan', 'thermostat', 'cover', 'lock', 'media', 'tv',
  'vacuum', 'alarm', 'sensor',
];

export const CAPABILITIES = [
  'onoff', 'brightness', 'color', 'target_temp', 'position', 'lock', 'lock_open',
  'media', 'vacuum', 'alarm', 'read',
];

// Welche Befehle welche Fähigkeit voraussetzen (eine der genannten reicht).
export const COMMANDS = {
  turn_on: ['onoff'],
  turn_off: ['onoff'],
  toggle: ['onoff'],
  set_brightness: ['brightness'],
  set_color: ['color'],
  set_target_temp: ['target_temp'],
  set_position: ['position'],
  open: ['position'],
  close: ['position'],
  stop: ['position', 'vacuum'],
  lock: ['lock'],
  unlock: ['lock'],
  unlatch: ['lock_open'], // Tür öffnen (Falle ziehen)
  play: ['media'],
  pause: ['media', 'vacuum'],
  set_volume: ['media'],
  start: ['vacuum'],
  return_to_base: ['vacuum'],
  locate: ['vacuum'],
  arm_away: ['alarm'],
  arm_home: ['alarm'],
  arm_night: ['alarm'],
  disarm: ['alarm'],
};

// Sicherheitskritisch: nie als Gruppenbefehl (z. B. "alles im Flur"), nur für ein
// ausdrücklich genanntes Gerät.
export const SENSITIVE_ACTIONS = new Set(['unlock', 'unlatch', 'disarm']);

export function supports(device, action) {
  return (COMMANDS[action] ?? []).some((cap) => device.capabilities.includes(cap));
}

export function makeDevice(fields) {
  return {
    online: true,
    capabilities: [],
    state: {},
    room: 'Allgemein',
    ...fields,
  };
}

export function validateCommand(device, command) {
  if (!command || typeof command.action !== 'string') {
    throw new HubError(400, 'Befehl braucht ein "action"-Feld');
  }
  if (!COMMANDS[command.action]) throw new HubError(400, `Unbekannte Aktion: ${command.action}`);
  if (!supports(device, command.action)) {
    throw new HubError(400, `${device.name} unterstützt "${command.action}" nicht`);
  }
  if (command.action.startsWith('arm_') && device.state?.modes && !device.state.modes.includes(command.action.slice(4))) {
    throw new HubError(400, `${device.name} kennt den Modus "${command.action.slice(4)}" nicht`);
  }
  const v = command.value;
  switch (command.action) {
    case 'set_brightness':
    case 'set_position':
    case 'set_volume':
      if (typeof v !== 'number' || v < 0 || v > 100) {
        throw new HubError(400, 'Wert muss eine Zahl zwischen 0 und 100 sein');
      }
      break;
    case 'set_target_temp':
      if (typeof v !== 'number' || v < 5 || v > 35) {
        throw new HubError(400, 'Zieltemperatur muss zwischen 5 und 35 °C liegen');
      }
      break;
    case 'set_color':
      if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) {
        throw new HubError(400, 'Farbe muss im Format #rrggbb angegeben werden');
      }
      break;
    case 'arm_away':
    case 'arm_home':
    case 'arm_night':
    case 'disarm':
      if (v !== undefined && (typeof v !== 'string' || !/^[\w-]{1,32}$/.test(v))) {
        throw new HubError(400, 'Ungültiger Code');
      }
      break;
    default:
  }
}

export class HubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- Farb-Hilfsfunktionen ------------------------------------------------

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('');
}

// sRGB -> CIE xy (für Philips Hue)
export function hexToXy(hex) {
  const lin = (c) => {
    c /= 255;
    return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92;
  };
  const [r, g, b] = hexToRgb(hex).map(lin);
  const X = r * 0.4124 + g * 0.3576 + b * 0.1805;
  const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const Z = r * 0.0193 + g * 0.1192 + b * 0.9505;
  const sum = X + Y + Z;
  if (sum === 0) return [0.3127, 0.329]; // Weißpunkt D65
  return [+(X / sum).toFixed(4), +(Y / sum).toFixed(4)];
}

// CIE xy -> sRGB (volle Helligkeit)
export function xyToHex([x, y]) {
  if (!y) return '#ffffff';
  const Y = 1;
  const X = (Y / y) * x;
  const Z = (Y / y) * (1 - x - y);
  let r = X * 3.2406 - Y * 1.5372 - Z * 0.4986;
  let g = -X * 0.9689 + Y * 1.8758 + Z * 0.0415;
  let b = X * 0.0557 - Y * 0.204 + Z * 1.057;
  const gamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  [r, g, b] = [r, g, b].map((c) => Math.max(0, gamma(c)));
  const max = Math.max(r, g, b, 1e-6);
  return rgbToHex([r, g, b].map((c) => (c / max) * 255));
}
