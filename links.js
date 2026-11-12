'use strict';
/* Ways of reaching the adapter: a serial port (USB, or Bluetooth paired as a serial port)
   and Bluetooth LE. Both speak the same text protocol and end every reply with ">". */

class PromptLink {
  constructor() { this.buf = ''; this.waiter = null; this.closed = true; }

  _feed(text) {
    this.buf += text;
    if (!this.waiter) return;
    const i = this.buf.indexOf('>');
    if (i < 0) return;
    const reply = this.buf.slice(0, i);
    this.buf = this.buf.slice(i + 1);
    const w = this.waiter; this.waiter = null;
    clearTimeout(w.timer);
    w.resolve(reply);
  }

  _lost() {
    this.closed = true;
    if (!this.waiter) return;
    const w = this.waiter; this.waiter = null;
    clearTimeout(w.timer);
    w.reject(new AdapterError('The adapter was disconnected'));
  }

  /* Send one command, resolve with everything the adapter prints before its ">" prompt. */
  exchange(cmd, timeoutMs = 4000) {
    if (this.closed) return Promise.reject(new AdapterError('The adapter is not connected'));
    this.buf = '';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new AdapterError('The adapter did not answer in time'));
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
      this._send(new TextEncoder().encode(cmd + '\r')).catch(e => {
        clearTimeout(timer); this.waiter = null; reject(new AdapterError(e.message));
      });
    });
  }

  /* Start a monitor command, let it run for `ms`, then stop it with one carriage return.
     The stop is only sent while the monitor is still running: a bare carriage return at
     the prompt would repeat the previous command. */
  monitor(cmd, ms) {
    let done = false;
    const p = this.exchange(cmd, ms + 4000);
    p.then(() => { done = true; }, () => { done = true; });
    setTimeout(() => { if (!done) this._send(new TextEncoder().encode('\r')).catch(() => {}); }, ms);
    return p;
  }
}

/* ---- Serial port (Chrome / Edge on a computer; Chrome on Android for paired Bluetooth) ---- */

class WebSerialLink extends PromptLink {
  constructor(baud) { super(); this.baud = baud; }
  static supported() { return 'serial' in navigator; }

  async open() {
    /* Also list Bluetooth Classic serial adapters such as the OBDLink MX+ (Serial Port Profile). */
    this.port = await navigator.serial.requestPort({ allowedBluetoothServiceClassIds: ['00001101-0000-1000-8000-00805f9b34fb'] });
    await this.port.open({ baudRate: this.baud });
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.closed = false;
    this._pump();
  }

  async _pump() {
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this._feed(dec.decode(value, { stream: true }));
      }
    } catch (e) { /* port lost */ } finally { this._lost(); }
  }

  _send(bytes) { return this.writer.write(bytes); }

  async close() {
    try { await this.reader.cancel(); } catch (e) {}
    try { this.reader.releaseLock(); } catch (e) {}
    try { this.writer.releaseLock(); } catch (e) {}
    try { await this.port.close(); } catch (e) {}
    this.closed = true;
  }
}

/* ---- Bluetooth LE (Chrome on Android, and on computers) ---- */

/* Serial-style services used by common BLE OBD adapters. The link looks inside whichever
   one the adapter offers for a characteristic that notifies and one that accepts writes. */
const BLE_SERVICES = [
  0xFFF0, 0xFFE0, 0x18F0,
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
];

class BleLink extends PromptLink {
  static supported() { return 'bluetooth' in navigator; }

  async open() {
    this.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
    const gatt = await this.device.gatt.connect();
    this.rx = this.tx = null;
    for (const service of await gatt.getPrimaryServices()) {
      let rx = null, tx = null;
      for (const ch of await service.getCharacteristics()) {
        if (!rx && (ch.properties.notify || ch.properties.indicate)) rx = ch;
        if (!tx && (ch.properties.writeWithoutResponse || ch.properties.write)) tx = ch;
      }
      if (rx && tx) { this.rx = rx; this.tx = tx; break; }
    }
    if (!this.rx) {
      try { gatt.disconnect(); } catch (e) {}
      throw new Error('That Bluetooth device does not offer a serial service this app recognises.');
    }
    const dec = new TextDecoder();
    this.rx.addEventListener('characteristicvaluechanged', e => this._feed(dec.decode(e.target.value, { stream: true })));
    await this.rx.startNotifications();
    this.device.addEventListener('gattserverdisconnected', () => this._lost());
    this.closed = false;
  }

  /* BLE carries about 20 bytes per write, so longer commands go out in pieces. */
  async _send(bytes) {
    const quick = this.tx.properties.writeWithoutResponse;
    for (let i = 0; i < bytes.length; i += 20) {
      const chunk = bytes.slice(i, i + 20);
      if (quick) await this.tx.writeValueWithoutResponse(chunk); else await this.tx.writeValueWithResponse(chunk);
    }
  }

  async close() {
    try { await this.rx.stopNotifications(); } catch (e) {}
    try { this.device.gatt.disconnect(); } catch (e) {}
    this.closed = true;
  }
}
