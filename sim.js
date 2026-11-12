'use strict';
/* A pretend adapter plus a pretend truck, for trying the app without a vehicle.
   It speaks the same text protocol as a real ELM327/STN adapter. All data is made up. */

const strBytes = s => Array.from(s, c => c.charCodeAt(0));

/* Named settings for the pretend truck only. The names and bit positions are invented to
   show how the Features page works; they do not describe any real vehicle. */
const DEMO_SETTINGS = [
  { id: 'demo-1', name: 'Double-honk reminder when leaving with the key', addr: 0x726, did: 0xDE00, offset: 0, mask: 0x08, on: 0x08, off: 0x00 },
  { id: 'demo-2', name: 'Auto-lock doors when driving off', addr: 0x726, did: 0xDE00, offset: 2, mask: 0x01, on: 0x01, off: 0x00 },
  { id: 'demo-3', name: 'Daytime running lights', addr: 0x726, did: 0xDE01, offset: 1, mask: 0x10, on: 0x10, off: 0x00 },
  { id: 'demo-4', name: 'Open and close windows from the key fob', addr: 0x726, did: 0xDE01, offset: 2, mask: 0x01, on: 0x01, off: 0x00 },
  { id: 'demo-5', name: 'Rain-sensing wipers', addr: 0x726, did: 0xDE02, offset: 0, mask: 0xF0, on: 0x40, off: 0x00 },
  { id: 'demo-6', name: 'Digital speedometer', addr: 0x720, did: 0xDE00, offset: 3, mask: 0x02, on: 0x02, off: 0x00 },
  { id: 'demo-7', name: 'Wireless phone projection', addr: 0x7D0, did: 0xDE00, offset: 2, mask: 0x04, on: 0x04, off: 0x00 },
  { id: 'demo-8', name: 'Startup animation', addr: 0x7D0, did: 0xDE01, offset: 9, mask: 0x08, on: 0x08, off: 0x00 },
  { id: 'demo-9', name: 'Example: a module that refuses changes', addr: 0x737, did: 0xDE00, offset: 3, mask: 0x08, on: 0x08, off: 0x00 },
].map(s => ({ ...s, demo: true }));

class SimModule {
  constructor(addr, { part, sw, cfg = {}, dtcs = [], locked = false, obd = false }) {
    this.addr = addr;
    this.session = 1;
    this.locked = locked;
    this.obd = obd;
    this.dtcs = dtcs.map(d => d.slice());
    this.dids = new Map([
      [0xF190, strBytes('1FTFW1E50NFD00001')],
      [0xF113, strBytes(part)],
      [0xF188, strBytes(sw)],
    ]);
    for (const [did, bytes] of Object.entries(cfg)) this.dids.set(Number(did), bytes.slice());
  }

  nrc(sid, code) { return [0x7F, sid, code]; }

  handle(req) {
    const sid = req[0];
    switch (sid) {
      case 0x3E: return [0x7E, 0x00];
      case 0x10: this.session = req[1]; return [0x50, req[1], 0x00, 0x19, 0x01, 0xF4];
      case 0x11: this.session = 1; return [0x51, req[1]];
      case 0x22: {
        const did = (req[1] << 8) | req[2];
        const v = this.dids.get(did);
        return v ? [0x62, req[1], req[2], ...v] : this.nrc(sid, 0x31);
      }
      case 0x2E: {
        const did = (req[1] << 8) | req[2];
        const cur = this.dids.get(did);
        if (this.session !== 3) return this.nrc(sid, 0x7F);
        if (!cur || (did >> 8) !== 0xDE) return this.nrc(sid, 0x31);
        if (this.locked) return this.nrc(sid, 0x33);
        if (req.length - 3 !== cur.length) return this.nrc(sid, 0x13);
        this.dids.set(did, req.slice(3));
        return [0x6E, req[1], req[2]];
      }
      case 0x19: {
        if (req[1] !== 0x02) return this.nrc(sid, 0x12);
        const out = [0x59, 0x02, 0xFF];
        for (const d of this.dtcs) if (d[3] & req[2]) out.push(...d);
        return out;
      }
      case 0x14: this.dtcs = []; return [0x54];
      case 0x01: return this.obd ? this.mode01(req[1]) : null;
      default: return this.nrc(sid, 0x11);
    }
  }

  mode01(pid) {
    const supported = [0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11,
      0x20, 0x2F, 0x33, 0x40, 0x42, 0x46, 0x5C];
    if (pid % 0x20 === 0) {
      let bits = 0;
      for (const p of supported) if (p > pid && p <= pid + 0x20) bits |= 1 << (32 - (p - pid));
      bits >>>= 0;
      return [0x41, pid, bits >>> 24, (bits >>> 16) & 0xFF, (bits >>> 8) & 0xFF, bits & 0xFF];
    }
    if (!supported.includes(pid)) return null;
    const t = Date.now() / 1000;
    const u16 = v => [(v >> 8) & 0xFF, v & 0xFF];
    const data = {
      0x04: [56], 0x05: [130], 0x06: [128 + Math.round(4 * Math.sin(t / 2))], 0x07: [130],
      0x08: [128 + Math.round(3 * Math.cos(t / 2))], 0x09: [127], 0x0B: [34],
      0x0C: u16(Math.round((680 + 40 * Math.sin(t)) * 4)), 0x0D: [0], 0x0E: [152], 0x0F: [65],
      0x10: u16(Math.round(420 + 30 * Math.sin(t))), 0x11: [38], 0x2F: [158], 0x33: [99],
      0x42: u16(14100 + Math.round(60 * Math.sin(t / 3))), 0x46: [60], 0x5C: [135],
    }[pid];
    return [0x41, pid, ...data];
  }
}

class SimLink {
  constructor(stn = true) {
    this.stn = stn;
    this.closed = true;
    this.echo = true;
    this.spaces = true;
    this.header = 0x7DF;
    this.modules = [
      new SimModule(0x7E0, { part: 'DEMO-12A650-AA', sw: 'DEMO-14C204-AA', obd: true,
        dtcs: [[0x01, 0x71, 0x00, 0xAF], [0x04, 0x56, 0x00, 0x2C]] }),
      new SimModule(0x7E1, { part: 'DEMO-7000-AA', sw: 'DEMO-14C337-AA' }),
      new SimModule(0x760, { part: 'DEMO-2C219-AA', sw: 'DEMO-14C036-AA',
        cfg: { 0xDE00: [0x01, 0x22, 0x40, 0x00, 0x1A, 0x00, 0x03, 0x10] },
        dtcs: [[0xC1, 0x00, 0x00, 0x28]] }),
      new SimModule(0x726, { part: 'DEMO-15604-AA', sw: 'DEMO-14C184-AA', cfg: {
        0xDE00: [0x2A, 0x00, 0x1F, 0x84, 0x00, 0x51],
        0xDE01: [0x00, 0x10, 0x02, 0x00, 0x8C, 0x00],
        0xDE02: [0x41, 0x00, 0x00, 0x20, 0x05],
        0xDE03: [0x01, 0x00, 0x64, 0x00],
        0xDE04: [0x00, 0x00, 0x30, 0x12, 0x00, 0x00, 0x7F] } }),
      new SimModule(0x720, { part: 'DEMO-10849-AA', sw: 'DEMO-14C026-AA', cfg: {
        0xDE00: [0x10, 0x04, 0x00, 0x22],
        0xDE01: [0x00, 0x80, 0x01],
        0xDE02: [0x05, 0x00, 0x00, 0x00, 0x11, 0x40] },
        dtcs: [[0xC1, 0x40, 0x00, 0x28]] }),
      new SimModule(0x7D0, { part: 'DEMO-14G371-AA', sw: 'DEMO-14G374-AA', cfg: {
        0xDE00: [0x2A, 0x2A, 0x05, 0x02, 0x00],
        0xDE01: [0x01, 0x00, 0x00, 0x30, 0x00, 0x44, 0x00, 0x12, 0x00, 0x08],
        0xDE02: [0x00, 0x00, 0x01],
        0xDE03: [0x40, 0x01, 0x00, 0x00, 0x02] } }),
      new SimModule(0x716, { part: 'DEMO-14H474-AA', sw: 'DEMO-14H021-AA' }),
      new SimModule(0x730, { part: 'DEMO-3F964-AA', sw: 'DEMO-14D003-AA',
        cfg: { 0xDE00: [0x00, 0x01, 0x30] } }),
      new SimModule(0x737, { part: 'DEMO-14B321-AA', sw: 'DEMO-14C028-AA', locked: true,
        cfg: { 0xDE00: [0x11, 0x00, 0x42, 0x08] } }),
      new SimModule(0x733, { part: 'DEMO-19980-AA', sw: 'DEMO-14D007-AA' }),
      new SimModule(0x740, { part: 'DEMO-14B531-AA', sw: 'DEMO-14D098-AA' }),
      new SimModule(0x741, { part: 'DEMO-14B533-AA', sw: 'DEMO-14D099-AA' }),
      new SimModule(0x7B7, { part: 'DEMO-19H405-AA', sw: 'DEMO-14G650-AA' }),
    ];
    /* Two pretend modules wired only to pins 3/11 at 500 kbps, to exercise the MX+ second bus. */
    for (const m of [new SimModule(0x7A7, { part: 'DEMO-18842-AA', sw: 'DEMO-14G301-AA' }),
      new SimModule(0x734, { part: 'DEMO-13D012-AA', sw: 'DEMO-14F142-AA', dtcs: [[0xB1, 0x08, 0x13, 0x29]] })]) {
      m.bus = 'alt';
      this.modules.push(m);
    }
    this.pins = 'hs';
    this.rate = 500000;
  }

  /* Which modules can hear the adapter right now. Pins 3/11 only work at the right bit rate. */
  reachable() {
    if (this.pins === 'alt' && this.rate !== 500000) return [];
    return this.modules.filter(m => (m.bus || 'hs') === this.pins);
  }

  /* Monitor mode: on a live bus at the right bit rate, print some broadcast frames. */
  monitor(cmd, ms) {
    if (this.closed) return Promise.reject(new AdapterError('The adapter is not connected'));
    return new Promise(resolve => setTimeout(() => {
      const live = this.reachable().length > 0;
      const lines = live ? ['3B3 40 00 00 00 00 00 00 00', '3C3 0A 22 00 00 00 00 00 00', '3B3 40 00 00 00 00 00 00 00'] : [];
      resolve((this.echo ? cmd + '\r' : '') + lines.concat('STOPPED').join('\r') + '\r\r');
    }, Math.min(ms, 40)));
  }

  async open() { this.closed = false; }
  async close() { this.closed = true; }

  exchange(cmd) {
    if (this.closed) return Promise.reject(new AdapterError('The adapter is not connected'));
    return new Promise(resolve => setTimeout(() => {
      const c = cmd.replace(/\s+/g, '').toUpperCase();
      const wasEcho = this.echo;
      const out = /^(AT|ST)/.test(c) ? this.at(c) : this.data(c);
      resolve((wasEcho ? cmd + '\r' : '') + out + '\r\r');
    }, 3));
  }

  at(c) {
    let m;
    if (c === 'ATZ') { this.echo = true; this.spaces = true; return '\r\rELM327 v1.4b'; }
    if (c === 'ATI') return 'ELM327 v1.4b';
    if (c === 'STI') return this.stn ? 'STN2255 v5.10.3' : '?';
    if (c === 'ATRV') return '12.4V';
    if (c === 'STDI') return this.stn ? 'OBDLink MX+ r3.2.1' : '?';
    if (this.stn && (m = /^STPXH:([0-9A-F]{3}),D:([0-9A-F]+),R:\d+$/.exec(c))) { this.header = parseInt(m[1], 16); return this.data(m[2]); }
    if (c === 'ATSP6' || (this.stn && c === 'STP33')) { this.pins = 'hs'; this.rate = 500000; return 'OK'; }
    if (this.stn && c === 'STP53') { this.pins = 'alt'; this.rate = 125000; return 'OK'; }
    if (this.stn && (m = /^STPBR(\d+)$/.exec(c))) { this.rate = Number(m[1]); return 'OK'; }
    if (this.stn && /^STCMM[012]$/.test(c)) return 'OK';
    if ((m = /^ATE([01])$/.exec(c))) { this.echo = m[1] === '1'; return 'OK'; }
    if ((m = /^ATS([01])$/.exec(c))) { this.spaces = m[1] === '1'; return 'OK'; }
    if ((m = /^ATSH([0-9A-F]{3})$/.exec(c))) { this.header = parseInt(m[1], 16); return 'OK'; }
    if (/^AT(L[01]|H[01]|CAF[01]|AT[012]|ST[0-9A-F]{2}|SP[0-9A-F]|CRA[0-9A-F]{3}|AR|FCSH[0-9A-F]{3}|FCSD[0-9A-F]{2,10}|FCSM[012])$/.test(c)) return 'OK';
    return '?';
  }

  data(c) {
    if (!/^([0-9A-F]{2})+$/.test(c)) return '?';
    const req = [];
    for (let i = 0; i < c.length; i += 2) req.push(parseInt(c.substr(i, 2), 16));
    if (req.length > 7 && !this.stn) return '?';
    const here = this.reachable();
    const targets = this.header === 0x7DF ? here.filter(m => m.obd) : here.filter(m => m.addr === this.header);
    const lines = [];
    for (const m of targets) {
      const resp = m.handle(req);
      if (resp) lines.push(...this.frames(m.addr + 8, resp));
    }
    return lines.length ? lines.join('\r') : 'NO DATA';
  }

  frames(id, data) {
    const out = [];
    if (data.length <= 7) {
      out.push([data.length, ...data]);
    } else {
      out.push([0x10 | (data.length >> 8), data.length & 0xFF, ...data.slice(0, 6)]);
      let sn = 1;
      for (let i = 6; i < data.length; i += 7) out.push([0x20 | (sn++ & 0x0F), ...data.slice(i, i + 7)]);
    }
    return out.map(f => {
      while (f.length < 8) f.push(0x00);
      return [hex(id, 3), ...f.map(x => hex(x))].join(this.spaces ? ' ' : '');
    });
  }
}
