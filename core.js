'use strict';
/* ELM327/STN command layer and UDS / OBD-II services. The adapter links are in links.js. */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');
const bytesToHex = (b, sep = '') => Array.from(b, x => hex(x)).join(sep);

function hexToBytes(s) {
  const clean = s.replace(/\s+/g, '');
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error('Not a hex value');
  if (clean.length % 2) throw new Error('Odd number of hex digits');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

const ascii = b => String.fromCharCode(...Array.from(b).filter(c => c >= 0x20 && c < 0x7F)).trim();

class AdapterError extends Error {}
class NoResponse extends Error {
  constructor() { super('The module did not answer'); }
}
class ResponsePending extends Error {
  constructor() { super('The module was still working when the adapter stopped listening'); }
}

const NRC = {
  0x10: 'general reject', 0x11: 'service not supported', 0x12: 'sub-function not supported',
  0x13: 'incorrect message length or format', 0x14: 'response too long', 0x21: 'busy, repeat request',
  0x22: 'conditions not correct', 0x24: 'request sequence error', 0x31: 'request out of range',
  0x33: 'security access denied', 0x35: 'invalid key', 0x36: 'exceeded number of attempts',
  0x37: 'required time delay not expired', 0x72: 'general programming failure',
  0x78: 'response pending', 0x7E: 'sub-function not supported in active session',
  0x7F: 'service not supported in active session',
};

class NegativeResponse extends Error {
  constructor(sid, nrc) {
    super(`Module refused the request: ${NRC[nrc] || 'unknown reason'} (NRC 0x${hex(nrc)})`);
    this.sid = sid;
    this.nrc = nrc;
  }
}

/* ---- ELM327 / STN command layer ---- */

const BUSES = {
  hs: { label: 'pins 6/14', cmds: ['STP 33'] },
  alt500: { label: 'pins 3/11', rate: '500 kbps', cmds: ['STP 53', 'STPBR 500000'] },
  alt125: { label: 'pins 3/11', rate: '125 kbps', cmds: ['STP 53', 'STPBR 125000'] },
};
const ALT_BUSES = ['alt500', 'alt125'];

const TIMING = {
  fast: ['ATAT0', 'ATST20'],    // 128 ms, used for module discovery
  normal: ['ATAT1', 'ATST32'],  // adaptive, 200 ms ceiling
  slow: ['ATAT0', 'ATSTFF'],    // ~1 s, for writes and clears
};

class Elm {
  constructor(link, log) {
    this.link = link;
    this.log = log || (() => {});
    this.queue = Promise.resolve();
    this.tx = null;
    this.timing = null;
    this.isStn = false;
    this.name = '';
    this.pendingSeen = false;
    this.bus = 'hs';
    this.busOf = new Map();      // module request id -> bus it answered on
    this.hasAltPins = false;     // OBDLink MX / MX+ / EX can switch to DLC pins 3 and 11
  }

  /* Switch the adapter between the main bus (pins 6/14) and pins 3/11. OBDLink FRPM:
     STP 33 = ISO 15765 11-bit 500 kbps on pins 6/14; STP 53 = ISO 15765 11-bit on the
     medium-speed transceiver, pins 3/11; STPBR sets that bus's bit rate. */
  async _setBus(bus) {
    if (this.bus === bus) return;
    if (bus !== 'hs' && !this.hasAltPins) throw new AdapterError('This adapter cannot reach pins 3 and 11 of the diagnostic port.');
    for (const c of BUSES[bus].cmds) await this._atOk(c);
    this.bus = bus; this.tx = null; this.timing = null;
  }

  /* Listen without transmitting or acknowledging (STCMM 0) and count the frames heard.
     Used before sending anything on pins 3/11, so a wrong bit rate never disturbs the truck. */
  listen(bus, ms) {
    return this._lock(async () => {
      await this._setBus(bus);
      await this._atSoft('STCMM 0');
      this.log('tx', `STMA (listening for ${ms} ms)`);
      const text = await this.link.monitor('STMA', ms);
      const lines = text.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
      const frames = lines.filter(l => /^[0-9A-F\s]{7,}$/i.test(l));
      this.log('rx', frames.length ? `${frames.length} frames, e.g. ${frames.slice(0, 3).join(' | ')}` : lines.join(' | ') || '(nothing)');
      return frames.length;
    });
  }

  /* Every public call runs to completion before the next one starts. */
  _lock(fn) {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }

  async _raw(cmd, timeout) {
    this.log('tx', cmd);
    const text = await this.link.exchange(cmd, timeout);
    const lines = text.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
    this.log('rx', lines.join(' | ') || '(nothing)');
    return lines;
  }

  async _atOk(cmd) {
    const r = (await this._raw(cmd)).join(' ');
    if (!/OK/.test(r)) throw new AdapterError(`The adapter rejected ${cmd} (${r || 'no reply'})`);
  }

  async _atSoft(cmd) {
    try { await this._raw(cmd); } catch (e) { if (this.link.closed) throw e; }
  }

  init() {
    return this._lock(async () => {
      this.tx = null; this.timing = null; this.bus = 'hs'; this.busOf.clear();
      try { await this._raw('ATZ', 7000); } catch (e) { await this._raw('ATZ', 7000); }
      await this._raw('ATE0');
      const id = (await this._raw('ATI')).join(' ');
      if (!/ELM327|STN/i.test(id)) {
        throw new AdapterError('That port did not answer like an ELM327-compatible adapter. Check the baud rate.');
      }
      for (const c of ['ATL0', 'ATS0', 'ATH1', 'ATCAF1', 'ATSP6']) await this._atOk(c);
      const sti = (await this._raw('STI')).join(' ');
      this.isStn = /STN\s*\d+/i.test(sti);
      const dev = this.isStn ? (await this._raw('STDI')).join(' ') : '';
      this.name = /OBDLink/i.test(dev) ? `${dev} (${sti})` : this.isStn ? sti : id;
      this.hasAltPins = /OBDLink\s+(MX|EX)/i.test(dev);
      await this._setTiming('normal');
      return { adapter: this.name, stn: this.isStn, altPins: this.hasAltPins, voltage: await this._voltage() };
    });
  }

  async _voltage() {
    const r = (await this._raw('ATRV')).join(' ');
    const m = r.match(/(\d+(\.\d+)?)\s*V/i);
    return m ? parseFloat(m[1]) : null;
  }
  voltage() { return this._lock(() => this._voltage()); }

  async _setTiming(mode) {
    if (this.timing === mode) return;
    for (const c of TIMING[mode]) await this._atSoft(c);
    this.timing = mode;
  }

  async _target(txId) {
    if (this.tx === txId) return;
    this.tx = null;
    const h = hex(txId, 3);
    await this._atOk('ATSH' + h);
    if (txId === 0x7DF) {
      await this._atSoft('ATFCSM0');
      await this._atOk('ATAR');
    } else {
      await this._atOk('ATCRA' + hex(txId + 8, 3));
      await this._atSoft('ATFCSH' + h);
      await this._atSoft('ATFCSD300000');
      await this._atSoft('ATFCSM1');
    }
    this.tx = txId;
  }

  /* Physical request: resolves with the reply bytes, or null if nothing came back.
     Functional request (0x7DF): resolves with a Map of responder id -> reply bytes. */
  request(txId, payload, opts = {}) {
    return this._lock(async () => {
      const data = typeof payload === 'string' ? hexToBytes(payload) : Uint8Array.from(payload);
      if (data.length > 7 && !this.isStn) {
        throw new AdapterError('This request is longer than one CAN frame. Only STN-based adapters ' +
          '(OBDLink EX / MX+, vLinker FS) send those reliably, so it was not sent.');
      }
      await this._setBus(txId === 0x7DF ? 'hs' : (this.busOf.get(txId) || 'hs'));
      await this._setTiming(opts.timing || 'normal');
      await this._target(txId);
      /* Requests longer than one CAN frame go through the STN's STPX command. If the adapter
         does not accept it, it answers "?" and nothing is sent to the truck. */
      const lines = data.length > 7
        ? await this._raw(`STPX h:${hex(txId, 3)}, d:${bytesToHex(data)}, r:1`, 15000)
        : await this._raw(bytesToHex(data), 15000);
      const msgs = this._reassemble(lines);
      if (txId === 0x7DF) {
        const out = new Map();
        for (const [id, list] of msgs) out.set(id, list[list.length - 1]);
        return out;
      }
      const list = msgs.get(txId + 8) || [];
      const final = list.filter(m => !(m[0] === 0x7F && m[2] === 0x78));
      this.pendingSeen = final.length === 0 && list.length > 0;
      return final.length ? final[final.length - 1] : null;
    });
  }

  /* Turn the adapter's printed CAN frames into complete ISO-TP messages per responder. */
  _reassemble(lines) {
    const done = new Map();
    const partial = new Map();
    const push = (id, m) => { if (!done.has(id)) done.set(id, []); done.get(id).push(m); };
    for (const line of lines) {
      const s = line.replace(/\s+/g, '').toUpperCase();
      if (s === 'NODATA' || s.startsWith('SEARCHING')) continue;
      if (!/^[0-9A-F]+$/.test(s)) {
        if (/ERROR|UNABLE|BUFFERFULL|STOPPED|BUSBUSY|^\?$/.test(s)) {
          throw new AdapterError(`Adapter reported "${line}"`);
        }
        continue;
      }
      if (s.length < 5 || s.length % 2 === 0) continue;   // 3 id digits + whole bytes
      const id = parseInt(s.slice(0, 3), 16);
      const d = hexToBytes(s.slice(3));
      const type = d[0] >> 4;
      if (type === 0) {
        push(id, d.slice(1, 1 + (d[0] & 0x0F)));
      } else if (type === 1) {
        partial.set(id, { len: ((d[0] & 0x0F) << 8) | d[1], buf: Array.from(d.slice(2)) });
      } else if (type === 2) {
        const p = partial.get(id);
        if (!p) continue;
        p.buf.push(...d.slice(1));
        if (p.buf.length >= p.len) { push(id, Uint8Array.from(p.buf.slice(0, p.len))); partial.delete(id); }
      }
    }
    if (partial.size) throw new AdapterError('A multi-frame reply arrived incomplete');
    return done;
  }
}

/* ---- UDS (ISO 14229) and OBD-II services ---- */

class Uds {
  constructor(elm) { this.elm = elm; }

  async call(addr, bytes, opts) {
    const r = await this.elm.request(addr, bytes, opts);
    if (!r) throw this.elm.pendingSeen ? new ResponsePending() : new NoResponse();
    if (r[0] === 0x7F) throw new NegativeResponse(r[1], r[2]);
    if (r[0] !== bytes[0] + 0x40) throw new Error('Unexpected reply: ' + bytesToHex(r, ' '));
    return r;
  }

  async readDid(addr, did) {
    const r = await this.call(addr, [0x22, did >> 8, did & 0xFF]);
    return r.slice(3);
  }

  writeDid(addr, did, data) {
    return this.call(addr, [0x2E, did >> 8, did & 0xFF, ...data], { timing: 'slow' });
  }

  session(addr, type) { return this.call(addr, [0x10, type]); }
  reset(addr) { return this.call(addr, [0x11, 0x01], { timing: 'slow' }); }

  /* Status mask 0xAF: everything except the two "test not completed" bits. */
  async readDtcs(addr) {
    const r = await this.call(addr, [0x19, 0x02, 0xAF]);
    const out = [];
    for (let i = 3; i + 3 < r.length; i += 4) {
      out.push({ code: dtcCode(r[i], r[i + 1]), ftb: r[i + 2], status: r[i + 3] });
    }
    return out;
  }

  clearDtcs(addr) { return this.call(addr, [0x14, 0xFF, 0xFF, 0xFF], { timing: 'slow' }); }

  /* OBD-II mode 01, sent functionally; returns the engine controller's data bytes. */
  async pid(pid) {
    const map = await this.elm.request(0x7DF, [0x01, pid]);
    const r = map.get(0x7E8) || [...map.values()][0];
    return r && r[0] === 0x41 && r[1] === pid ? r.slice(2) : null;
  }
}

function dtcCode(b0, b1) {
  return 'PCBU'[b0 >> 6] + ((b0 >> 4) & 3) + hex(b0 & 0x0F, 1) + hex(b1);
}

function dtcStatus(st) {
  const out = [];
  if (st & 0x01) out.push('Present now');
  if (st & 0x08) out.push('Confirmed');
  if (st & 0x04) out.push('Pending');
  if (st & 0x80) out.push('Warning lamp on');
  if (!(st & 0x01)) out.push('Not present now');
  return out;
}

/* ---- Reference tables ---- */

/* Diagnostic request ids commonly used by Ford modules (reply id = request + 8).
   A full sweep finds anything that is not listed here. */
const MODULES = {
  0x7E0: ['PCM', 'Powertrain Control Module'],
  0x7E1: ['TCM', 'Transmission Control Module'],
  0x760: ['ABS', 'Anti-Lock Brake System Module'],
  0x730: ['PSCM', 'Power Steering Control Module'],
  0x737: ['RCM', 'Restraints Control Module'],
  0x720: ['IPC', 'Instrument Panel Cluster'],
  0x726: ['BCM', 'Body Control Module'],
  0x716: ['GWM', 'Gateway Module'],
  0x7D0: ['APIM', 'SYNC Module'],
  0x727: ['ACM', 'Audio Control Module'],
  0x733: ['HVAC', 'Climate Control Module'],
  0x736: ['PAM', 'Parking Aid Module'],
  0x706: ['IPMA', 'Image Processing Module A'],
  0x7B1: ['IPMB', 'Image Processing Module B'],
  0x724: ['SCCM', 'Steering Column Control Module'],
  0x740: ['DDM', 'Driver Door Module'],
  0x741: ['PDM', 'Passenger Door Module'],
  0x744: ['DSM', 'Driver Seat Module'],
  0x754: ['TCU', 'Telematics Control Unit'],
  0x701: ['GPSM', 'Global Positioning System Module'],
  0x7A7: ['FCIM', 'Front Controls Interface Module'],
  0x734: ['HCM', 'Headlamp Control Module'],
  0x7C4: ['SODL', 'Side Obstacle Detection, Left'],
  0x7C6: ['SODR', 'Side Obstacle Detection, Right'],
  0x765: ['OCS', 'Occupant Classification System'],
  0x725: ['WACM', 'Wireless Charging Module'],
  0x783: ['DSP', 'Audio Signal Processing Module'],
  0x751: ['RTM', 'Radio Transceiver Module'],
};

/* Modules where a wrong configuration value affects brakes, steering or airbags. */
const SAFETY_CRITICAL = new Set([0x760, 0x730, 0x737]);

const moduleInfo = addr => {
  const m = MODULES[addr];
  return m ? { short: m[0], name: m[1] } : { short: '—', name: 'Unlisted module' };
};

/* Generic (SAE-defined) codes only. Manufacturer-specific codes show without a description. */
const DTC_TEXT = {
  P0101: 'Mass air flow sensor range/performance',
  P0113: 'Intake air temperature sensor 1 circuit high',
  P0128: 'Coolant thermostat below regulating temperature',
  P0171: 'System too lean, bank 1',
  P0172: 'System too rich, bank 1',
  P0174: 'System too lean, bank 2',
  P0175: 'System too rich, bank 2',
  P0300: 'Random or multiple cylinder misfire detected',
  P0301: 'Cylinder 1 misfire detected',
  P0302: 'Cylinder 2 misfire detected',
  P0303: 'Cylinder 3 misfire detected',
  P0304: 'Cylinder 4 misfire detected',
  P0305: 'Cylinder 5 misfire detected',
  P0306: 'Cylinder 6 misfire detected',
  P0307: 'Cylinder 7 misfire detected',
  P0308: 'Cylinder 8 misfire detected',
  P0420: 'Catalyst efficiency below threshold, bank 1',
  P0430: 'Catalyst efficiency below threshold, bank 2',
  P0442: 'Evaporative emission system small leak detected',
  P0455: 'Evaporative emission system large leak detected',
  P0456: 'Evaporative emission system very small leak detected',
  P0457: 'Evaporative emission system leak detected (fuel cap loose or off)',
  P0500: 'Vehicle speed sensor "A"',
  P0562: 'System voltage low',
  P0563: 'System voltage high',
  U0073: 'Control module communication bus "A" off',
  U0100: 'Lost communication with engine/powertrain control module',
  U0101: 'Lost communication with transmission control module',
  U0121: 'Lost communication with anti-lock brake system module',
  U0131: 'Lost communication with power steering control module',
  U0140: 'Lost communication with body control module',
  U0151: 'Lost communication with restraints control module',
  U0155: 'Lost communication with instrument panel cluster',
  U3003: 'Battery voltage',
};

/* Failure type byte (SAE J2012-DA), the two digits after the colon. */
const FTB_TEXT = {
  0x00: '', 0x01: 'general electrical failure', 0x11: 'circuit short to ground',
  0x12: 'circuit short to battery', 0x13: 'circuit open', 0x14: 'circuit short to ground or open',
  0x15: 'circuit short to battery or open', 0x16: 'circuit voltage below threshold',
  0x17: 'circuit voltage above threshold', 0x1C: 'circuit voltage out of range',
  0x29: 'signal invalid', 0x31: 'no signal', 0x49: 'internal electronic failure',
  0x51: 'not programmed', 0x54: 'missing calibration', 0x55: 'not configured',
  0x62: 'signal compare failure', 0x64: 'signal plausibility failure',
  0x81: 'invalid serial data received', 0x86: 'signal invalid', 0x87: 'missing message',
  0x88: 'bus off', 0x92: 'performance or incorrect operation',
  0x96: 'component internal failure', 0x98: 'component or system over temperature',
};

const cToF = c => c * 9 / 5 + 32;
const PIDS = [
  { pid: 0x0C, name: 'Engine speed', unit: 'rpm', dp: 0, calc: (a, b) => (a * 256 + b) / 4 },
  { pid: 0x0D, name: 'Vehicle speed', unit: 'km/h', dp: 0, calc: a => a, imp: ['mph', v => v * 0.621371] },
  { pid: 0x04, name: 'Engine load', unit: '%', dp: 1, calc: a => a * 100 / 255 },
  { pid: 0x11, name: 'Throttle position', unit: '%', dp: 1, calc: a => a * 100 / 255 },
  { pid: 0x05, name: 'Coolant temperature', unit: '°C', dp: 0, calc: a => a - 40, imp: ['°F', cToF] },
  { pid: 0x5C, name: 'Oil temperature', unit: '°C', dp: 0, calc: a => a - 40, imp: ['°F', cToF] },
  { pid: 0x0F, name: 'Intake air temperature', unit: '°C', dp: 0, calc: a => a - 40, imp: ['°F', cToF] },
  { pid: 0x46, name: 'Ambient air temperature', unit: '°C', dp: 0, calc: a => a - 40, imp: ['°F', cToF] },
  { pid: 0x0B, name: 'Intake manifold pressure', unit: 'kPa', dp: 0, calc: a => a, imp: ['psi', v => v * 0.145038] },
  { pid: 0x33, name: 'Barometric pressure', unit: 'kPa', dp: 0, calc: a => a, imp: ['psi', v => v * 0.145038] },
  { pid: 0x10, name: 'Mass air flow', unit: 'g/s', dp: 2, calc: (a, b) => (a * 256 + b) / 100 },
  { pid: 0x0E, name: 'Ignition timing advance', unit: '°', dp: 1, calc: a => a / 2 - 64 },
  { pid: 0x06, name: 'Short-term fuel trim, bank 1', unit: '%', dp: 1, calc: a => (a - 128) * 100 / 128 },
  { pid: 0x07, name: 'Long-term fuel trim, bank 1', unit: '%', dp: 1, calc: a => (a - 128) * 100 / 128 },
  { pid: 0x08, name: 'Short-term fuel trim, bank 2', unit: '%', dp: 1, calc: a => (a - 128) * 100 / 128 },
  { pid: 0x09, name: 'Long-term fuel trim, bank 2', unit: '%', dp: 1, calc: a => (a - 128) * 100 / 128 },
  { pid: 0x2F, name: 'Fuel level', unit: '%', dp: 1, calc: a => a * 100 / 255 },
  { pid: 0x42, name: 'Control module voltage', unit: 'V', dp: 2, calc: (a, b) => (a * 256 + b) / 1000 },
];
