import { EventEmitter } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createAdapter } from './adapters/index.js';
import { validateCommand, HubError, supports, SENSITIVE_ACTIONS } from './device.js';

// Die Zentrale: hält alle Integrationen, den aktuellen Gerätezustand,
// Szenen und Zeitpläne. Meldet Änderungen per 'change'-Event.
export class Hub extends EventEmitter {
  constructor(config, { dataFile = null, log = console } = {}) {
    super();
    this.config = config;
    this.log = log;
    this.dataFile = dataFile;
    this.pollInterval = (config.pollInterval ?? 5) * 1000;
    this.devices = new Map();
    this.errors = new Map(); // adapterId -> letzte Fehlermeldung
    this.scenes = [...(config.scenes ?? [])].map((s) => ({ ...s, builtin: true }));
    this.automations = config.automations ?? [];
    this.deviceSettings = {}; // im Dashboard geänderte Namen/Räume/ausgeblendet (data/user.json)
    this.timers = [];
    this.lastAutomationMinute = null;

    this.adapters = buildAdapters(config.integrations ?? [{ type: 'demo' }]);
  }

  // Integrationen im laufenden Betrieb austauschen (z. B. nach der Gerätesuche).
  async reloadIntegrations(newConfig) {
    const adapters = buildAdapters(newConfig.integrations ?? []); // wirft bei Fehlern, alter Zustand bleibt
    const old = this.adapters;
    this.adapters = adapters;
    this.config = newConfig;
    await Promise.all([...old.values()].map((a) => a.stop()));
    for (const [id, dev] of this.devices) {
      if (!adapters.has(dev.adapter)) {
        this.devices.delete(id);
        this.emit('remove', id);
      }
    }
    for (const id of this.errors.keys()) if (!adapters.has(id)) this.errors.delete(id);
    await this.refresh();
    this.emit('status');
  }

  async start() {
    await this.loadUserData();
    await this.refresh();
    this.timers.push(setInterval(() => this.refresh().catch(() => {}), this.pollInterval));
    this.timers.push(setInterval(() => this.runAutomations(), 15_000));
  }

  async stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    await Promise.all([...this.adapters.values()].map((a) => a.stop()));
  }

  // ---- Geräte -----------------------------------------------------------

  async refresh(adapterId) {
    const targets = adapterId ? [this.adapters.get(adapterId)] : [...this.adapters.values()];
    await Promise.all(targets.map(async (adapter) => {
      try {
        const list = await adapter.discover();
        const seen = new Set();
        for (const dev of list) {
          seen.add(dev.id);
          this.applyOverrides(dev);
          const prev = this.devices.get(dev.id);
          if (!prev || JSON.stringify(prev) !== JSON.stringify(dev)) {
            this.devices.set(dev.id, dev);
            this.emit('change', dev);
          }
        }
        for (const [id, dev] of this.devices) {
          if (dev.adapter === adapter.id && !seen.has(id)) {
            this.devices.delete(id);
            this.emit('remove', id);
          }
        }
        if (this.errors.has(adapter.id)) {
          this.errors.delete(adapter.id);
          this.emit('status');
        }
      } catch (err) {
        const msg = err.message ?? String(err);
        if (this.errors.get(adapter.id) !== msg) {
          this.log.warn?.(`[${adapter.id}] ${msg}`);
          this.errors.set(adapter.id, msg);
          for (const dev of this.devices.values()) {
            if (dev.adapter === adapter.id && dev.online) {
              dev.online = false;
              this.emit('change', dev);
            }
          }
          this.emit('status');
        }
      }
    }));
  }

  // Name/Raum überschreiben – aus config.json ("devices": { "hue:3": { "name": "…", "room": "…", "hidden": true } })
  // und aus den Einstellungen, die im Dashboard gemacht wurden (haben Vorrang).
  applyOverrides(dev) {
    dev.defaultName = dev.name;
    dev.defaultRoom = dev.room;
    for (const o of [this.config.devices?.[dev.id], this.deviceSettings[dev.id]]) {
      if (!o) continue;
      if (o.name) dev.name = o.name;
      if (o.room) dev.room = o.room;
      if (o.type) dev.type = o.type;
      if (o.hidden !== undefined) dev.hidden = Boolean(o.hidden);
    }
    if (!dev.hidden) delete dev.hidden;
  }

  // Im Dashboard: umbenennen, Raum ändern, aus-/einblenden. Leere Werte = Standard.
  async setDeviceSettings(id, { name, room, hidden } = {}) {
    const dev = this.getDevice(id);
    const check = (v, what) => {
      if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > 60)) throw new HubError(400, `Ungültiger ${what}`);
      return v?.trim() || undefined;
    };
    const entry = { ...(this.deviceSettings[id] ?? {}) };
    if (name !== undefined) entry.name = check(name, 'Name');
    if (room !== undefined) entry.room = check(room, 'Raum');
    if (hidden !== undefined) entry.hidden = Boolean(hidden);
    for (const k of Object.keys(entry)) if (entry[k] === undefined || entry[k] === false) delete entry[k];
    if (Object.keys(entry).length) this.deviceSettings[id] = entry;
    else delete this.deviceSettings[id];
    await this.saveUserData();

    const updated = { ...structuredClone(dev), name: dev.defaultName, room: dev.defaultRoom };
    delete updated.hidden;
    this.applyOverrides(updated);
    this.devices.set(id, updated);
    this.emit('change', updated);
    return updated;
  }

  listDevices({ includeHidden = false } = {}) {
    return [...this.devices.values()]
      .filter((d) => includeHidden || !d.hidden)
      .sort((a, b) => a.room.localeCompare(b.room, 'de') || a.name.localeCompare(b.name, 'de'));
  }

  getDevice(id) {
    const dev = this.devices.get(id);
    if (!dev) throw new HubError(404, `Gerät ${id} nicht gefunden`);
    return dev;
  }

  async command(deviceId, command) {
    const dev = this.getDevice(deviceId);
    validateCommand(dev, command);
    const adapter = this.adapters.get(dev.adapter);
    const localId = deviceId.slice(dev.adapter.length + 1);
    await adapter.execute(localId, command);
    this.emit('command', { deviceId, command });
    // Zustand zeitnah nachladen (manche Geräte brauchen einen Moment)
    await this.refresh(dev.adapter).catch(() => {});
    setTimeout(() => this.refresh(dev.adapter).catch(() => {}), 1500);
    return this.devices.get(deviceId);
  }

  // Mehrere Geräte auf einmal, z. B. "alle Lichter im Wohnzimmer aus"
  async commandMany({ room, type, ids }, command) {
    if (SENSITIVE_ACTIONS.has(command.action)) {
      throw new HubError(400, `"${command.action}" ist aus Sicherheitsgründen nur für ein einzelnes Gerät erlaubt`);
    }
    const targets = this.listDevices({ includeHidden: true }).filter((d) =>
      (!ids || ids.includes(d.id))
      && (!room || d.room === room)
      && (!type || d.type === type)
      && supports(d, command.action));
    const results = await Promise.allSettled(targets.map((d) => this.command(d.id, command)));
    return targets.map((d, i) => ({
      id: d.id,
      ok: results[i].status === 'fulfilled',
      error: results[i].reason?.message,
    }));
  }

  // ---- Szenen -----------------------------------------------------------
  // { id, name, icon?, actions: [ { device | room+type, action, value? } ] }

  listScenes() {
    return this.scenes;
  }

  async runScene(sceneId) {
    const scene = this.scenes.find((s) => s.id === sceneId || s.name === sceneId);
    if (!scene) throw new HubError(404, `Szene ${sceneId} nicht gefunden`);
    const results = await this.runActions(scene.actions ?? []);
    this.emit('scene', { scene: scene.id, results });
    return results;
  }

  async runActions(actions) {
    const results = [];
    for (const step of actions) {
      const { device, room, type, ids, ...command } = step;
      try {
        if (device) {
          await this.command(device, command);
          results.push({ id: device, ok: true });
        } else {
          results.push(...await this.commandMany({ room, type, ids }, command));
        }
      } catch (err) {
        results.push({ id: device, ok: false, error: err.message });
      }
    }
    return results;
  }

  async saveScene(scene) {
    if (!scene?.name || !Array.isArray(scene.actions)) {
      throw new HubError(400, 'Szene braucht "name" und "actions"');
    }
    const id = scene.id ?? slug(scene.name);
    const existing = this.scenes.find((s) => s.id === id);
    if (existing?.builtin) throw new HubError(409, 'Szenen aus der config.json können nur dort geändert werden');
    const entry = { id, name: scene.name, icon: scene.icon, actions: scene.actions };
    if (existing) Object.assign(existing, entry);
    else this.scenes.push(entry);
    await this.saveUserData();
    this.emit('status');
    return entry;
  }

  // Aktuellen Zustand ausgewählter Geräte als Szene festhalten
  async captureScene(name, deviceIds) {
    const actions = [];
    for (const id of deviceIds) {
      const d = this.getDevice(id);
      const s = d.state;
      if (d.capabilities.includes('onoff') && s.on === false) {
        actions.push({ device: id, action: 'turn_off' });
        continue;
      }
      if (d.capabilities.includes('onoff')) actions.push({ device: id, action: 'turn_on' });
      if (d.capabilities.includes('brightness') && s.brightness != null) actions.push({ device: id, action: 'set_brightness', value: s.brightness });
      if (d.capabilities.includes('color') && s.color) actions.push({ device: id, action: 'set_color', value: s.color });
      if (d.capabilities.includes('target_temp') && s.target != null) actions.push({ device: id, action: 'set_target_temp', value: s.target });
      if (d.capabilities.includes('position') && s.position != null) actions.push({ device: id, action: 'set_position', value: s.position });
      // Schlösser nur verriegeln, nie automatisch entriegeln; Alarmanlage nur scharf schalten
      if (d.capabilities.includes('lock') && s.locked) actions.push({ device: id, action: 'lock' });
      if (d.capabilities.includes('alarm') && s.alarm?.startsWith('armed_') && !s.codeArmRequired) {
        actions.push({ device: id, action: s.alarm.replace('armed_', 'arm_') });
      }
    }
    return this.saveScene({ name, actions });
  }

  async deleteScene(id) {
    const idx = this.scenes.findIndex((s) => s.id === id);
    if (idx < 0) throw new HubError(404, `Szene ${id} nicht gefunden`);
    if (this.scenes[idx].builtin) throw new HubError(409, 'Szenen aus der config.json können nur dort gelöscht werden');
    this.scenes.splice(idx, 1);
    await this.saveUserData();
    this.emit('status');
  }

  // ---- Zeitpläne --------------------------------------------------------
  // { name, at: "07:00", days?: [1..7] (1 = Montag), scene: "<id>" | actions: [...] }

  runAutomations(now = new Date()) {
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const minuteKey = `${now.toDateString()} ${hhmm}`;
    if (this.lastAutomationMinute === minuteKey) return [];
    this.lastAutomationMinute = minuteKey;
    const weekday = now.getDay() === 0 ? 7 : now.getDay();
    const due = this.automations.filter((a) => a.enabled !== false && a.at === hhmm && (!a.days || a.days.includes(weekday)));
    for (const a of due) {
      this.log.info?.(`[Zeitplan] ${a.name ?? a.at}`);
      const run = a.scene ? this.runScene(a.scene) : this.runActions(a.actions ?? []);
      run.catch((err) => this.log.warn?.(`[Zeitplan] ${a.name ?? a.at}: ${err.message}`));
    }
    return due;
  }

  // ---- Status / Persistenz ---------------------------------------------

  status() {
    return {
      integrations: [...this.adapters.values()].map((a) => ({
        id: a.id,
        type: a.constructor.name.replace('Adapter', ''),
        ok: !this.errors.has(a.id),
        error: this.errors.get(a.id) ?? null,
        devices: [...this.devices.values()].filter((d) => d.adapter === a.id).length,
      })),
      automations: this.automations,
    };
  }

  async loadUserData() {
    if (!this.dataFile) return;
    try {
      const data = JSON.parse(await readFile(this.dataFile, 'utf8'));
      for (const s of data.scenes ?? []) {
        if (!this.scenes.some((x) => x.id === s.id)) this.scenes.push(s);
      }
      this.deviceSettings = data.devices ?? {};
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn?.(`Konnte ${this.dataFile} nicht lesen: ${err.message}`);
    }
  }

  async saveUserData() {
    if (!this.dataFile) return;
    await mkdir(dirname(this.dataFile), { recursive: true });
    const scenes = this.scenes.filter((s) => !s.builtin);
    await writeFile(this.dataFile, JSON.stringify({ scenes, devices: this.deviceSettings }, null, 2));
  }
}

function slug(s) {
  return s.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `szene-${Date.now()}`;
}

function buildAdapters(integrations) {
  const map = new Map();
  for (const integ of integrations) {
    if (integ.enabled === false) continue;
    const adapter = createAdapter(integ);
    if (map.has(adapter.id)) {
      throw new Error(`Integration-ID "${adapter.id}" ist doppelt – bitte eindeutige "id" vergeben`);
    }
    map.set(adapter.id, adapter);
  }
  return map;
}
