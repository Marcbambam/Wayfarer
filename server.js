#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { Hub } from './src/hub.js';
import { HubError } from './src/device.js';
import { pairHueBridgeWithRetry } from './src/adapters/hue.js';
import { scanNetwork, markConfigured } from './src/discovery.js';
import { Setup } from './src/setup.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

export async function loadConfig(path) {
  if (!existsSync(path)) {
    console.log(`Keine ${path} gefunden – starte im Demo-Modus. (Vorlage: config.example.json)`);
    return { integrations: [{ type: 'demo' }] };
  }
  return JSON.parse(await readFile(path, 'utf8'));
}

export function createApp(hub, { token = null, setup = new Setup(hub, {}), scanOptions = {} } = {}) {
  let scanning = null;
  const clients = new Set();
  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  hub.on('change', (d) => broadcast('device', d));
  hub.on('remove', (id) => broadcast('remove', { id }));
  hub.on('status', () => broadcast('status', { ...hub.status(), scenes: hub.listScenes() }));

  const authorized = (req, url) => {
    if (!token) return true;
    const given = (req.headers.authorization ?? '').replace(/^Bearer /, '') || url.searchParams.get('token') || '';
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new HubError(413, 'Anfrage zu groß'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new HubError(400, 'Ungültiges JSON')); }
    });
    req.on('error', reject);
  });

  const json = (res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // ohne "api"
    const m = req.method;
    const [res0, id, sub] = parts;

    if (m === 'GET' && res0 === 'events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(`event: init\ndata: ${JSON.stringify({ devices: hub.listDevices(), scenes: hub.listScenes(), ...hub.status() })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); });
      return;
    }

    if (res0 === 'devices') {
      if (m === 'GET' && !id) return json(res, 200, hub.listDevices({ includeHidden: url.searchParams.has('all') }));
      if (m === 'GET' && id && !sub) return json(res, 200, hub.getDevice(id));
      if (m === 'POST' && id && sub === 'command') return json(res, 200, await hub.command(id, await readBody(req)));
    }

    // Gruppenbefehl: POST /api/command { room?, type?, ids?, action, value? }
    if (m === 'POST' && res0 === 'command') {
      const { room, type, ids, ...command } = await readBody(req);
      return json(res, 200, await hub.commandMany({ room, type, ids }, command));
    }

    if (res0 === 'scenes') {
      if (m === 'GET' && !id) return json(res, 200, hub.listScenes());
      if (m === 'POST' && !id) {
        const body = await readBody(req);
        const scene = body.capture
          ? await hub.captureScene(body.name, body.capture)
          : await hub.saveScene(body);
        return json(res, 201, scene);
      }
      if (m === 'POST' && id && sub === 'run') return json(res, 200, await hub.runScene(id));
      if (m === 'DELETE' && id) { await hub.deleteScene(id); return json(res, 200, { ok: true }); }
    }

    // Gerätesuche im Heimnetz: POST /api/discover { subnet?: "192.168.1.0/24" }
    if (m === 'POST' && res0 === 'discover') {
      const { subnet } = await readBody(req);
      // Laufende Suche wiederverwenden, statt das Netz doppelt abzuklappern
      scanning ??= scanNetwork({ ...scanOptions, subnets: subnet ? [subnet] : scanOptions.subnets })
        .finally(() => { scanning = null; });
      let result;
      try {
        result = await scanning;
      } catch (err) {
        throw new HubError(400, err.message);
      }
      return json(res, 200, { ...result, results: markConfigured(hub.config, result.results) });
    }

    // Gefundene Geräte übernehmen
    if (m === 'POST' && res0 === 'setup') {
      const body = await readBody(req);
      if (id === 'devices') return json(res, 201, { added: await setup.addDevices(body.type, body.devices) });
      if (id === 'demo') { await setup.setDemo(Boolean(body.enabled)); return json(res, 200, { ok: true }); }
      if (id === 'hue') { await setup.addHue(body.host); return json(res, 201, { ok: true }); }
      if (id === 'homeassistant') { await setup.addHomeAssistant(body.url, body.token); return json(res, 201, { ok: true }); }
    }

    if (m === 'GET' && res0 === 'status') return json(res, 200, hub.status());
    if (m === 'POST' && res0 === 'refresh') { await hub.refresh(); return json(res, 200, { ok: true }); }

    throw new HubError(404, 'Unbekannter API-Endpunkt');
  }

  async function serveStatic(res, pathname) {
    const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) throw new HubError(403, 'Verboten');
    try {
      if (!(await stat(file)).isFile()) throw new Error();
    } catch {
      throw new HubError(404, 'Nicht gefunden');
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        if (!authorized(req, url)) throw new HubError(401, 'Nicht autorisiert');
        return await api(req, res, url);
      }
      return await serveStatic(res, url.pathname);
    } catch (err) {
      const status = err.status ?? 500;
      if (status >= 500) console.error(err);
      if (!res.headersSent) json(res, status, { error: err.message });
      else res.end();
    }
  });
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'hue-pair') {
    if (!arg) return console.error('Aufruf: npm run hue-pair -- <bridge-ip>');
    console.log('Bitte jetzt die Link-Taste auf der Hue Bridge drücken …');
    const key = await pairHueBridgeWithRetry(arg, { attempts: 30 });
    console.log(`\nAPI-Key: ${key}\nIn config.json eintragen:\n{ "type": "hue", "bridge": "${arg}", "username": "${key}" }`);
    return;
  }

  if (cmd === 'scan') {
    const { subnets, scanned, results } = await scanNetwork({
      subnets: arg ? [arg] : undefined,
      onProgress: (done, total) => process.stdout.write(`\rDurchsuche ${done}/${total} …`),
    });
    console.log(`\r${scanned} Adressen in ${subnets.join(', ')} durchsucht – ${results.length} Gerät(e) gefunden:\n`);
    for (const r of results) {
      console.log(`  ${r.host.padEnd(16)} ${r.type.padEnd(14)} ${r.name}${r.model ? ` (${r.model})` : ''}`);
      for (const d of r.devices ?? []) console.log(`  ${''.padEnd(31)}└ ${d.name} [${d.kind}]`);
      if (r.needsAuth) console.log(`  ${''.padEnd(31)}⚠ passwortgeschützt`);
    }
    console.log('\nÜbernehmen kannst du die Geräte im Dashboard unter ⚙︎ → „Netzwerk durchsuchen“.');
    return;
  }

  const configPath = process.env.CONFIG ?? join(ROOT, 'config.json');
  const autoDemo = !existsSync(configPath);
  const config = await loadConfig(configPath);
  const hub = new Hub(config, { dataFile: join(ROOT, 'data', 'user.json') });
  const setup = new Setup(hub, { configPath, autoDemo });
  await hub.start();

  const token = process.env.SMARTHOME_TOKEN ?? config.token ?? null;
  const port = Number(process.env.PORT ?? config.port ?? 8080);
  const host = process.env.HOST ?? config.host ?? '0.0.0.0';
  createApp(hub, { token, setup, scanOptions: { subnets: config.scanSubnets } }).listen(port, host, () => {
    console.log(`Smart Home läuft auf http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    for (const i of hub.status().integrations) {
      console.log(`  • ${i.id} (${i.type}): ${i.ok ? `${i.devices} Geräte` : `FEHLER – ${i.error}`}`);
    }
    if (!token) console.log('  Hinweis: Kein Zugriffsschutz gesetzt (SMARTHOME_TOKEN oder "token" in config.json).');
  });

  const shutdown = async () => { await hub.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
