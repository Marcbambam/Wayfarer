const $ = (s, el = document) => el.querySelector(s);
const state = { devices: new Map(), scenes: [], integrations: [], automations: [], room: 'Alle' };
let token = safeGet('smarthome-token');

const ICONS = {
  light: '💡', switch: '🔌', plug: '🔌', fan: '🌀', thermostat: '🌡️', cover: '🪟',
  lock: '🔒', media: '🔊', tv: '📺', vacuum: '🤖', alarm: '🛡️', sensor: '📟',
};

const VACUUM_STATUS = {
  cleaning: 'Saugt', docked: 'In der Ladestation', returning: 'Fährt zur Station', paused: 'Pausiert',
  idle: 'Bereit', error: 'Fehler – bitte prüfen',
};
const ALARM_STATUS = {
  disarmed: 'Unscharf', armed_away: 'Scharf (abwesend)', armed_home: 'Scharf (zuhause)', armed_night: 'Scharf (Nacht)',
  arming: 'Wird scharf geschaltet …', pending: 'Eingangsverzögerung …', triggered: 'ALARM!',
};
const ALARM_MODES = { away: 'Abwesend', home: 'Zuhause', night: 'Nacht' };

// ---- API ----------------------------------------------------------------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { askToken(); throw new Error('Nicht autorisiert'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Fehler ${res.status}`);
  return data;
}

async function command(id, action, value) {
  try {
    const dev = await api(`/devices/${encodeURIComponent(id)}/command`, { method: 'POST', body: { action, value } });
    if (dev) upsert(dev);
  } catch (err) {
    toast(err.message, true);
    render();
  }
}

function connect() {
  const es = new EventSource(`/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`);
  es.addEventListener('init', (e) => {
    const d = JSON.parse(e.data);
    state.devices = new Map(d.devices.map((x) => [x.id, x]));
    state.scenes = d.scenes;
    state.integrations = d.integrations;
    state.automations = d.automations;
    $('#conn').className = 'dot ok';
    render();
  });
  es.addEventListener('device', (e) => upsert(JSON.parse(e.data)));
  es.addEventListener('remove', (e) => { state.devices.delete(JSON.parse(e.data).id); render(); });
  es.addEventListener('status', (e) => {
    const d = JSON.parse(e.data);
    state.scenes = d.scenes;
    state.integrations = d.integrations;
    state.automations = d.automations;
    renderScenes();
    renderSummary();
  });
  es.onerror = async () => {
    $('#conn').className = 'dot bad';
    // Prüfen, ob es an fehlender Anmeldung liegt
    const r = await fetch('/api/status', { headers: token ? { authorization: `Bearer ${token}` } : {} }).catch(() => null);
    if (r?.status === 401) { es.close(); askToken(); }
  };
}

function upsert(dev) {
  if (dev.hidden) {
    if (state.devices.delete(dev.id)) render();
    return;
  }
  state.devices.set(dev.id, dev);
  // Während man einen Regler zieht, nicht die Karte neu bauen
  const card = document.querySelector(`[data-id="${CSS.escape(dev.id)}"]`);
  if (card && card.contains(document.activeElement) && document.activeElement.type === 'range') return;
  if (card) card.replaceWith(deviceCard(dev));
  else render();
  renderSummary();
}

// ---- Rendering ----------------------------------------------------------

function render() {
  renderRooms();
  renderScenes();
  renderSummary();
  const main = $('#devices');
  main.textContent = '';
  const devices = [...state.devices.values()].filter((d) => state.room === 'Alle' || d.room === state.room);
  if (!devices.length) {
    const scan = el('button', { type: 'button' }, 'Netzwerk durchsuchen');
    scan.onclick = () => { openSettings(); runScan(); };
    main.append(el('div', { class: 'empty' }, el('p', {}, 'Noch keine Geräte eingerichtet.'), scan));
    return;
  }
  const byRoom = groupBy(devices, (d) => d.room);
  for (const [room, list] of byRoom) {
    const sec = el('section', { class: 'room' });
    const onCount = list.filter(isOn).length;
    sec.append(el('h2', {}, room, el('span', { class: 'muted small' }, onCount ? `${onCount} an` : '')));
    const grid = el('div', { class: 'grid' });
    list.forEach((d) => grid.append(deviceCard(d)));
    sec.append(grid);
    main.append(sec);
  }
}

function renderRooms() {
  const rooms = ['Alle', ...new Set([...state.devices.values()].map((d) => d.room))];
  if (!rooms.includes(state.room)) state.room = 'Alle';
  const nav = $('#rooms');
  nav.textContent = '';
  for (const r of rooms) {
    const b = el('button', { 'aria-pressed': String(r === state.room) }, r);
    b.onclick = () => { state.room = r; safeSet('smarthome-room', r); render(); };
    nav.append(b);
  }
}

function renderScenes() {
  const box = $('#scenes');
  box.textContent = '';
  if (!state.scenes.length) {
    box.append(el('span', { class: 'muted small' }, 'Noch keine Szenen.'));
    return;
  }
  for (const s of state.scenes) {
    const b = el('button', { class: 'scene' }, el('span', { 'aria-hidden': 'true' }, s.icon ?? '✨'), s.name);
    b.onclick = async () => {
      b.classList.add('busy');
      try {
        const r = await api(`/scenes/${encodeURIComponent(s.id)}/run`, { method: 'POST' });
        const failed = r.filter((x) => !x.ok);
        toast(failed.length ? `${s.name}: ${failed.length} Gerät(e) fehlgeschlagen` : `${s.name} aktiviert`, failed.length > 0);
      } catch (err) { toast(err.message, true); }
      b.classList.remove('busy');
    };
    if (!s.builtin) {
      const del = el('span', { class: 'del', title: 'Löschen', role: 'button', 'aria-label': `${s.name} löschen` }, '×');
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Szene „${s.name}“ löschen?`)) return;
        try { await api(`/scenes/${encodeURIComponent(s.id)}`, { method: 'DELETE' }); } catch (err) { toast(err.message, true); }
      };
      b.append(del);
    }
    box.append(b);
  }
}

function renderDemoBanner() {
  $('#demo-banner').hidden = !state.integrations.some((i) => i.type === 'Demo');
}

$('#btn-demo-scan').onclick = () => { openSettings(); runScan(); };
$('#btn-demo-off').onclick = async () => {
  try {
    await api('/setup/demo', { method: 'POST', body: { enabled: false } });
    toast('Beispielgeräte ausgeblendet');
  } catch (err) { toast(err.message, true); }
};

function renderSummary() {
  renderDemoBanner();
  const all = [...state.devices.values()];
  const lights = all.filter((d) => d.type === 'light' && d.state.on).length;
  const bad = state.integrations.filter((i) => !i.ok).length;
  $('#summary').textContent = `${all.length} Geräte · ${lights} Licht${lights === 1 ? '' : 'er'} an`
    + (bad ? ` · ⚠️ ${bad} Integration${bad === 1 ? '' : 'en'} mit Fehler` : '');
}

function isOn(d) {
  if (d.type === 'cover') return d.state.position > 0;
  if (d.type === 'lock') return d.state.locked === false;
  if (d.type === 'vacuum') return ['cleaning', 'returning'].includes(d.state.status);
  if (d.type === 'alarm') return d.state.alarm !== 'disarmed';
  return d.state.on === true;
}

function describe(d) {
  const s = d.state;
  if (!d.online) return 'Nicht erreichbar';
  switch (d.type) {
    case 'light': return s.on ? (s.brightness != null ? `An · ${s.brightness} %` : 'An') : 'Aus';
    case 'thermostat': return s.on ? `Heizt auf ${fmt(s.target)} °C` : 'Aus';
    case 'cover': return s.position === 0 ? 'Geschlossen' : s.position === 100 ? 'Offen' : `${s.position} % offen`;
    case 'lock':
      if (s.lockState === 'jammed') return 'Blockiert!';
      if (s.lockState === 'open' || s.lockState === 'opening') return 'Tür geöffnet';
      return s.locked ? 'Verriegelt' : 'Entriegelt';
    case 'media': return !s.on ? 'Aus' : s.playing ? 'Spielt' : 'Pausiert';
    case 'tv': return !s.on ? 'Aus' : s.playing ? 'Läuft' : 'An';
    case 'vacuum': return `${VACUUM_STATUS[s.status] ?? s.status ?? '–'}${s.battery != null ? ` · Akku ${s.battery} %` : ''}`;
    case 'alarm': return ALARM_STATUS[s.alarm] ?? s.alarm ?? '–';
    case 'sensor': return 'Sensor';
    default: return s.on == null ? '–' : s.on ? 'An' : 'Aus';
  }
}

function deviceCard(d) {
  const s = d.state;
  const caps = new Set(d.capabilities);
  const alert = (d.type === 'alarm' && s.alarm === 'triggered') || s.lockState === 'jammed' || (d.type === 'vacuum' && s.status === 'error');
  const card = el('article', { class: `card${isOn(d) ? ' on' : ''}${alert ? ' alert' : ''}${d.online ? '' : ' offline'}`, 'data-id': d.id });
  const ico = el('div', { class: 'ico' }, d.type === 'lock' && s.locked === false ? '🔓' : ICONS[d.type] ?? '•');
  if (d.type === 'light' && s.on && s.color) ico.style.background = s.color;

  const head = el('div', { class: 'card-head' }, ico,
    el('div', { class: 'grow' }, el('div', { class: 'card-name', title: d.name }, d.name), el('div', { class: 'card-state' }, describe(d))));

  const more = el('button', { type: 'button', class: 'more', title: 'Einstellungen', 'aria-label': `${d.name}: Einstellungen` }, '⋯');
  more.onclick = () => openDeviceDialog(d);
  head.append(more);

  if (caps.has('onoff') && d.type !== 'thermostat') {
    const sw = el('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!s.on), 'aria-label': `${d.name} schalten` });
    sw.onclick = () => {
      sw.setAttribute('aria-checked', String(!s.on));
      command(d.id, s.on ? 'turn_off' : 'turn_on');
    };
    head.append(sw);
  }
  card.append(head);
  if (!d.online) return card;

  if (caps.has('brightness')) card.append(slider('Helligkeit', s.brightness ?? 0, '%', (v) => command(d.id, 'set_brightness', v)));
  if (caps.has('color')) {
    const input = el('input', { type: 'color', value: s.color ?? '#ffffff', 'aria-label': 'Farbe' });
    input.onchange = () => command(d.id, 'set_color', input.value);
    card.append(el('div', { class: 'ctl' }, el('label', {}, 'Farbe'), input));
  }
  if (caps.has('target_temp')) {
    const step = (delta) => command(d.id, 'set_target_temp', Math.round(((s.target ?? 20) + delta) * 2) / 2);
    const minus = el('button', { class: 'ghost', 'aria-label': 'Kälter' }, '−');
    const plus = el('button', { class: 'ghost', 'aria-label': 'Wärmer' }, '+');
    minus.onclick = () => step(-0.5);
    plus.onclick = () => step(0.5);
    const sw = el('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!s.on), 'aria-label': 'Heizung an/aus' });
    sw.onclick = () => command(d.id, s.on ? 'turn_off' : 'turn_on');
    card.append(el('div', { class: 'temp' },
      el('div', {}, el('div', { class: 'big' }, `${fmt(s.temperature)}°`), el('div', { class: 'muted small' }, 'Raumtemperatur')),
      el('div', { class: 'stepper' }, minus, el('strong', {}, `${fmt(s.target)}°`), plus)));
    card.append(el('div', { class: 'ctl' }, el('label', {}, 'Heizung'), sw));
  }
  if (caps.has('position')) {
    card.append(slider('Position', s.position ?? 0, '%', (v) => command(d.id, 'set_position', v)));
    const btns = el('div', { class: 'btns' });
    for (const [a, label] of [['open', 'Auf'], ['stop', 'Stopp'], ['close', 'Zu']]) {
      const b = el('button', { class: 'ghost small' }, label);
      b.onclick = () => command(d.id, a);
      btns.append(b);
    }
    card.append(btns);
  }
  if (caps.has('lock')) {
    const b = el('button', { class: s.locked ? 'ghost small' : 'small' }, s.locked ? 'Entriegeln' : 'Verriegeln');
    b.onclick = () => {
      if (s.locked && !confirm(`${d.name} wirklich entriegeln?`)) return;
      command(d.id, s.locked ? 'unlock' : 'lock');
    };
    const btns = el('div', { class: 'btns' }, b);
    if (caps.has('lock_open')) {
      const o = el('button', { class: 'ghost small' }, '🚪 Tür öffnen');
      o.onclick = () => { if (confirm(`${d.name} jetzt öffnen?`)) command(d.id, 'unlatch'); };
      btns.append(o);
    }
    card.append(btns);
  }
  if (caps.has('vacuum')) {
    const cleaning = s.status === 'cleaning';
    const main = el('button', { class: 'small' }, cleaning ? 'Pause' : '▶ Saugen');
    main.onclick = () => command(d.id, cleaning ? 'pause' : 'start');
    const home = el('button', { class: 'ghost small' }, '🏠 Zur Station');
    home.onclick = () => command(d.id, 'return_to_base');
    if (s.status === 'docked') home.disabled = true;
    card.append(el('div', { class: 'btns' }, main, home));
    if (s.battery != null) {
      card.append(el('div', { class: 'battery', role: 'meter', 'aria-valuenow': s.battery, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Akku' },
        el('span', { style: `width:${Math.max(0, Math.min(100, s.battery))}%` })));
    }
  }
  if (caps.has('alarm')) {
    const btns = el('div', { class: 'btns' });
    for (const m of s.modes ?? ['away']) {
      const active = s.alarm === `armed_${m}`;
      const b = el('button', { class: active ? 'small' : 'ghost small', 'aria-pressed': String(active) }, ALARM_MODES[m] ?? m);
      b.onclick = async () => {
        if (active) return;
        const code = s.codeArmRequired ? await askCode(`${d.name}: ${ALARM_MODES[m] ?? m}`) : undefined;
        if (code === null) return;
        command(d.id, `arm_${m}`, code);
      };
      btns.append(b);
    }
    const off = el('button', { class: s.alarm === 'disarmed' ? 'small' : 'ghost small', 'aria-pressed': String(s.alarm === 'disarmed') }, 'Unscharf');
    off.onclick = async () => {
      if (s.alarm === 'disarmed') return;
      let code;
      if (s.codeRequired) {
        code = await askCode(`${d.name} unscharf schalten`);
        if (code === null) return;
      } else if (!confirm(`${d.name} wirklich unscharf schalten?`)) return;
      command(d.id, 'disarm', code);
    };
    btns.append(off);
    card.append(btns);
  }
  if (caps.has('media') && (d.type !== 'tv' || s.on)) {
    const b = el('button', { class: 'ghost small' }, s.playing ? 'Pause' : '▶ Abspielen');
    b.onclick = () => command(d.id, s.playing ? 'pause' : 'play');
    card.append(el('div', { class: 'btns' }, b));
    card.append(slider('Lautstärke', s.volume ?? 0, '%', (v) => command(d.id, 'set_volume', v)));
  }
  if (caps.has('read')) {
    card.append(el('div', { class: 'sensor-val' }, `${typeof s.value === 'number' ? fmt(s.value) : s.value ?? '–'} ${s.unit ?? ''}`));
  }
  return card;
}

function slider(label, value, unit, onCommit) {
  const val = el('span', { class: 'val' }, `${value} ${unit}`);
  const input = el('input', { type: 'range', min: 0, max: 100, value, 'aria-label': label });
  input.oninput = () => { val.textContent = `${input.value} ${unit}`; };
  input.onchange = () => onCommit(Number(input.value));
  return el('div', { class: 'ctl' }, el('label', {}, label), input, val);
}

// ---- Dialoge ------------------------------------------------------------

$('#btn-all-off').onclick = async () => {
  try {
    const r = await api('/command', { method: 'POST', body: { type: 'light', action: 'turn_off' } });
    toast(`${r.filter((x) => x.ok).length} Lichter ausgeschaltet`);
  } catch (err) { toast(err.message, true); }
};

$('#btn-settings').onclick = () => openSettings();

function openSettings() {
  const box = $('#integrations');
  box.textContent = '';
  for (const i of state.integrations) {
    box.append(el('div', { class: 'integ' },
      el('div', {}, el('strong', {}, i.id), el('div', { class: 'muted small' }, i.type), i.error ? el('div', { class: 'err' }, i.error) : ''),
      el('div', { class: 'muted small' }, i.ok ? `✅ ${i.devices} Geräte` : '❌')));
  }
  const auto = $('#automations');
  auto.textContent = state.automations.length ? '' : 'Keine Zeitpläne eingerichtet.';
  const days = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  for (const a of state.automations) {
    auto.append(el('div', { class: 'small' }, `${a.at} · ${a.days ? a.days.map((x) => days[x]).join(', ') : 'täglich'} · ${a.name ?? a.scene ?? ''}${a.enabled === false ? ' (aus)' : ''}`));
  }
  renderHidden();
  if (!$('#dlg-settings').open) $('#dlg-settings').showModal();
}

// ---- Gerätesuche --------------------------------------------------------

const TYPE_LABEL = { homeassistant: 'Home Assistant', hue: 'Philips Hue', shelly: 'Shelly', tasmota: 'Tasmota' };

$('#btn-scan').onclick = () => runScan();

async function runScan() {
  const btn = $('#btn-scan');
  const box = $('#scan-results');
  btn.disabled = true;
  btn.textContent = 'Suche läuft …';
  box.textContent = '';
  box.append(el('p', { class: 'muted small' }, 'Das dauert etwa 10–30 Sekunden.'));
  try {
    const subnet = $('#scan-subnet').value.trim();
    const r = await api('/discover', { method: 'POST', body: subnet ? { subnet } : {} });
    box.textContent = '';
    box.append(el('p', { class: 'muted small' }, `${r.scanned} Adressen in ${r.subnets.join(', ')} durchsucht.`));
    if (!r.results.length) {
      box.append(el('p', { class: 'small' }, 'Keine bekannten Geräte gefunden. Läuft die Zentrale im selben Netz wie die Geräte? '
        + 'In Docker bitte mit „network_mode: host“ starten oder oben das Subnetz angeben.'));
    }
    for (const f of r.results) box.append(foundCard(f));
  } catch (err) {
    box.textContent = '';
    box.append(el('p', { class: 'warn small' }, err.message));
  }
  btn.disabled = false;
  btn.textContent = 'Erneut suchen';
}

function foundCard(f) {
  const card = el('div', { class: 'found' });
  card.append(el('div', { class: 'found-head' },
    el('strong', {}, f.elements.name),
    el('span', { class: 'muted small' }, `${TYPE_LABEL[f.type]} · ${f.host}${f.model ? ` · ${f.model}` : ''}`)));

  if (f.configured) {
    card.append(el('span', { class: 'ok' }, '✓ Bereits eingerichtet'));
    return card;
  }
  if (f.needsAuth) {
    card.append(el('span', { class: 'warn' }, 'Passwortgeschützt – bitte Gerät mit Passwort in config.json eintragen oder den Schutz am Gerät abschalten.'));
    return card;
  }

  const done = (msg) => { card.replaceChildren(card.firstChild, el('span', { class: 'ok' }, msg)); };

  if (f.type === 'hue') {
    card.append(el('p', { class: 'small' }, 'Drück die runde Link-Taste oben auf der Bridge und klick danach innerhalb von 30 Sekunden auf „Verbinden“.'));
    const b = el('button', { type: 'button' }, 'Verbinden');
    b.onclick = async () => {
      b.disabled = true; b.textContent = 'Warte auf Link-Taste …';
      try {
        await api('/setup/hue', { method: 'POST', body: { host: f.host } });
        done('✓ Verbunden – Lampen erscheinen gleich im Dashboard');
      } catch (err) { toast(err.message, true); b.disabled = false; b.textContent = 'Verbinden'; }
    };
    card.append(b);
    return card;
  }

  if (f.type === 'homeassistant') {
    card.append(el('p', { class: 'small' }, 'In Home Assistant: Profil → Sicherheit → „Langlebige Zugriffstoken“ → Token erstellen und hier einfügen.'));
    const input = el('input', { type: 'password', placeholder: 'Zugriffstoken', autocomplete: 'off', 'aria-label': 'Zugriffstoken' });
    const b = el('button', { type: 'button' }, 'Verbinden');
    b.onclick = async () => {
      b.disabled = true;
      try {
        await api('/setup/homeassistant', { method: 'POST', body: { url: f.url, token: input.value.trim() } });
        done('✓ Verbunden – alle Home-Assistant-Geräte erscheinen gleich im Dashboard');
      } catch (err) { toast(err.message, true); b.disabled = false; }
    };
    card.append(input, b);
    return card;
  }

  // Shelly / Tasmota: einzelne Kanäle auswählen, benennen, Raum zuweisen
  const rows = [];
  for (const d of f.devices) {
    if (d.configured) {
      card.append(el('div', { class: 'ok' }, `✓ ${d.name} ist bereits eingerichtet`));
      continue;
    }
    const cb = el('input', { type: 'checkbox', 'aria-label': 'Übernehmen' });
    cb.checked = true;
    const name = el('input', { type: 'text', value: d.name, 'aria-label': 'Name' });
    const room = el('input', { type: 'text', class: 'room-in', placeholder: 'Raum', list: 'room-list', 'aria-label': 'Raum' });
    rows.push({ d, cb, name, room });
    card.append(el('div', { class: 'found-dev' }, cb, name, room));
  }
  if (!rows.length) return card;
  const b = el('button', { type: 'button' }, 'Hinzufügen');
  b.onclick = async () => {
    const devices = rows.filter((r) => r.cb.checked).map(({ d, name, room }) => {
      const { configured, ...rest } = d;
      return { ...rest, name: name.value.trim() || d.name, room: room.value.trim() || undefined };
    });
    if (!devices.length) return toast('Nichts ausgewählt', true);
    b.disabled = true;
    try {
      const r = await api('/setup/devices', { method: 'POST', body: { type: f.type, devices } });
      done(`✓ ${r.added.length} Gerät${r.added.length === 1 ? '' : 'e'} hinzugefügt`);
    } catch (err) { toast(err.message, true); b.disabled = false; }
  };
  card.append(b);
  ensureRoomList();
  return card;
}

function ensureRoomList() {
  let list = $('#room-list');
  if (!list) { list = el('datalist', { id: 'room-list' }); document.body.append(list); }
  list.textContent = '';
  const rooms = new Set([...state.devices.values()].map((d) => d.room));
  ['Wohnzimmer', 'Küche', 'Schlafzimmer', 'Bad', 'Flur', 'Büro', 'Kinderzimmer', 'Garten'].forEach((r) => rooms.add(r));
  for (const r of rooms) list.append(el('option', { value: r }));
}

$('#btn-new-scene').onclick = () => {
  const box = $('#scene-devices');
  box.textContent = '';
  for (const d of state.devices.values()) {
    if (d.type === 'sensor' || !d.online) continue;
    const cb = el('input', { type: 'checkbox', name: 'dev', value: d.id });
    if (state.room === 'Alle' ? isOn(d) : d.room === state.room) cb.checked = true;
    box.append(el('label', {}, cb, `${ICONS[d.type] ?? ''} ${d.name}`, el('span', { class: 'muted small' }, ` · ${d.room} · ${describe(d)}`)));
  }
  $('#form-scene').reset();
  $('#dlg-scene').showModal();
};

$('#dlg-scene').addEventListener('close', async () => {
  if ($('#dlg-scene').returnValue !== 'save') return;
  const form = $('#form-scene');
  const ids = [...form.querySelectorAll('input[name=dev]:checked')].map((x) => x.value);
  if (!ids.length) return toast('Keine Geräte ausgewählt', true);
  try {
    await api('/scenes', { method: 'POST', body: { name: form.name.value.trim(), capture: ids } });
    toast('Szene gespeichert');
  } catch (err) { toast(err.message, true); }
});

function askToken() {
  const dlg = $('#dlg-token');
  if (!dlg.open) dlg.showModal();
}
$('#form-token').addEventListener('submit', () => {
  token = $('#form-token').token.value;
  safeSet('smarthome-token', token);
  connect();
});

// ---- Hilfsfunktionen ----------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const c of children) if (c !== '' && c != null) n.append(c);
  return n;
}
function groupBy(arr, fn) {
  const m = new Map();
  for (const x of arr) { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}
function fmt(n) { return n == null ? '–' : Number(n).toLocaleString('de-DE', { maximumFractionDigits: 1 }); }
let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 2800);
}
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* egal */ } }

state.room = safeGet('smarthome-room') ?? 'Alle';
connect();

// Enter in Eingabefeldern des Einstellungsdialogs soll ihn nicht schließen
$('#dlg-settings').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
  e.preventDefault();
  if (e.target.id === 'scan-subnet') runScan();
});


// ---- Geräte-Einstellungen ----------------------------------------------

function openDeviceDialog(d) {
  const f = $('#form-device');
  f.reset();
  f.dataset.deviceId = d.id;
  $('#dev-title').textContent = d.name;
  f.elements.name.value = d.name === d.defaultName ? '' : d.name;
  f.elements.name.placeholder = d.defaultName ?? d.name;
  f.elements.room.value = d.room === d.defaultRoom ? '' : d.room;
  f.elements.room.placeholder = d.defaultRoom ?? d.room;
  f.elements.hidden.checked = false;
  $('#dev-id').textContent = d.id;
  ensureRoomList();
  $('#dlg-device').showModal();
}

$('#dlg-device').addEventListener('close', async () => {
  if ($('#dlg-device').returnValue !== 'save') return;
  const f = $('#form-device');
  try {
    await api(`/devices/${encodeURIComponent(f.dataset.deviceId)}`, {
      method: 'PATCH',
      body: { name: f.elements.name.value, room: f.elements.room.value, hidden: f.elements.hidden.checked },
    });
    toast(f.elements.hidden.checked ? 'Ausgeblendet – unter ⚙︎ wieder einblendbar' : 'Gespeichert');
  } catch (err) { toast(err.message, true); }
});

async function renderHidden() {
  const box = $('#hidden-devices');
  box.textContent = '';
  let all;
  try { all = await api('/devices?all'); } catch { return; }
  const hidden = all.filter((d) => d.hidden);
  $('#hidden-head').hidden = !hidden.length;
  for (const d of hidden) {
    const b = el('button', { type: 'button', class: 'ghost small' }, 'Einblenden');
    b.onclick = async () => {
      try {
        await api(`/devices/${encodeURIComponent(d.id)}`, { method: 'PATCH', body: { hidden: false } });
        renderHidden();
      } catch (err) { toast(err.message, true); }
    };
    box.append(el('div', { class: 'integ' }, el('div', {}, d.name, el('div', { class: 'muted small' }, d.room)), b));
  }
}

// ---- Code-Eingabe (Alarmanlage) ----------------------------------------

function askCode(title) {
  return new Promise((resolve) => {
    const dlg = $('#dlg-code');
    const f = $('#form-code');
    f.reset();
    $('#code-title').textContent = title;
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? f.elements.code.value.trim() : null);
    dlg.showModal();
  });
}
