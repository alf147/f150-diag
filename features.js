'use strict';
/* Features page: named settings built on configuration blocks.
   A setting has options; each option is a list of parts { addr, did, offset, mask, value }.
   A switch is a setting with an "on" option and, when the stock value is known, an "off" one.
   Shared state (S, store, el, toast, run, ...) lives in app.js. */

/* ---- Notation ---- */

/* "726-63-02" -> module address, block id and the byte offset where that line starts.
   Block numbers are decimal (block 01 is DE00); each line holds five data bytes. */
function parseLocation(loc) {
  const m = /^\s*([0-9A-F]{3})\s*-\s*(\d{1,3})\s*-\s*(\d{1,2})\s*$/i.exec(loc);
  if (!m) throw new Error('Write the location like 726-01-02 (module, block, line).');
  const block = parseInt(m[2], 10), line = parseInt(m[3], 10);
  if (!block || !line || block > 256) throw new Error('Block and line numbers start at 01.');
  return { addr: parseInt(m[1], 16), did: 0xDE00 + block - 1, base: (line - 1) * 5,
    text: `${m[1].toUpperCase()}-${String(block).padStart(2, '0')}-${String(line).padStart(2, '0')}` };
}

/* "726-63-02 xxx0 xxxx xx--" -> one part per byte the pattern pins down. */
function patternParts(text) {
  const t = text.trim(), sp = t.indexOf(' ');
  const loc = parseLocation(t.slice(0, sp));
  const bytes = new Map();
  [...t.slice(sp).replace(/\s/g, '')].forEach((c, i) => {
    if (!/[0-9A-F]/i.test(c)) return;
    if (i >= 10) throw new Error('A value sits on the checksum digits: ' + text);
    const e = bytes.get(i >> 1) || { mask: 0, value: 0 }, v = parseInt(c, 16);
    if (i % 2 === 0) { e.mask |= 0xF0; e.value |= v << 4; } else { e.mask |= 0x0F; e.value |= v; }
    bytes.set(i >> 1, e);
  });
  return [...bytes].map(([b, e]) => ({ addr: loc.addr, did: loc.did, offset: loc.base + b, mask: e.mask, value: e.value, loc: loc.text }));
}

function toParts(list) {
  return list.flatMap(p => {
    if (typeof p === 'string') return patternParts(p);
    const loc = parseLocation(p.loc);
    return [{ addr: loc.addr, did: loc.did, offset: loc.base + p.byte, mask: p.mask, value: p.value, loc: loc.text }];
  });
}

/* ---- The settings list ---- */

function fromPreset(p) {
  const s = { id: p.id, name: p.name, note: p.note, risk: p.risk, src: p.src, preset: true };
  if (p.choices) {
    s.kind = 'choice';
    s.options = p.choices.map(([label, ...parts], i) => ({ key: 'c' + i, label, parts: toParts(parts) }));
  } else {
    s.kind = 'toggle';
    s.options = [{ key: 'on', label: 'On', parts: toParts(p.on) }];
    if (p.off) s.options.push({ key: 'off', label: 'Off', parts: toParts(p.off) });
  }
  return s;
}

/* Demo and user-added settings are stored in a flat single-byte form. */
function fromSimple(u) {
  const part = value => [{ addr: u.addr, did: u.did, offset: u.offset, mask: u.mask, value, loc: u.loc }];
  return { id: u.id, name: u.name, demo: u.demo, user: !u.demo, kind: 'toggle', where: u.loc,
    options: [{ key: 'on', label: 'On', parts: part(u.on) }, { key: 'off', label: 'Off', parts: part(u.off) }] };
}

const PRESET_SETTINGS = F150_PRESETS.map(fromPreset);
const DEMO_LIST = DEMO_SETTINGS.map(fromSimple);

const usingPresets = () => (S.forcePresets != null ? S.forcePresets : !isDemo());
const allSettings = () => (usingPresets() ? PRESET_SETTINGS : DEMO_LIST).concat(S.userSettings.map(fromSimple));

/* The values a setting replaced the first time it was changed on this truck, so it can be put back. */
const restoreKey = s => `f150diag.restore.${S.vin || 'no-vin'}.${s.id}`;
const restoreOf = s => store.get(restoreKey(s), null);

function optionsOf(s) {
  const out = s.options.slice(), r = restoreOf(s);
  if (r && s.kind === 'choice') out.push({ key: 'orig', label: 'Original', parts: r, restored: true });
  if (r && s.kind === 'toggle' && !out.some(o => o.key === 'off')) out.push({ key: 'off', label: 'Off', parts: r, restored: true });
  return out;
}

const allParts = s => s.options.flatMap(o => o.parts);
const primaryAddr = s => s.options[0].parts[0].addr;
const matches = parts => parts.every(p => (S.blocks.get(key(p.addr, p.did))[p.offset] & p.mask) === p.value);

/* 'unknown' / 'invalid' when the truck's data cannot answer; otherwise the matching option's key,
   'off' for a switch whose stock value is not documented, or 'other'. */
function stateOf(s) {
  for (const p of allParts(s)) {
    const b = S.blocks.get(key(p.addr, p.did));
    if (!b) return 'unknown';
    if (p.offset >= b.length) return 'invalid';
  }
  for (const o of optionsOf(s)) if (matches(o.parts)) return o.key;
  return s.kind === 'toggle' && !s.options.some(o => o.key === 'off') ? 'off' : 'other';
}

async function loadSettingValues() {
  const need = new Map();
  for (const s of allSettings()) for (const p of allParts(s)) if (findModule(p.addr)) need.set(key(p.addr, p.did), p);
  let i = 0;
  for (const [k, p] of need) {
    setBusy(`Reading current settings… ${++i} of ${need.size}`);
    try { S.blocks.set(k, await S.uds.readDid(p.addr, p.did)); } catch (e) {
      if (e instanceof AdapterError) throw e;
      S.blocks.delete(k);
    }
  }
  S.featuresLoaded = true;
  for (const [id, want] of S.pending) {
    const s = allSettings().find(x => x.id === id);
    if (!s || stateOf(s) === want) S.pending.delete(id);
  }
  renderFeatures();
}

function chooseOption(s, want) {
  if (!want || want === stateOf(s)) S.pending.delete(s.id); else S.pending.set(s.id, want);
  renderFeatures(); refresh();
}

function removeSetting(s) {
  S.userSettings = S.userSettings.filter(x => x.id !== s.id);
  S.pending.delete(s.id);
  store.set('f150diag.settings', S.userSettings);
  renderFeatures(); refresh();
}

/* ---- Rendering ---- */

function renderFeatures() {
  const box = $('#feat-list');
  if (!S.elm) {
    box.replaceChildren(el('div', { class: 'card empty-state' }, el('p', {}, 'Connect to the truck to see and change its settings.')));
    return;
  }
  const q = $('#feat-search').value.trim().toLowerCase();
  const list = allSettings().filter(s => !q || s.name.toLowerCase().includes(q));
  const cards = [];
  if (!usingPresets()) {
    cards.push(el('p', { class: 'muted intro' }, 'These demo settings are invented for the simulated truck. With a real adapter connected, this page lists community-documented settings for the 2021-2023 F-150 instead.'));
  } else {
    cards.push(el('div', { class: 'warn intro' },
      'These settings come from community sources for the 2021-2023 F-150 (',
      el('a', { href: 'https://f150mods.us/years/2022', target: '_blank', rel: 'noopener' }, 'f150mods.us'),
      ', built on the owners\' as-built spreadsheet). They have not been verified on your truck. Values differ by year, trim and options, so read the exact bytes in the confirmation before applying, and change one thing at a time.'));
  }
  const addrs = [...new Set(list.map(primaryAddr))].sort((a, b) => a - b);
  for (const addr of addrs) {
    const m = findModule(addr), info = m || { addr, ...moduleInfo(addr) };
    cards.push(el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', {}, el('span', { class: 'tag' }, info.short !== '—' ? info.short : hex(addr, 3)),
        el('small', {}, m ? info.name : `${info.name} · not found on this truck`))),
      list.filter(s => primaryAddr(s) === addr).map(featureRow)));
  }
  if (!list.length) cards.push(el('div', { class: 'card empty-state' }, el('p', {}, q ? 'No settings match that search.' : 'No settings yet. Use "Add a setting" to create one.')));
  box.replaceChildren(...cards);
}

function featureRow(s) {
  const st = stateOf(s), want = S.pending.get(s.id), opts = optionsOf(s);
  const readable = st !== 'unknown' && st !== 'invalid';
  const nameOf = k => (opts.find(o => o.key === k) || {}).label || (k === 'off' ? 'Off' : s.kind === 'toggle' ? 'Other value' : 'Not in list');
  let control, text;
  if (!readable) {
    text = st === 'invalid' ? 'Not in this block' : 'Cannot read';
  } else if (want) {
    text = `${nameOf(st)} → ${nameOf(want)}`;
  } else {
    text = nameOf(st);
  }
  if (s.kind === 'toggle') {
    const stuck = st === 'on' && !want && !opts.some(o => o.key === 'off');
    if (stuck) text = 'On · stock value unknown';
    control = el('input', { type: 'checkbox', role: 'switch', class: 'switch', 'aria-label': s.name,
      checked: (want || st) === 'on', disabled: !readable || stuck || S.busy,
      title: stuck ? 'This was already on when first read and its stock value is not documented. Use a backup on the Advanced page to change it.' : null,
      onchange: e => chooseOption(s, e.target.checked ? 'on' : 'off') });
    if (!want && st === 'other') control.indeterminate = true;
  } else {
    const current = want || st;
    if (readable && !want) text = '';
    control = el('select', { 'aria-label': s.name, disabled: !readable || S.busy, onchange: e => chooseOption(s, e.target.value) },
      opts.some(o => o.key === current) ? null : el('option', { value: '', selected: true }, readable ? 'Current (not in list)' : '—'),
      opts.map(o => el('option', { value: o.key, selected: o.key === current }, o.label)));
  }
  const others = [...new Set(allParts(s).map(p => p.addr))].filter(a => a !== primaryAddr(s)).map(a => moduleInfo(a).short);
  const where = s.where || [...new Set(allParts(s).map(p => p.loc))].join(' · ');
  return el('div', { class: 'feat' + (want ? ' pending' : '') },
    el('div', { class: 'info' },
      el('div', { class: 'name' }, s.name, s.risk === 'medium' ? el('span', { class: 'chip caution' }, 'Read the note') : null),
      s.note ? el('div', { class: 'note' }, s.note) : null,
      el('div', { class: 'where mono' }, where, others.length ? ` · also ${others.join(', ')}` : '',
        s.src ? [' · ', el('a', { href: PRESET_SOURCE + s.src, target: '_blank', rel: 'noopener' }, 'source')] : null)),
    el('span', { class: 'state' + (!want && st === 'on' ? ' on' : '') }, text),
    control,
    s.user ? el('button', { class: 'icon', title: 'Remove this setting from the list', 'aria-label': `Remove ${s.name}`, onclick: () => removeSetting(s) }, '✕') : null);
}

/* ---- Applying ---- */

/* The bytes an option would change, from the values last read: "BCM DE3E byte 7: 31 → 30". */
function previewBytes(opt) {
  const out = [];
  for (const p of opt.parts) {
    const b = S.blocks.get(key(p.addr, p.did));
    if (!b || p.offset >= b.length) continue;
    const now = b[p.offset], next = (now & ~p.mask) | p.value;
    if (now !== next) out.push(`${moduleInfo(p.addr).short} ${hex(p.did, 4)} byte ${p.offset + 1}: ${hex(now)} → ${hex(next)}`);
  }
  return out.length ? out.join('   ') : 'already matches';
}

async function applyPending() {
  const items = [];
  for (const [id, want] of S.pending) {
    const s = allSettings().find(x => x.id === id);
    const opt = s && optionsOf(s).find(o => o.key === want);
    if (opt) items.push({ s, opt, from: stateOf(s) }); else S.pending.delete(id);
  }
  refresh();
  if (!items.length) return;
  const groups = new Map();            // module address -> [{ it, part }]
  for (const it of items) for (const part of it.opt.parts) {
    if (!groups.has(part.addr)) groups.set(part.addr, []);
    groups.get(part.addr).push({ it, part });
  }
  const missing = [...groups.keys()].filter(a => !findModule(a));
  if (missing.length) { toast(`This truck did not report module ${missing.map(a => hex(a, 3)).join(', ')}, so those changes cannot be applied.`, 'error'); return; }
  if (!S.elm.isStn && [...groups.values()].flat().some(({ part }) => (S.blocks.get(key(part.addr, part.did)) || []).length > 4)) {
    toast('One of these settings lives in a block that is too long for a generic ELM327 adapter to write safely. Use an STN-based adapter (OBDLink EX / MX+, vLinker FS).', 'error');
    return;
  }
  const volts = await S.elm.voltage();
  showVoltage(volts);
  const body = [
    el('ul', { class: 'changes' }, items.map(({ s, opt }) => el('li', {}, `${s.name} → `, el('b', {}, opt.label),
      el('div', { class: 'diff muted' }, previewBytes(opt))))),
    el('p', { class: 'muted' }, 'A backup of each module is saved to your Downloads folder first. Keep the ignition on with the engine off, and do not unplug the adapter until it finishes. Each module restarts after its change.'),
    ...writeWarnings({ addr: -1 }, volts),
    ...[...groups.keys()].flatMap(addr => writeWarnings(findModule(addr), null)),
  ];
  if (!(await ask(`Apply ${items.length} change${items.length === 1 ? '' : 's'}?`, body, 'Apply to truck'))) return;

  await run('Applying changes…', async () => {
    const failures = [];
    const result = new Map(items.map(it => [it.s.id, { ok: true, any: false, before: [] }]));
    for (const [addr, list] of groups) {
      const m = findModule(addr);
      try {
        await ensureBackup(m);
        const fresh = new Map(), next = new Map();
        for (const { it, part } of list) {
          if (!fresh.has(part.did)) {
            fresh.set(part.did, await S.uds.readDid(addr, part.did));
            next.set(part.did, Uint8Array.from(fresh.get(part.did)));
          }
          const b = next.get(part.did);
          if (part.offset >= b.length) throw new Error(`"${it.s.name}" points outside block ${hex(part.did, 4)}`);
          result.get(it.s.id).before.push({ addr, did: part.did, offset: part.offset, mask: part.mask, value: fresh.get(part.did)[part.offset] & part.mask, loc: part.loc });
          b[part.offset] = (b[part.offset] & ~part.mask) | part.value;
        }
        const same = did => bytesToHex(fresh.get(did)) === bytesToHex(next.get(did));
        const changes = [...next].filter(([did]) => !same(did)).map(([did, bytes]) => ({ did, bytes }));
        const { done, problem } = changes.length ? await writeBlocks(m, changes, true) : { done: [], problem: null };
        for (const did of fresh.keys()) if (same(did)) S.blocks.set(key(addr, did), fresh.get(did));
        for (const { it, part } of list) {
          const r = result.get(it.s.id);
          if (done.includes(part.did)) r.any = true; else if (!same(part.did)) r.ok = false;
        }
        if (problem) failures.push(`${label(m)} ${explain(problem)}.`);
      } catch (e) {
        if (e instanceof AdapterError) throw e;
        for (const { it } of list) result.get(it.s.id).ok = false;
        failures.push(`${label(m)}: ${e.message.replace(/\.$/, '')}.`);
      }
    }
    let written = 0;
    for (const it of items) {
      const r = result.get(it.s.id);
      const undocumented = it.s.kind === 'toggle' ? it.opt.key === 'on' && !it.s.options.some(o => o.key === 'off') : it.from === 'other';
      if (r.any && undocumented && !it.opt.restored && !restoreOf(it.s)) store.set(restoreKey(it.s), r.before);
      if (r.ok) { S.pending.delete(it.s.id); written++; }
    }
    if (failures.length) toast(`${written ? `${written} change${written === 1 ? '' : 's'} applied. ` : 'Nothing was changed. '}${failures.join(' ')}`, 'error');
    else toast(`${written} change${written === 1 ? '' : 's'} written and verified.`, 'ok');
  });
}

/* ---- Adding your own settings ---- */

function parsePosition(pos) {
  const p = pos.replace(/[\s-]/g, '');
  if (!/^[xX*]{1,12}$/.test(p) || !p.includes('*')) throw new Error('Mark the digit with * the way spreadsheets do, for example xxxx *xxx xxxx.');
  const stars = [...p].map((c, i) => (c === '*' ? i : -1)).filter(i => i >= 0);
  if (stars.some(i => i >= 10)) throw new Error('The last two digits of a line are its checksum, not a setting.');
  const byte = Math.floor(stars[0] / 2);
  if (stars.length > 2 || stars.some(i => Math.floor(i / 2) !== byte)) throw new Error('This form handles one digit, or the two digits of one byte.');
  return { byte, digits: stars.length, mask: stars.reduce((a, i) => a | (i % 2 === 0 ? 0xF0 : 0x0F), 0),
    shift: stars.length === 1 && stars[0] % 2 === 0 ? 4 : 0 };
}

function parseDigits(text, digits, what) {
  if (!new RegExp(`^[0-9A-Fa-f]{${digits}}$`).test(text.trim())) throw new Error(`${what} must be ${digits} hex digit${digits > 1 ? 's' : ''}.`);
  return parseInt(text.trim(), 16);
}

async function addSetting() {
  const f = {
    name: el('input', { type: 'text', placeholder: 'What the setting does' }),
    loc: el('input', { type: 'text', class: 'mono', placeholder: '726-01-02' }),
    pos: el('input', { type: 'text', class: 'mono', placeholder: 'xxxx *xxx xxxx' }),
    whole: el('input', { type: 'radio', name: 'mode', checked: true }),
    bit: el('input', { type: 'radio', name: 'mode' }),
    on: el('input', { type: 'text', class: 'mono', placeholder: '1' }),
    off: el('input', { type: 'text', class: 'mono', placeholder: '0' }),
  };
  const offWrap = el('label', {}, 'Value when off', f.off);
  const onLabel = document.createTextNode('Value when on');
  const setMode = () => { offWrap.hidden = f.bit.checked; onLabel.textContent = f.bit.checked ? 'Amount added when on' : 'Value when on'; };
  f.whole.onchange = f.bit.onchange = setMode;
  const form = el('div', { class: 'form' },
    el('label', {}, 'Name', f.name),
    el('div', { class: 'two' },
      el('label', {}, 'Location', f.loc, el('small', {}, 'Module, block and line')),
      el('label', {}, 'Digit', f.pos, el('small', {}, 'Put * on the digit that changes'))),
    el('div', { class: 'radios' },
      el('label', {}, f.whole, 'The values replace the digit (for example 0 = off, 1 = on)'),
      el('label', {}, f.bit, 'The value is added to the digit, which other settings share (for example +4)')),
    el('div', { class: 'two' }, el('label', {}, onLabel, f.on), offWrap));

  const setting = await ask('Add a setting', form, 'Add', async () => {
    const name = f.name.value.trim();
    if (!name) throw new Error('Give the setting a name.');
    const loc = parseLocation(f.loc.value), pos = parsePosition(f.pos.value);
    const onV = parseDigits(f.on.value, pos.digits, f.bit.checked ? 'The added amount' : 'The on value') << pos.shift;
    const s = { id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name,
      addr: loc.addr, did: loc.did, offset: loc.base + pos.byte, loc: `${loc.text} ${f.pos.value.trim().toLowerCase()}` };
    if (f.bit.checked) {
      if (!onV) throw new Error('The added amount cannot be 0.');
      Object.assign(s, { mask: onV, on: onV, off: 0 });
    } else {
      const offV = parseDigits(f.off.value, pos.digits, 'The off value') << pos.shift;
      if (onV === offV) throw new Error('The on and off values are the same.');
      Object.assign(s, { mask: pos.mask, on: onV, off: offV });
    }
    if (S.elm && findModule(s.addr)) {
      let b = null;
      try { b = await S.uds.readDid(s.addr, s.did); } catch (e) { if (e instanceof AdapterError) throw e; }
      if (!b || s.offset >= b.length) throw new Error(`${label(findModule(s.addr))} has no data at that location (block ${hex(s.did, 4)}, byte ${s.offset + 1}).`);
      S.blocks.set(key(s.addr, s.did), b);
    }
    return s;
  });
  if (!setting) return;
  S.userSettings.push(setting);
  store.set('f150diag.settings', S.userSettings);
  renderFeatures();
  const st = stateOf(fromSimple(setting));
  toast(st === 'unknown' ? `Added "${setting.name}".`
    : `Added "${setting.name}". The truck currently reads ${st === 'other' ? 'a value that is neither on nor off; check the entry' : st}.`, st === 'other' ? 'info' : 'ok');
}

function validSetting(s) {
  const byte = v => Number.isInteger(v) && v >= 0 && v <= 0xFF;
  return s && typeof s.name === 'string' && s.name.trim() && Number.isInteger(s.addr) && s.addr >= 0x700 && s.addr <= 0x7FF &&
    Number.isInteger(s.did) && s.did >= 0xDE00 && s.did <= 0xDEFF && Number.isInteger(s.offset) && s.offset >= 0 && s.offset < 4096 &&
    byte(s.mask) && s.mask > 0 && byte(s.on) && byte(s.off) && s.on !== s.off && !(s.on & ~s.mask) && !(s.off & ~s.mask);
}

async function importSettings(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { data = null; }
  if (!data || data.format !== 'f150-diag-settings' || !Array.isArray(data.settings)) throw new Error('That file is not a settings file exported by this app.');
  const good = data.settings.filter(validSetting);
  let n = 0;
  for (const s of good) {
    if (S.userSettings.some(x => x.addr === s.addr && x.did === s.did && x.offset === s.offset && x.mask === s.mask)) continue;
    S.userSettings.push({ id: 'u' + Date.now().toString(36) + (n++) + Math.random().toString(36).slice(2, 6), name: s.name.trim().slice(0, 120),
      addr: s.addr, did: s.did, offset: s.offset, mask: s.mask, on: s.on, off: s.off, loc: typeof s.loc === 'string' ? s.loc.slice(0, 60) : undefined });
  }
  store.set('f150diag.settings', S.userSettings);
  toast(`Imported ${n} setting${n === 1 ? '' : 's'}` + (good.length < data.settings.length ? `; skipped ${data.settings.length - good.length} that were not valid.` : '.'), 'ok');
  S.featuresLoaded = false;
  if (S.elm && !S.busy) await run('Reading current settings…', loadSettingValues); else renderFeatures();
}

function exportSettings() {
  if (!S.userSettings.length) { toast('There are no settings of your own to export yet.'); return; }
  const settings = S.userSettings.map(({ id, ...rest }) => rest);
  downloadFile('f150-settings.json', JSON.stringify({ format: 'f150-diag-settings', version: 1, settings }, null, 2));
}
