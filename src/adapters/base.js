import { HubError } from '../device.js';

// Basisklasse für alle Integrationen.
// Ein Adapter muss implementieren:
//   async discover()            -> Device[]   (aktueller Zustand aller Geräte)
//   async execute(localId, cmd) -> void       (Befehl an ein Gerät senden)
export class Adapter {
  constructor(id, config = {}) {
    this.id = id;
    this.config = config;
  }

  // eslint-disable-next-line class-methods-use-this
  async discover() {
    return [];
  }

  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async execute(localId, command) {
    throw new HubError(501, 'Nicht implementiert');
  }

  async stop() {}

  deviceId(localId) {
    return `${this.id}:${localId}`;
  }

  async http(url, { method = 'GET', body, headers = {}, timeout = 5000 } = {}) {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.config.timeout ?? timeout),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new HubError(502, `${this.id}: HTTP ${res.status} von ${new URL(url).host}: ${text.slice(0, 200)}`);
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  }
}
