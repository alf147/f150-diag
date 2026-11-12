'use strict';
/* User interface. Depends on core.js (protocol) and sim.js (demo truck). */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
}

const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};

const S = {
  link: null, elm: null, uds: null, info: null,
  modules: [], vin: null, dtcRead: false,
  blocks: new Map(),          // "addr:did" -> latest bytes read from the truck
  pending: new Map(),         // setting id -> 'on' | 'off', chosen but not yet written
  userSettings: store.get('f150diag.settings', []),
  featuresLoaded: false,
  cfg: null,                  // Advanced editor: { addr, blocks: [{ did, orig, input, note }] }
  backedUp: new Set(),        // module addresses backed up this session
  live: { running: false, done: null, supported: null, picked: new Set([0x0C, 0x0D, 0x05, 0x04, 0x42]), stats: new Map() },
  log: [],
  busy: false,
  tab: 'home',
};

const key = (addr, did) => addr + ':' + did;
const findModule = addr => S.modules.find(m => m.addr === addr);
const label = m => `${m.short !== '—' ? m.short : 'Module'} (${hex(m.addr, 3)})`;
const isDemo = () => S.link instanceof SimLink;

/* ---- Shell: toasts, busy state, tabs, dialog ---- */

function toast(text, kind = 'info') {
  const t = el('div', { class: 'toast ' + kind, role: kind === 'error' ? 'alert' : 'status' },
    el('span', {}, text), el('button', { 'aria-label': 'Dismiss', onclick: () => t.remove() }, '×'));
  $('#toasts').append(t);
  if (kind !== 'error') setTimeout(() => t.remove(), 6000);
}

function setBusy(text) {
  $('#busy-text').textContent = text || '';
  $('#busy').hidden = !text;
}

function refresh() {
  const on = !!S.elm;
  $('#welcome').hidden = on;
  $('#dash').hidden = !on;
  $('#disconnect').hidden = !on;
  $('#disconnect').disabled = S.busy;
  $('#conn-dot').classList.toggle('on', on);
  $('#conn-text').textContent = on ? (isDemo() ? 'Demo truck' : 'Connected') : 'Not connected';
  $('#connect-adapter').disabled = $('#connect-ble').disabled = $('#connect-demo').disabled = S.busy;
  $$('[data-conn]').forEach(b => { b.disabled = !on || S.busy; });
  $$('[data-cfg]').forEach(b => { b.disabled = !on || S.busy || !S.cfg; });
  $('#live-toggle').textContent = S.live.running ? 'Stop' : 'Start';
  $('#cfg-write').disabled = !on || S.busy || !S.cfg || !cfgChanges().length;
  $('#apply-go').disabled = S.busy;
  $('#applybar').hidden = !on || !S.pending.size;
  $('#apply-text').textContent = `${S.pending.size} change${S.pending.size === 1 ? '' : 's'} ready`;
  $('#nav-pending').hidden = !S.pending.size;
  $('#nav-pending').textContent = S.pending.size;
  const codes = S.modules.reduce((n, m) => n + (m.dtcs ? m.dtcs.length : 0), 0);
  $('#nav-dtc').hidden = !codes;
  $('#nav-dtc').textContent = codes;
  $$('.feat .switch').forEach(sw => { if (S.busy) sw.disabled = true; });
}

/* Run one user action at a time; live polling is paused while it runs. */
async function run(text, fn) {
  if (S.busy) return;
  S.busy = true;
  await stopLive();
  refresh();
  setBusy(text);
  try {
    await fn();
  } catch (e) {
    toast(e.message || String(e), 'error');
  } finally {
    S.busy = false;
    setBusy('');
    refresh();
    if (S.tab === 'features') renderFeatures();
  }
}

function showTab(name) {
  S.tab = name;
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('main > section').forEach(s => { s.hidden = s.id !== 'tab-' + name; });
  if (name === 'live') { if (S.elm && !S.live.supported && !S.busy) run('Checking which values the truck reports…', loadPids); else renderLive(); }
  if (name === 'features') { if (S.elm && !S.featuresLoaded && !S.busy) run('Reading current settings…', loadSettingValues); else renderFeatures(); }
  if (name === 'dtc') renderDtcs();
}

/* Modal. Without `validate` it resolves true/false. With it, OK runs validate():
   a thrown error is shown and the dialog stays open; a return value closes and resolves with it. */
function ask(title, body, okLabel = 'Continue', validate) {
  return new Promise(resolve => {
    const dlg = $('#dlg'), ok = $('#dlg-ok'), err = $('#dlg-error');
    $('#dlg-title').textContent = title;
    $('#dlg-body').replaceChildren(...[body].flat());
    ok.textContent = okLabel;
    err.hidden = true;
    ok.onclick = async () => {
      if (!validate) { dlg.close(); resolve(true); return; }
      ok.disabled = true;
      try {
        const v = await validate();
        dlg.close(); resolve(v);
      } catch (e) {
        err.textContent = e.message; err.hidden = false;
      } finally { ok.disabled = false; }
    };
    $('#dlg-cancel').onclick = () => { dlg.close(); resolve(false); };
    dlg.oncancel = () => resolve(false);
    dlg.showModal();
  });
}

function logLine(dir, text) {
  const t = new Date().toTimeString().slice(0, 8);
  S.log.push(`${t} ${dir === 'tx' ? '>>' : '<<'} ${text}`);
  if (S.log.length > 4000) S.log.splice(0, 1000);
  if ($('#log').closest('details').open && S.tab === 'advanced') renderLog();
}

function renderLog() {
  const pre = $('#log');
  pre.textContent = S.log.join('\n');
  pre.scrollTop = pre.scrollHeight;
}

function downloadFile(name, text) {
  const a = el('a', { download: name, href: URL.createObjectURL(new Blob([text], { type: 'application/json' })) });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---- Connection ---- */

async function connect(kind) {
  const link = kind === 'demo' ? new SimLink() : kind === 'ble' ? new BleLink() : new WebSerialLink(Number($('#baud').value));
  try {
    await link.open();
  } catch (e) {
    throw new Error(e.name === 'NotFoundError' ? 'No adapter was chosen.' : 'Could not open the adapter: ' + e.message);
  }
  const elm = new Elm(link, logLine);
  try {
    S.info = await elm.init();
  } catch (e) {
    await link.close();
    throw e;
  }
  S.link = link; S.elm = elm; S.uds = new Uds(elm);
  $('#v-adapter').textContent = S.info.adapter + (S.info.stn ? '' : ' · generic adapter, short writes only');
  showVoltage(S.info.voltage);
  refresh();

  let alive = false;
  try { alive = (await elm.request(0x7DF, [0x01, 0x00])).size > 0; } catch (e) { alive = false; }
  if (!alive) {
    renderModules();
    toast('The adapter is connected but the truck did not answer. Turn the ignition on (engine off), then press Quick scan.', 'error');
    return;
  }
  await scan(false);
}

function showVoltage(v) {
  $('#v-volt').textContent = v != null ? v.toFixed(1) + ' V' : '—';
  const note = $('#v-volt-note');
  note.textContent = v == null ? '' : v >= 12.2 ? 'Good' : 'Low: connect a charger before writing';
  note.className = v == null ? '' : v >= 12.2 ? 'good' : 'bad';
}

async function disconnect() {
  await stopLive();
  if (S.link) await S.link.close();
  Object.assign(S, { link: null, elm: null, uds: null, info: null, modules: [], vin: null, cfg: null, dtcRead: false, featuresLoaded: false });
  S.blocks.clear(); S.pending.clear(); S.backedUp.clear();
  S.live.supported = null; S.live.stats.clear();
  renderModules(); renderCfg(); renderDtcs(); renderLive(); renderFeatures();
  showTab('home');
}

/* ---- Module scan ---- */

function sweepAddresses() {
  const out = [];
  for (let a = 0x700; a <= 0x7E7; a++) if ((a & 0x0F) < 8) out.push(a);
  return out;
}

async function scan(full) {
  const addrs = full ? sweepAddresses() : Object.keys(MODULES).map(Number).sort((a, b) => a - b);
  const found = [];
  S.elm.busOf.clear();
  const probe = async (bus, what) => {
    for (let i = 0; i < addrs.length; i++) {
      if (found.includes(addrs[i])) continue;
      setBusy(`${what}… ${i + 1} of ${addrs.length}`);
      S.elm.busOf.set(addrs[i], bus);
      const r = await S.elm.request(addrs[i], [0x3E, 0x00], { timing: 'fast' });
      if (r) found.push(addrs[i]); else S.elm.busOf.delete(addrs[i]);
    }
  };
  await probe('hs', 'Looking for modules');
  /* OBDLink MX+ / EX: listen silently on pins 3 and 11 first, and only send requests there
     at a bit rate where traffic was actually heard. */
  S.altBus = null;
  if (S.elm.hasAltPins) {
    for (const bus of ALT_BUSES) {
      setBusy(`Listening on pins 3 and 11 at ${BUSES[bus].rate}…`);
      if (await S.elm.listen(bus, 500)) {
        S.altBus = bus;
        await probe(bus, 'Looking for modules on pins 3 and 11');
        break;
      }
    }
  }
  const text = async (addr, did) => {
    try { return ascii(await S.uds.readDid(addr, did)); } catch (e) {
      if (e instanceof AdapterError) throw e;
      return '';
    }
  };
  S.modules = []; S.vin = null; S.cfg = null; S.dtcRead = false; S.featuresLoaded = false;
  S.blocks.clear(); S.pending.clear();
  for (const addr of found) {
    setBusy(`Reading module ${hex(addr, 3)}…`);
    S.modules.push({ addr, ...moduleInfo(addr), bus: S.elm.busOf.get(addr) || 'hs', part: await text(addr, 0xF113), sw: await text(addr, 0xF188), dtcs: null, error: null });
    if (!S.vin) {
      const vin = await text(addr, 0xF190);
      if (vin.length === 17) S.vin = vin;
    }
  }
  renderModules(); renderCfg(); renderDtcs();
  if (!found.length) toast('No modules answered. Check that the ignition is on and the adapter is fully seated.', 'error');
}

function renderModules() {
  $('#v-vin').textContent = S.vin || '—';
  $('#v-mods').textContent = S.modules.length || '—';
  const alt = S.modules.filter(m => m.bus && m.bus !== 'hs').length;
  $('#v-mods-note').textContent = !S.elm || !S.elm.hasAltPins ? 'control units answering'
    : S.altBus ? `${alt} on pins 3/11 (${BUSES[S.altBus].rate})` : 'pins 3/11 checked: no traffic';
  const rows = S.modules.map(m => el('tr', {},
    el('td', {}, el('span', { class: 'tag' }, m.short)), el('td', {}, m.name),
    el('td', { class: 'mono' }, hex(m.addr, 3), m.bus && m.bus !== 'hs' ? el('span', { class: 'chip bus' }, BUSES[m.bus].label) : null),
    el('td', { class: 'mono' }, m.part || '—'), el('td', { class: 'mono' }, m.sw || '—')));
  $('#modules-body').replaceChildren(...(rows.length ? rows
    : [el('tr', {}, el('td', { class: 'empty', colspan: 5 }, 'No modules found yet.'))]));
  $('#cfg-module').replaceChildren(...S.modules.map(m =>
    el('option', { value: m.addr }, `${m.short}  ·  ${m.name}  ·  ${hex(m.addr, 3)}`)));
}

/* ---- Trouble codes ---- */

async function readAllDtcs() {
  for (const m of S.modules) {
    setBusy(`Reading codes from ${label(m)}…`);
    try {
      m.dtcs = await S.uds.readDtcs(m.addr);
      m.error = null;
    } catch (e) {
      if (e instanceof AdapterError) throw e;
      m.dtcs = null;
      m.error = e instanceof NegativeResponse ? 'This module does not report codes this way.' : e.message;
    }
  }
  S.dtcRead = true;
  renderDtcs();
}

function renderDtcs() {
  const total = S.modules.reduce((n, m) => n + (m.dtcs ? m.dtcs.length : 0), 0);
  const stat = $('#v-dtc'), note = $('#v-dtc-note');
  stat.className = '';
  if (!S.dtcRead) {
    stat.textContent = '—'; note.textContent = 'Press to check';
    $('#dtc-summary').textContent = S.elm ? 'Read the modules to see stored codes.' : 'Connect to the truck to read codes.';
    $('#dtc-list').replaceChildren();
    return;
  }
  stat.textContent = total; stat.className = total ? 'bad' : 'good';
  note.textContent = total ? 'Press to view' : 'All clear';
  const withCodes = S.modules.filter(m => m.dtcs && m.dtcs.length);
  const failed = S.modules.filter(m => !m.dtcs);
  const clean = S.modules.filter(m => m.dtcs && !m.dtcs.length);
  $('#dtc-summary').textContent = total
    ? `${total} code${total === 1 ? '' : 's'} in ${withCodes.length} module${withCodes.length === 1 ? '' : 's'}.`
    : 'No codes stored in any module.';
  const cards = withCodes.map(m => el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, el('span', { class: 'tag' }, m.short), el('small', {}, `${m.name} · ${hex(m.addr, 3)}`)),
      el('button', { class: 'danger small', onclick: () => clearCodes([m]) }, 'Clear')),
    el('ul', { class: 'codes' }, m.dtcs.map(d => {
      const base = DTC_TEXT[d.code] || 'Manufacturer-specific code (no built-in description)';
      const ftb = FTB_TEXT[d.ftb];
      return el('li', {},
        el('span', { class: 'code mono' }, `${d.code}:${hex(d.ftb)}-${hex(d.status)}`),
        el('span', { class: 'desc' }, ftb ? `${base} — ${ftb}` : base),
        dtcStatus(d.status).map(s => el('span', { class: 'chip' + (s === 'Present now' || s === 'Warning lamp on' ? ' hot' : '') }, s)));
    }))));
  if (!total) cards.push(el('div', { class: 'card empty-state' }, el('h2', {}, 'All clear'), el('p', {}, 'None of the modules has a stored trouble code.')));
  if (total && clean.length) cards.push(el('p', { class: 'muted' }, `No codes in: ${clean.map(m => m.short !== '—' ? m.short : hex(m.addr, 3)).join(', ')}.`));
  if (failed.length) cards.push(el('p', { class: 'muted' }, `Could not read: ${failed.map(m => `${label(m)} (${m.error})`).join('; ')}.`));
  $('#dtc-list').replaceChildren(...cards);
}

async function clearCodes(mods) {
  if (S.busy) return;
  const targets = mods.filter(m => m.dtcs && m.dtcs.length);
  if (!targets.length) { toast(S.dtcRead ? 'There are no stored codes to clear.' : 'Read the modules first.'); return; }
  const ok = await ask('Clear trouble codes?', [
    el('p', {}, `This erases stored codes and freeze-frame data in: ${targets.map(label).join(', ')}.`),
    el('p', { class: 'muted' }, 'Clearing the powertrain module also resets its emissions readiness monitors, which need normal driving to complete again. A fault that is still present will set its code again.'),
  ], 'Clear codes');
  if (!ok) return;
  await run('Clearing codes…', async () => {
    const failed = [];
    for (const m of targets) {
      try { await S.uds.clearDtcs(m.addr); } catch (e) {
        if (e instanceof AdapterError) throw e;
        if (!(e instanceof ResponsePending)) failed.push(`${label(m)}: ${e.message}`);
      }
    }
    await sleep(500);
    await readAllDtcs();
    if (failed.length) toast('Some modules did not clear. ' + failed.join(' '), 'error');
    else toast('Codes cleared.', 'ok');
  });
}

/* ---- Live data ---- */

async function loadPids() {
  const supported = new Set();
  for (const base of [0x00, 0x20, 0x40]) {
    const d = await S.uds.pid(base);
    if (!d || d.length < 4) break;
    const bits = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
    for (let i = 1; i <= 32; i++) if (bits & (2 ** (32 - i))) supported.add(base + i);
    if (!supported.has(base + 0x20)) break;
  }
  S.live.supported = PIDS.filter(p => supported.has(p.pid));
  S.live.stats.clear();
  renderLive();
}

function sparkline() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'spark'); svg.setAttribute('viewBox', '0 0 100 30');
  svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(line);
  return svg;
}

function renderLive() {
  const L = S.live;
  if (!L.supported) {
    $('#live-chips').replaceChildren();
    $('#live-tiles').replaceChildren(el('div', { class: 'card empty-state', style: 'grid-column:1/-1' },
      el('p', {}, S.elm ? 'Checking which values the truck reports…' : 'Connect to the truck to watch live values.')));
    return;
  }
  $('#live-chips').replaceChildren(...L.supported.map(p => el('button', {
    class: L.picked.has(p.pid) ? 'on' : '', 'aria-pressed': String(L.picked.has(p.pid)),
    onclick: () => { if (L.picked.has(p.pid)) L.picked.delete(p.pid); else L.picked.add(p.pid); renderLive(); },
  }, p.name)));
  const shown = L.supported.filter(p => L.picked.has(p.pid));
  $('#live-tiles').replaceChildren(...(shown.length ? shown.map(p => el('div', { class: 'card tile', 'data-pid': p.pid },
    el('div', { class: 'name' }, p.name), el('div', { class: 'val' }, '—'), el('div', { class: 'range' }, ' '), sparkline()))
    : [el('div', { class: 'card empty-state', style: 'grid-column:1/-1' }, el('p', {}, 'Pick at least one value above.'))]));
  shown.forEach(showLive);
}

function showLive(p) {
  const st = S.live.stats.get(p.pid);
  const tile = document.querySelector(`.tile[data-pid="${p.pid}"]`);
  if (!st || !tile) return;
  const imp = $('#imperial').checked && p.imp;
  const conv = v => (imp ? p.imp[1](v) : v).toFixed(p.dp);
  tile.querySelector('.val').replaceChildren(conv(st.now), el('small', {}, imp ? p.imp[0] : p.unit));
  tile.querySelector('.range').textContent = `min ${conv(st.min)} · max ${conv(st.max)}`;
  const lo = Math.min(...st.hist), span = (Math.max(...st.hist) - lo) || 1;
  const flat = Math.max(...st.hist) === lo;
  tile.querySelector('polyline').setAttribute('points', st.hist.map((v, i) =>
    `${(i / Math.max(st.hist.length - 1, 1) * 100).toFixed(1)},${flat ? 15 : (27 - (v - lo) / span * 24).toFixed(1)}`).join(' '));
}

async function liveLoop() {
  const L = S.live;
  while (L.running) {
    const picked = L.supported.filter(p => L.picked.has(p.pid));
    if (!picked.length) { await sleep(300); continue; }
    for (const p of picked) {
      if (!L.running) break;
      const d = await S.uds.pid(p.pid);
      if (!d) continue;
      const v = p.calc(d[0], d[1]);
      const st = L.stats.get(p.pid) || { now: v, min: v, max: v, hist: [] };
      st.now = v; st.min = Math.min(st.min, v); st.max = Math.max(st.max, v);
      st.hist.push(v); if (st.hist.length > 80) st.hist.shift();
      L.stats.set(p.pid, st);
      showLive(p);
    }
  }
}

function startLive() {
  S.live.running = true;
  S.live.done = liveLoop()
    .catch(e => toast('Live data stopped: ' + e.message, 'error'))
    .finally(() => { S.live.running = false; refresh(); });
  refresh();
}

async function stopLive() {
  if (!S.live.running) return;
  S.live.running = false;
  await S.live.done;
}

/* ---- Reading, backing up and writing configuration blocks ---- */

const CFG_FIRST = 0xDE00, CFG_LAST = 0xDEFF, CFG_GAP = 24;

/* Reads every configuration block a module has. Stops after a long run of missing ids. */
async function readAllBlocks(addr) {
  const out = [];
  let silent = 0, gap = 0;
  for (let did = CFG_FIRST; did <= CFG_LAST && gap < CFG_GAP; did++) {
    setBusy(`Reading ${label(findModule(addr))} block ${hex(did, 4)}…`);
    try {
      const bytes = await S.uds.readDid(addr, did);
      out.push({ did, bytes });
      S.blocks.set(key(addr, did), bytes);
      silent = 0; gap = 0;
    } catch (e) {
      if (e instanceof AdapterError) throw e;
      gap++;
      if (e instanceof NoResponse && ++silent >= 3) throw new Error('The module stopped answering. Check the ignition and try again.');
    }
  }
  return out;
}

function backupData(m, blocks) {
  const out = {};
  for (const b of blocks) out[hex(b.did, 4)] = bytesToHex(b.bytes, ' ');
  return { format: 'f150-diag-config-backup', version: 1, saved: new Date().toISOString(),
    vin: S.vin, address: hex(m.addr, 3), module: m.short, part: m.part, software: m.sw, blocks: out };
}

const backupName = d => `config-${d.address}-${d.module}-${d.vin || 'no-vin'}-${d.saved.slice(0, 19).replace(/[:T]/g, '-')}.json`;
const firstBackupKey = m => `f150diag.first.${S.vin || 'no-vin'}.${hex(m.addr, 3)}`;

/* Before the first write to a module in a session: save its whole configuration to a file,
   and keep the very first copy ever taken in the browser as well. */
async function ensureBackup(m) {
  if (S.backedUp.has(m.addr)) return;
  const blocks = await readAllBlocks(m.addr);
  if (!blocks.length) throw new Error(`${label(m)} has no readable configuration to back up, so nothing was written.`);
  const data = backupData(m, blocks);
  downloadFile(backupName(data), JSON.stringify(data, null, 2));
  if (!store.get(firstBackupKey(m))) store.set(firstBackupKey(m), data);
  S.backedUp.add(m.addr);
}

/* Writes whole blocks to one module and reads each back to verify.
   Returns { done: [did], problem: Error|null }. Adapter failures are thrown. */
async function writeBlocks(m, changes, doReset) {
  const done = [];
  let problem = null;
  try {
    await S.uds.session(m.addr, 0x03);
    for (const { did, bytes } of changes) {
      setBusy(`Writing ${label(m)} block ${hex(did, 4)}…`);
      try {
        try { await S.uds.writeDid(m.addr, did, bytes); } catch (e) {
          if (!(e instanceof ResponsePending)) throw e;
          await sleep(1500);
        }
        const back = await S.uds.readDid(m.addr, did);
        if (bytesToHex(back) !== bytesToHex(bytes)) throw new Error('The module did not keep the new value');
        S.blocks.set(key(m.addr, did), back);
        done.push(did);
      } catch (e) { e.did = did; throw e; }
    }
  } catch (e) {
    if (e instanceof AdapterError) throw e;
    problem = e;
  }
  try {
    if (doReset && done.length) { setBusy(`Restarting ${label(m)}…`); await S.uds.reset(m.addr); await sleep(2500); }
    else await S.uds.session(m.addr, 0x01);
  } catch (e) { if (e instanceof AdapterError) throw e; }
  return { done, problem };
}

function explain(problem) {
  const where = problem.did ? `block ${hex(problem.did, 4)}` : 'the start';
  const why = problem instanceof NegativeResponse && problem.nrc === 0x33
    ? 'the module requires a security unlock, which this app does not perform'
    : problem.message.replace(/\.$/, '');
  return `stopped at ${where}: ${why}`;
}

function writeWarnings(m, volts) {
  const out = [];
  if (volts != null && volts < 12.2) out.push(el('p', { class: 'warn' }, `Battery is at ${volts.toFixed(1)} V. Connect a charger first; low voltage is the usual cause of failed writes.`));
  if (SAFETY_CRITICAL.has(m.addr)) out.push(el('p', { class: 'warn' }, `${label(m)} controls brakes, steering or airbags. A wrong value here is a safety risk. Only continue if you are certain of the change.`));
  return out;
}

/* ---- Advanced: raw block editor ---- */

async function readCfg(addr) {
  const blocks = await readAllBlocks(addr);
  S.cfg = { addr, blocks: blocks.map(b => ({ did: b.did, orig: b.bytes })) };
  renderCfg();
}

function parseBlock(b) {
  try {
    const v = hexToBytes(b.input.value);
    return v.length === b.orig.length ? v : null;
  } catch (e) { return null; }
}

function cfgChanges() {
  if (!S.cfg) return [];
  return S.cfg.blocks.map(b => ({ b, v: parseBlock(b) }))
    .filter(x => x.v && bytesToHex(x.v) !== bytesToHex(x.b.orig));
}

function markBlock(b) {
  const v = parseBlock(b);
  b.input.classList.toggle('invalid', !v);
  b.input.classList.toggle('changed', !!v && bytesToHex(v) !== bytesToHex(b.orig));
  if (!v) { b.note.textContent = `Needs exactly ${b.orig.length} hex bytes`; b.note.className = 'note-bad'; }
  else if (b.note.textContent.startsWith('Needs exactly')) { b.note.textContent = ''; b.note.className = ''; }
}

function renderCfg() {
  const c = S.cfg, has = !!c && c.blocks.length > 0;
  $('#cfg-table').hidden = !has;
  $('#cfg-actions').hidden = !has;
  if (!c) {
    $('#cfg-body').replaceChildren();
    $('#cfg-hint').textContent = 'Read a module to see its configuration as raw hex bytes. Change only values you have a trusted source for.';
    refresh();
    return;
  }
  const m = findModule(c.addr);
  $('#cfg-hint').textContent = has
    ? `${label(m)}: ${c.blocks.length} block${c.blocks.length === 1 ? '' : 's'}. A backup file is saved automatically before the first write.`
    : `${label(m)} has no readable configuration blocks.`;
  $('#cfg-body').replaceChildren(...c.blocks.map(b => {
    b.input = el('input', { type: 'text', class: 'hexin', spellcheck: 'false', 'aria-label': 'Block ' + hex(b.did, 4),
      value: bytesToHex(b.orig, ' '), oninput: () => { markBlock(b); refresh(); } });
    b.note = b.note || el('span', {});
    return el('tr', {}, el('td', { class: 'mono' }, hex(b.did, 4)), el('td', {}, String(b.orig.length)),
      el('td', {}, b.input), el('td', {}, b.note));
  }));
  refresh();
}

/* Re-render without discarding what the user typed. */
function renderCfgKeepEdits() {
  const typed = S.cfg.blocks.map(b => b.input.value);
  renderCfg();
  S.cfg.blocks.forEach((b, i) => { b.input.value = typed[i]; markBlock(b); });
  refresh();
}

function saveCfgBackup() {
  const m = findModule(S.cfg.addr);
  const data = backupData(m, S.cfg.blocks.map(b => ({ did: b.did, bytes: b.orig })));
  downloadFile(backupName(data), JSON.stringify(data, null, 2));
  if (!store.get(firstBackupKey(m))) store.set(firstBackupKey(m), data);
  S.backedUp.add(m.addr);
  toast('Backup saved to your Downloads folder.', 'ok');
}

async function stageBackup(data) {
  if (!data || data.format !== 'f150-diag-config-backup' || !data.blocks) throw new Error('That file is not a backup saved by this app.');
  if (data.address !== hex(S.cfg.addr, 3)) throw new Error(`That backup is for module ${data.address}, not ${hex(S.cfg.addr, 3)}.`);
  if (data.vin && S.vin && data.vin !== S.vin) {
    const go = await ask('Different vehicle', el('p', {}, `This backup was saved from VIN ${data.vin}; the connected truck is ${S.vin}. Configuration from another vehicle may not suit this one.`), 'Load anyway');
    if (!go) return;
  }
  let staged = 0;
  for (const b of S.cfg.blocks) {
    const v = data.blocks[hex(b.did, 4)];
    if (typeof v === 'string') { b.input.value = v; markBlock(b); staged++; }
  }
  refresh();
  const diff = cfgChanges().length;
  toast(diff ? `Loaded the backup into the editor: ${diff} block${diff === 1 ? ' differs' : 's differ'} from the truck. Nothing is written until you press Write changes.`
    : `The truck already matches that backup (${staged} blocks compared).`);
}

async function loadCfgFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { data = null; }
  await stageBackup(data);
}

async function writeCfg() {
  const c = S.cfg, m = findModule(c.addr);
  if (c.blocks.some(b => !parseBlock(b))) throw new Error('Fix the highlighted values first; each block must keep its original length.');
  const changes = cfgChanges();
  if (!changes.length) throw new Error('Nothing has been changed.');
  if (!S.elm.isStn && changes.some(x => x.v.length > 4)) {
    throw new Error('One of these blocks is longer than a generic ELM327 adapter can write safely. Use an STN-based adapter (OBDLink EX / MX+, vLinker FS).');
  }
  const volts = await S.elm.voltage();
  showVoltage(volts);
  const body = [
    el('p', {}, `These blocks in ${label(m)} will be overwritten:`),
    el('ul', { class: 'diff' }, changes.map(x => el('li', {}, `${hex(x.b.did, 4)}: ${bytesToHex(x.b.orig, ' ')} → ${bytesToHex(x.v, ' ')}`))),
    el('p', { class: 'muted' }, 'A backup is saved to your Downloads folder first. Keep the ignition on with the engine off, and do not unplug the adapter until it finishes. A wrong value can disable a feature or the module until the backup is restored.'),
    ...writeWarnings(m, volts),
  ];
  if (!(await ask('Write configuration?', body, 'Write to truck'))) return;

  const doReset = $('#cfg-reset').checked;
  await run('Writing configuration…', async () => {
    c.blocks.forEach(b => { b.note.textContent = ''; b.note.className = ''; });
    await ensureBackup(m);
    const { done, problem } = await writeBlocks(m, changes.map(x => ({ did: x.b.did, bytes: x.v })), doReset);
    for (const b of c.blocks) {
      if (done.includes(b.did)) { b.orig = S.blocks.get(key(m.addr, b.did)); b.note.textContent = 'Written and verified'; b.note.className = 'note-ok'; }
      else if (problem && problem.did === b.did) { b.note.textContent = 'Not written'; b.note.className = 'note-bad'; }
    }
    renderCfgKeepEdits();
    S.featuresLoaded = false;
    if (problem) toast(`${label(m)} ${explain(problem)}. Blocks marked "Written and verified" were changed; the rest were not.`, 'error');
    else toast(`${done.length} block${done.length === 1 ? '' : 's'} written and verified.`, 'ok');
  });
}

/* ---- Wiring ---- */

$('#nav').onclick = e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); };
$('#connect-adapter').onclick = () => run('Connecting…', () => connect('serial'));
$('#connect-ble').onclick = () => run('Connecting…', () => connect('ble'));
$('#connect-demo').onclick = () => run('Starting the demo truck…', () => connect('demo'));
$('#disconnect').onclick = () => run('Disconnecting…', disconnect);
$('#scan-quick').onclick = () => run('Scanning…', () => scan(false));
$('#scan-full').onclick = () => run('Scanning…', () => scan(true));
$('#stat-dtc').onclick = () => { showTab('dtc'); if (!S.dtcRead) run('Reading codes…', readAllDtcs); };
$('#dtc-read').onclick = () => run('Reading codes…', readAllDtcs);
$('#dtc-clear').onclick = () => clearCodes(S.modules);
$('#live-toggle').onclick = async () => {
  if (S.live.running) { await stopLive(); return; }
  if (!S.live.supported) await run('Checking which values the truck reports…', loadPids);
  if (S.live.supported) startLive();
};
$('#imperial').onchange = () => { if (S.live.supported) S.live.supported.forEach(showLive); };
$('#feat-search').oninput = renderFeatures;
$('#feat-add').onclick = addSetting;
$('#feat-import').onclick = () => $('#feat-file').click();
$('#feat-export').onclick = exportSettings;
$('#feat-file').onchange = e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) importSettings(f).catch(err => toast(err.message, 'error'));
};
$('#apply-go').onclick = () => applyPending().catch(e => toast(e.message, 'error'));
$('#apply-discard').onclick = () => { S.pending.clear(); renderFeatures(); refresh(); };
$('#cfg-read').onclick = () => run('Reading configuration…', () => readCfg(Number($('#cfg-module').value)));
$('#cfg-backup').onclick = saveCfgBackup;
$('#cfg-load').onclick = () => $('#cfg-file').click();
$('#cfg-file').onchange = e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) loadCfgFile(f).catch(err => toast(err.message, 'error'));
};
$('#cfg-original').onclick = () => {
  const data = store.get(firstBackupKey(findModule(S.cfg.addr)));
  if (!data) { toast('This app has not saved a backup of this module on this computer yet.'); return; }
  stageBackup(data).catch(err => toast(err.message, 'error'));
};
$('#cfg-revert').onclick = () => { S.cfg.blocks.forEach(b => { b.note = null; }); renderCfg(); };
$('#cfg-write').onclick = () => writeCfg().catch(e => toast(e.message, 'error'));
$('#log').closest('details').ontoggle = renderLog;
$('#log-clear').onclick = e => { e.preventDefault(); S.log = []; renderLog(); };
$('#log-copy').onclick = e => {
  e.preventDefault();
  navigator.clipboard.writeText(S.log.join('\n')).then(() => toast('Log copied.', 'ok'), () => toast('Could not copy; select the text and copy it manually.', 'error'));
};

$('#connect-adapter').hidden = $('#serial-options').hidden = !WebSerialLink.supported();
$('#connect-ble').hidden = !BleLink.supported();
$('#no-serial').hidden = WebSerialLink.supported() || BleLink.supported();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
renderModules(); renderDtcs(); renderLive(); renderFeatures(); renderCfg();
refresh();
