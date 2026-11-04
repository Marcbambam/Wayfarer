import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { randomBytes, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

// Minimaler WebSocket-Client (RFC 6455) ohne Abhängigkeiten.
// Grund: LG-Fernseher nutzen auf Port 3001 selbstsignierte Zertifikate, die der
// eingebaute WebSocket von Node nicht akzeptiert. Unterstützt nur Textnachrichten.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function encodeFrame(text, { opcode = 1, mask = true } = {}) {
  const payload = Buffer.from(text);
  const len = payload.length;
  const head = [0x80 | opcode];
  const m = mask ? 0x80 : 0;
  if (len < 126) head.push(m | len);
  else if (len < 65536) head.push(m | 126, len >> 8, len & 255);
  else {
    head.push(m | 127, 0, 0, 0, 0);
    head.push((len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255);
  }
  if (!mask) return Buffer.concat([Buffer.from(head), payload]);
  const key = randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ key[i & 3];
  return Buffer.concat([Buffer.from(head), key, masked]);
}

// Liest so viele vollständige Frames wie möglich aus buf.
export function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    let len = b1 & 127;
    let p = off + 2;
    if (len === 126) {
      if (buf.length < p + 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length < p + 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    const masked = (b1 & 128) !== 0;
    const keyAt = p;
    if (masked) p += 4;
    if (buf.length < p + len) break;
    let payload = buf.subarray(p, p + len);
    if (masked) {
      const key = buf.subarray(keyAt, keyAt + 4);
      payload = Buffer.from(payload.map((x, i) => x ^ key[i & 3]));
    }
    frames.push({ fin: (b0 & 128) !== 0, opcode: b0 & 15, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

export class WsClient extends EventEmitter {
  static connect(url, { timeout = 5000, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const secure = u.protocol === 'wss:';
      const port = Number(u.port) || (secure ? 443 : 80);
      const opts = { host: u.hostname, port, servername: u.hostname, rejectUnauthorized: false };
      const sock = secure ? tlsConnect(opts) : netConnect(opts);
      const key = randomBytes(16).toString('base64');
      const timer = setTimeout(() => { sock.destroy(); reject(new Error(`Zeitüberschreitung bei ${u.host}`)); }, timeout);
      let buf = Buffer.alloc(0);

      sock.once('error', (err) => { clearTimeout(timer); reject(err); });
      sock.once(secure ? 'secureConnect' : 'connect', () => {
        const lines = [
          `GET ${u.pathname || '/'}${u.search} HTTP/1.1`,
          `Host: ${u.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        ];
        sock.write(`${lines.join('\r\n')}\r\n\r\n`);
      });
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        sock.off('data', onData);
        clearTimeout(timer);
        const head = buf.subarray(0, end).toString();
        const accept = createHash('sha1').update(key + GUID).digest('base64');
        if (!/^HTTP\/1\.1 101/.test(head) || !head.toLowerCase().includes(`sec-websocket-accept: ${accept.toLowerCase()}`)) {
          sock.destroy();
          reject(new Error(`WebSocket-Handshake mit ${u.host} fehlgeschlagen`));
          return;
        }
        sock.removeAllListeners('error');
        resolve(new WsClient(sock, buf.subarray(end + 4)));
      };
      sock.on('data', onData);
    });
  }

  constructor(sock, initial) {
    super();
    this.sock = sock;
    this.open = true;
    this.buf = Buffer.alloc(0);
    this.parts = [];
    sock.setNoDelay?.(true);
    sock.on('data', (c) => this.onData(c));
    sock.on('close', () => this.onClose());
    sock.on('error', (err) => this.emit('error', err));
    if (initial.length) this.onData(initial);
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const { frames, rest } = decodeFrames(this.buf);
    this.buf = rest;
    for (const f of frames) {
      if (f.opcode === 8) { this.close(); return; }
      if (f.opcode === 9) { this.sock.write(encodeFrame(f.payload, { opcode: 10 })); continue; }
      if (f.opcode === 10) continue;
      if (f.opcode === 1 || f.opcode === 0) {
        this.parts.push(f.payload);
        if (f.fin) {
          const text = Buffer.concat(this.parts).toString();
          this.parts = [];
          this.emit('message', text);
        }
      }
    }
  }

  onClose() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }

  send(text) {
    if (!this.open) throw new Error('Verbindung geschlossen');
    this.sock.write(encodeFrame(text));
  }

  close() {
    if (this.open) {
      try { this.sock.write(encodeFrame('', { opcode: 8 })); } catch { /* egal */ }
    }
    this.sock.end();
    this.sock.destroy();
    this.onClose();
  }
}
