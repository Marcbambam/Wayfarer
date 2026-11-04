import { networkInterfaces } from 'node:os';

// Durchsucht das Heimnetz nach bekannten Smart-Home-Geräten, indem jede
// Adresse im Subnetz kurz per HTTP angefragt wird. Erkannt werden:
//   • Shelly (Gen1–Gen4)      GET /shelly
//   • Tasmota                 GET /cm?cmnd=Status
//   • Philips Hue Bridge      GET /api/config   (liefert bridgeid ohne Login)
//   • Home Assistant          GET :8123/manifest.json

// ---- Subnetze ----------------------------------------------------------

const ipToInt = (ip) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const intToIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

// "192.168.1.0/24" -> Liste aller Host-Adressen. Größer als /22 wird abgelehnt.
export function cidrHosts(cidr) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(cidr).trim());
  if (!m || m[1].split('.').some((o) => Number(o) > 255)) throw new Error(`Ungültiges Subnetz: ${cidr}`);
  const prefix = Number(m[2]);
  if (prefix < 22 || prefix > 30) throw new Error('Subnetz muss zwischen /22 und /30 liegen');
  const size = 2 ** (32 - prefix);
  const net = (ipToInt(m[1]) & ~(size - 1)) >>> 0;
  const out = [];
  for (let i = 1; i < size - 1; i++) out.push(intToIp(net + i));
  return out;
}

// Eigene IPv4-Netze ermitteln. Sehr große Netze werden auf das /24 um die eigene Adresse begrenzt.
export function localSubnets(ifaces = networkInterfaces()) {
  const out = new Set();
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      const prefix = a.netmask.split('.').reduce((n, o) => n + (Number(o).toString(2).match(/1/g)?.length ?? 0), 0);
      const p = Math.min(30, Math.max(24, prefix));
      const size = 2 ** (32 - p);
      out.add(`${intToIp((ipToInt(a.address) & ~(size - 1)) >>> 0)}/${p}`);
    }
  }
  return [...out];
}

// ---- Proben ------------------------------------------------------------

async function getJson(url, timeout) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (res.status === 401) return { __auth: true };
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function probeShelly(base, ip, timeout) {
  const info = await getJson(`${base}/shelly`, timeout);
  if (!info || info.__auth || (!info.type && !info.gen && !info.app)) return null;
  const gen = info.gen ?? 1;
  const model = info.app ?? info.model ?? info.type ?? 'Shelly';
  const result = { type: 'shelly', host: ip, model, name: info.name || `Shelly ${model}`, gen, devices: [] };
  const authNeeded = gen === 1 ? info.auth : info.auth_en;
  const label = (kind, ch, count) => (count > 1 ? `${result.name} ${ch + 1}` : result.name);

  if (gen >= 2) {
    const st = await getJson(`${base}/rpc/Shelly.GetStatus`, timeout);
    if (!st || st.__auth) return { ...result, needsAuth: true };
    const keys = Object.keys(st);
    for (const [comp, kind] of [['cover', 'cover'], ['light', 'light'], ['switch', /plug/i.test(model) ? 'plug' : 'switch']]) {
      const chans = keys.filter((k) => k.startsWith(`${comp}:`)).map((k) => Number(k.split(':')[1]));
      for (const ch of chans) result.devices.push({ name: label(kind, ch, chans.length), host: ip, gen, kind, channel: ch });
      if (chans.length) break;
    }
  } else {
    const [st, settings] = await Promise.all([getJson(`${base}/status`, timeout), getJson(`${base}/settings`, timeout)]);
    if (!st || st.__auth) return { ...result, needsAuth: true };
    if (settings?.name) result.name = settings.name;
    let list;
    if (settings?.mode === 'roller' && st.rollers?.length) list = st.rollers.map((_, ch) => ['cover', ch]);
    else if (st.lights?.length) list = st.lights.map((_, ch) => ['light', ch]);
    else list = (st.relays ?? []).map((_, ch) => [/PLG/i.test(info.type) ? 'plug' : 'switch', ch]);
    for (const [kind, ch] of list) result.devices.push({ name: label(kind, ch, list.length), host: ip, gen, kind, channel: ch });
  }
  if (authNeeded && !result.devices.length) result.needsAuth = true;
  return result;
}

async function probeTasmota(base, ip, timeout) {
  const s = await getJson(`${base}/cm?cmnd=Status`, timeout);
  if (s?.__auth) return { type: 'tasmota', host: ip, name: `Tasmota ${ip}`, needsAuth: true, devices: [] };
  if (!s?.Status || s.Status.Module === undefined) return null;
  const st = (await getJson(`${base}/cm?cmnd=State`, timeout)) ?? {};
  const names = Array.isArray(s.Status.FriendlyName) ? s.Status.FriendlyName : [];
  const name = s.Status.DeviceName || names[0] || `Tasmota ${ip}`;
  const isLight = st.Dimmer !== undefined;
  const color = typeof st.Color === 'string' && st.Color.length >= 6 && !/^\d+$/.test(st.Color);
  const relays = Object.keys(st).filter((k) => /^POWER\d+$/.test(k)).map((k) => Number(k.slice(5)));
  const result = { type: 'tasmota', host: ip, name, model: `Modul ${s.Status.Module}`, devices: [] };
  if (relays.length > 1) {
    for (const r of relays) {
      result.devices.push({ name: names[r - 1] || `${name} ${r}`, host: ip, kind: 'switch', relay: r });
    }
  } else {
    result.devices.push({ name, host: ip, kind: isLight ? 'light' : 'plug', ...(color ? { color: true } : {}) });
  }
  return result;
}

async function probeHue(base, ip, timeout) {
  const c = await getJson(`${base}/api/config`, timeout);
  if (!c?.bridgeid) return null;
  return { type: 'hue', host: ip, name: c.name || 'Hue Bridge', model: c.modelid, bridgeid: c.bridgeid, needsPairing: true };
}

async function probeHomeAssistant(base, ip, timeout) {
  const m = await getJson(`${base}/manifest.json`, timeout);
  if (!m || !/home assistant/i.test(m.name ?? '')) return null;
  return { type: 'homeassistant', host: ip, url: base, name: 'Home Assistant', needsToken: true };
}

// Eine einzelne Adresse prüfen. port/haPort sind für Tests einstellbar.
export async function probeHost(ip, { port = 80, haPort = 8123, timeout = 1500 } = {}) {
  const base = port === 80 ? `http://${ip}` : `http://${ip}:${port}`;
  const found = await Promise.all([
    probeShelly(base, ip, timeout),
    probeTasmota(base, ip, timeout),
    probeHue(base, ip, timeout),
    probeHomeAssistant(`http://${ip}:${haPort}`, ip, timeout),
  ]);
  return found.filter(Boolean);
}

// Ganze Subnetze durchsuchen.
export async function scanNetwork({ subnets, concurrency = 64, onProgress, ...probeOpts } = {}) {
  const nets = subnets?.length ? subnets : localSubnets();
  const hosts = [...new Set(nets.flatMap(cidrHosts))];
  const results = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const ip = hosts[next++];
      results.push(...await probeHost(ip, probeOpts));
      onProgress?.(++done, hosts.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  const order = { homeassistant: 0, hue: 1, shelly: 2, tasmota: 3 };
  results.sort((a, b) => order[a.type] - order[b.type] || ipToInt(a.host) - ipToInt(b.host));
  return { subnets: nets, scanned: hosts.length, results };
}

// ---- Abgleich mit der Konfiguration -----------------------------------

const hostOf = (s) => {
  try { return new URL(s.includes('://') ? s : `http://${s}`).hostname; } catch { return s; }
};

export function markConfigured(config, results) {
  const integ = config.integrations ?? [];
  const known = new Set();
  for (const i of integ) {
    if (i.type === 'hue') known.add(`hue|${hostOf(i.bridge ?? '')}`);
    if (i.type === 'homeassistant') known.add(`homeassistant|${hostOf(i.url ?? '')}`);
    for (const d of i.devices ?? []) known.add(`${i.type}|${hostOf(d.host ?? '')}|${d.channel ?? d.relay ?? ''}`);
  }
  return results.map((r) => {
    if (r.type === 'hue' || r.type === 'homeassistant') return { ...r, configured: known.has(`${r.type}|${r.host}`) };
    const devices = (r.devices ?? []).map((d) => ({ ...d, configured: known.has(`${r.type}|${d.host}|${d.channel ?? d.relay ?? ''}`) }));
    return { ...r, devices, configured: devices.length > 0 && devices.every((d) => d.configured) };
  });
}
