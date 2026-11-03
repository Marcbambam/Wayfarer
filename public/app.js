const $ = (s, el = document) => el.querySelector(s);
const state = { devices: new Map(), scenes: [], integrations: [], automations: [], room: 'Alle' };
let token = safeGet('smarthome-token');

const ICONS = {
  light: '💡', switch: '🔌', plug: '🔌', fan: '🌀', thermostat: '🌡️', cover: '🪟',
  lock: '🔒', media: '🔊', sensor: '📟',
};

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
  if (dev.hidden) return;
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
    main.innerHTML = '<div class="empty">Keine Geräte gefunden. Richte Integrationen in <code>config.json</code> ein.</div>';
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

function renderSummary() {
  const all = [...state.devices.values()];
  const lights = all.filter((d) => d.type === 'light' && d.state.on).length;
  const bad = state.integrations.filter((i) => !i.ok).length;
  $('#summary').textContent = `${all.length} Geräte · ${lights} Licht${lights === 1 ? '' : 'er'} an`
    + (bad ? ` · ⚠️ ${bad} Integration${bad === 1 ? '' : 'en'} mit Fehler` : '');
}

function isOn(d) {
  if (d.type === 'cover') return d.state.position > 0;
  if (d.type === 'lock') return d.state.locked === false;
  return d.state.on === true;
}

function describe(d) {
  const s = d.state;
  if (!d.online) return 'Nicht erreichbar';
  switch (d.type) {
    case 'light': return s.on ? (s.brightness != null ? `An · ${s.brightness} %` : 'An') : 'Aus';
    case 'thermostat': return s.on ? `Heizt auf ${fmt(s.target)} °C` : 'Aus';
    case 'cover': return s.position === 0 ? 'Geschlossen' : s.position === 100 ? 'Offen' : `${s.position} % offen`;
    case 'lock': return s.locked ? 'Verriegelt' : 'Entriegelt';
    case 'media': return !s.on ? 'Aus' : s.playing ? 'Spielt' : 'Pausiert';
    case 'sensor': return 'Sensor';
    default: return s.on == null ? '–' : s.on ? 'An' : 'Aus';
  }
}

function deviceCard(d) {
  const s = d.state;
  const caps = new Set(d.capabilities);
  const card = el('article', { class: `card${isOn(d) ? ' on' : ''}${d.online ? '' : ' offline'}`, 'data-id': d.id });
  const ico = el('div', { class: 'ico' }, d.type === 'lock' && s.locked === false ? '🔓' : ICONS[d.type] ?? '•');
  if (d.type === 'light' && s.on && s.color) ico.style.background = s.color;

  const head = el('div', { class: 'card-head' }, ico,
    el('div', { class: 'grow' }, el('div', { class: 'card-name', title: d.name }, d.name), el('div', { class: 'card-state' }, describe(d))));

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
    const b = el('button', { class: s.locked ? 'ghost' : '' }, s.locked ? 'Entriegeln' : 'Verriegeln');
    b.onclick = () => {
      if (s.locked && !confirm(`${d.name} wirklich entriegeln?`)) return;
      command(d.id, s.locked ? 'unlock' : 'lock');
    };
    card.append(b);
  }
  if (caps.has('media')) {
    const b = el('button', { class: 'ghost small' }, s.playing ? '⏸ Pause' : '▶ Abspielen');
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

$('#btn-settings').onclick = () => {
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
  $('#dlg-settings').showModal();
};

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
