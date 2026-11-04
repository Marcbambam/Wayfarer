import { writeFile, rename } from 'node:fs/promises';
import { HubError } from './device.js';
import { pairHueBridgeWithRetry } from './adapters/hue.js';

// Fügt gefundene Geräte dauerhaft zur config.json hinzu und lädt die
// Integrationen der laufenden Zentrale neu.
export class Setup {
  constructor(hub, { configPath, autoDemo = false }) {
    this.hub = hub;
    this.configPath = configPath;
    this.autoDemo = autoDemo; // Demo nur aktiv, weil noch keine config.json existierte
  }

  get config() {
    return this.hub.config;
  }

  async commit(mutate) {
    const next = structuredClone(this.config);
    next.integrations ??= [];
    if (this.autoDemo) next.integrations = next.integrations.filter((i) => i.type !== 'demo');
    mutate(next);
    await this.hub.reloadIntegrations(next); // wirft bei ungültiger Konfiguration, bevor gespeichert wird
    if (this.configPath) {
      const tmp = `${this.configPath}.tmp`;
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
      await rename(tmp, this.configPath);
    }
    this.autoDemo = false;
  }

  // Shelly-/Tasmota-Geräte: [{ name, room?, host, gen?, kind, channel?, relay?, color? }]
  async addDevices(type, devices) {
    if (!['shelly', 'tasmota'].includes(type)) throw new HubError(400, `Typ ${type} kann so nicht hinzugefügt werden`);
    if (!Array.isArray(devices) || !devices.length) throw new HubError(400, 'Keine Geräte angegeben');
    const allowed = type === 'shelly'
      ? ['name', 'room', 'host', 'gen', 'kind', 'channel']
      : ['name', 'room', 'host', 'kind', 'relay', 'color'];
    const kinds = type === 'shelly' ? ['switch', 'plug', 'light', 'cover'] : ['switch', 'plug', 'light'];
    const added = [];
    await this.commit((cfg) => {
      let integ = cfg.integrations.find((i) => i.type === type && i.enabled !== false);
      if (!integ) {
        integ = { type, id: uniqueId(type, cfg.integrations.map((i) => i.id ?? i.type)), devices: [] };
        cfg.integrations.push(integ);
      }
      integ.devices ??= [];
      for (const raw of devices) {
        if (typeof raw?.host !== 'string' || !/^[\w.-]+(:\d+)?$/.test(raw.host)) throw new HubError(400, 'Ungültige Host-Adresse');
        if (!kinds.includes(raw.kind)) throw new HubError(400, `Ungültige Geräteart: ${raw.kind}`);
        const dev = Object.fromEntries(allowed.filter((k) => raw[k] !== undefined && raw[k] !== '').map((k) => [k, raw[k]]));
        const dup = integ.devices.find((d) => d.host === dev.host && (d.channel ?? d.relay) === (dev.channel ?? dev.relay));
        if (dup) continue;
        dev.id = uniqueId(slug(dev.name || dev.host), integ.devices.map((d) => d.id));
        integ.devices.push(dev);
        added.push(`${integ.id ?? type}:${dev.id}`);
      }
    });
    return added;
  }

  // Hue: Link-Taste muss während des Aufrufs gedrückt werden (wartet bis zu ~30 s).
  async addHue(host, { attempts = 15, interval = 2000 } = {}) {
    if (typeof host !== 'string' || !/^[\w.-]+(:\d+)?$/.test(host)) throw new HubError(400, 'Ungültige Bridge-Adresse');
    let username;
    try {
      username = await pairHueBridgeWithRetry(host, { attempts, interval });
    } catch (err) {
      throw new HubError(408, err.message);
    }
    await this.commit((cfg) => {
      const existing = cfg.integrations.find((i) => i.type === 'hue' && i.bridge === host);
      if (existing) existing.username = username;
      else cfg.integrations.push({ type: 'hue', id: uniqueId('hue', cfg.integrations.map((i) => i.id ?? i.type)), bridge: host, username });
    });
  }

  async addHomeAssistant(url, token) {
    if (typeof url !== 'string' || !/^https?:\/\/[\w.-]+(:\d+)?\/?$/.test(url)) throw new HubError(400, 'Ungültige URL');
    if (typeof token !== 'string' || token.length < 20) throw new HubError(400, 'Bitte einen langlebigen Zugriffstoken angeben');
    const base = url.replace(/\/$/, '');
    let res;
    try {
      res = await fetch(`${base}/api/`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    } catch {
      throw new HubError(502, `Home Assistant unter ${base} nicht erreichbar`);
    }
    if (res.status === 401) throw new HubError(400, 'Home Assistant hat den Token abgelehnt');
    if (!res.ok) throw new HubError(502, `Home Assistant antwortet mit HTTP ${res.status}`);
    await this.commit((cfg) => {
      const existing = cfg.integrations.find((i) => i.type === 'homeassistant' && i.url?.replace(/\/$/, '') === base);
      if (existing) existing.token = token;
      else cfg.integrations.push({ type: 'homeassistant', id: uniqueId('ha', cfg.integrations.map((i) => i.id ?? i.type)), url: base, token });
    });
  }
}

export function slug(s) {
  return String(s).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'geraet';
}

function uniqueId(base, taken) {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  let i = 2;
  while (set.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
