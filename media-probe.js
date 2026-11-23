/* Akış içinden iz bilgisi ve gömülü altyazı çıkarma (MKV / MP4).
   Video öğesinin indirdiği baytlar ana süreçten geçerken okunur; ek bağlantı açılmaz
   (IPTV hesapları çoğunlukla tek bağlantıya izin verir). */
const zlib = require('zlib');

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
let LATIN_DECODER;
try { LATIN_DECODER = new TextDecoder('windows-1254'); } catch { LATIN_DECODER = new TextDecoder('latin1'); }

function decodeText(buf) {
  try { return TEXT_DECODER.decode(buf); } catch { return LATIN_DECODER.decode(buf); }
}

/* ---------- Altyazı metni temizleme → WebVTT cue metni ---------- */
function escVtt(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// SRT: <i>/<b>/<u> korunur, diğer etiketler ve {\an8} gibi ASS kalıntıları atılır
function srtToCue(text) {
  const s = String(text).replace(/\r/g, '').replace(/\{\\[^}]*\}/g, '').trim();
  const parts = s.split(/(<\/?[a-zA-Z][^>]*>)/);
  return parts.map((p) => {
    if (/^<br\s*\/?>$/i.test(p)) return '\n';
    const m = p.match(/^<(\/?)([ibu])\b[^>]*>$/i);
    if (m) return `<${m[1]}${m[2].toLowerCase()}>`;
    if (/^<\/?[a-zA-Z][^>]*>$/.test(p)) return '';
    return escVtt(p);
  }).join('').trim();
}

// ASS/SSA olay satırı: ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text
function assToCue(line, fieldCount = 9) {
  const parts = String(line).split(',');
  const text = parts.length >= fieldCount ? parts.slice(fieldCount - 1).join(',') : parts[parts.length - 1];
  let out = '';
  let italic = false;
  for (const seg of text.split(/(\{[^}]*\})/)) {
    if (seg.startsWith('{')) {
      const i = seg.match(/\\i([01])/);
      if (i) {
        const on = i[1] === '1';
        if (on && !italic) out += '<i>';
        if (!on && italic) out += '</i>';
        italic = on;
      }
      continue;
    }
    out += escVtt(seg.replace(/\\N/gi, '\n').replace(/\\h/g, ' '));
  }
  if (italic) out += '</i>';
  return out.trim();
}

/* ---------- Kodek adları ---------- */
const MKV_CODECS = [
  [/^V_MPEG4\/ISO\/AVC/, 'H.264', true], [/^V_MPEGH\/ISO\/HEVC/, 'HEVC', true], [/^V_AV1/, 'AV1', true],
  [/^V_VP9/, 'VP9', true], [/^V_VP8/, 'VP8', true], [/^V_MPEG4\/ISO/, 'MPEG-4', false], [/^V_MPEG(1|2)/, 'MPEG-2', false],
  [/^A_AAC/, 'AAC', true], [/^A_MPEG\/L3/, 'MP3', true], [/^A_OPUS/, 'Opus', true], [/^A_VORBIS/, 'Vorbis', true],
  [/^A_FLAC/, 'FLAC', true], [/^A_PCM/, 'PCM', true], [/^A_EAC3/, 'E-AC3', false], [/^A_AC3/, 'AC3', false],
  [/^A_DTS/, 'DTS', false], [/^A_TRUEHD/, 'TrueHD', false], [/^A_MPEG\/L2/, 'MP2', false],
  [/^S_TEXT\/UTF8/, 'SRT', true], [/^S_TEXT\/ASCII/, 'SRT', true], [/^S_TEXT\/(ASS|SSA)/, 'ASS', true], [/^S_(ASS|SSA)/, 'ASS', true],
  [/^S_TEXT\/WEBVTT/, 'WebVTT', true], [/^S_HDMV\/PGS/, 'PGS', false], [/^S_VOBSUB/, 'VobSub', false], [/^S_DVBSUB/, 'DVB', false],
];

function mkvCodec(id) {
  for (const [re, name, ok] of MKV_CODECS) if (re.test(id || '')) return { codec: name, supported: ok };
  return { codec: String(id || '?').replace(/^[VAS]_/, ''), supported: false };
}

const MP4_CODECS = {
  avc1: ['H.264', true], avc3: ['H.264', true], hvc1: ['HEVC', true], hev1: ['HEVC', true], av01: ['AV1', true], vp09: ['VP9', true],
  mp4v: ['MPEG-4', false], mp4a: ['AAC', true], '.mp3': ['MP3', true], Opus: ['Opus', true], fLaC: ['FLAC', true],
  'ac-3': ['AC3', false], 'ec-3': ['E-AC3', false], dtsc: ['DTS', false], dtsh: ['DTS', false], dtsl: ['DTS', false], dtse: ['DTS', false],
  mlpa: ['TrueHD', false], alac: ['ALAC', false], lpcm: ['PCM', true], sowt: ['PCM', true], twos: ['PCM', true],
  tx3g: ['MP4 Text', true], wvtt: ['WebVTT', true], stpp: ['TTML', false], c608: ['CEA-608', false],
};

/* =========================================================
   MKV (Matroska / WebM)
   ========================================================= */
const ID = {
  EBML: 0x1a45dfa3, SEGMENT: 0x18538067, INFO: 0x1549a966, TIMECODESCALE: 0x2ad7b1, TRACKS: 0x1654ae6b,
  CLUSTER: 0x1f43b675, TIMECODE: 0xe7, SIMPLEBLOCK: 0xa3, BLOCKGROUP: 0xa0, BLOCK: 0xa1, BLOCKDURATION: 0x9b,
  TRACKENTRY: 0xae, TRACKNUMBER: 0xd7, TRACKTYPE: 0x83, CODECID: 0x86, CODECPRIVATE: 0x63a2, LANGUAGE: 0x22b59c,
  LANGUAGEBCP47: 0x22b59d, NAME: 0x536e, FLAGDEFAULT: 0x88, FLAGFORCED: 0x55aa, VIDEO: 0xe0, AUDIO: 0xe1,
  PIXELWIDTH: 0xb0, PIXELHEIGHT: 0xba, CHANNELS: 0x9f, DEFAULTDURATION: 0x23e383,
  CONTENTENCODINGS: 0x6d80, CONTENTENCODING: 0x6240, CONTENTCOMPRESSION: 0x5034, COMPALGO: 0x4254, COMPSETTINGS: 0x4255,
};

// EBML değişken uzunluklu tamsayı. { value, len } | null (veri yetersiz) | { bad: true }
function readVint(buf, pos, keepMarker) {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  if (!first) return { bad: true };
  let len = 1;
  while (!(first & (0x80 >> (len - 1)))) len++;
  if (len > 8) return { bad: true };
  if (pos + len > buf.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  let allOnes = value === (0xff >> len);
  for (let i = 1; i < len; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

function readHeader(buf, pos) {
  const id = readVint(buf, pos, true);
  if (!id) return null;
  if (id.bad || id.len > 4) return { bad: true };
  const size = readVint(buf, pos + id.len, false);
  if (!size) return null;
  if (size.bad) return { bad: true };
  return { id: id.value, size: size.unknown ? -1 : size.value, hlen: id.len + size.len };
}

function readUint(buf) {
  let v = 0;
  for (const b of buf) v = v * 256 + b;
  return v;
}

function readFloat(buf) {
  if (buf.length === 4) return buf.readFloatBE(0);
  if (buf.length === 8) return buf.readDoubleBE(0);
  return 0;
}

// Tamamı bellekteki bir ana öğenin çocuklarını dolaş
function* children(buf) {
  let p = 0;
  while (p < buf.length) {
    const h = readHeader(buf, p);
    if (!h || h.bad || h.size < 0) return;
    const start = p + h.hlen;
    yield { id: h.id, data: buf.subarray(start, Math.min(buf.length, start + h.size)) };
    p = start + h.size;
  }
}

function parseMkvTracks(buf) {
  const tracks = [];
  for (const el of children(buf)) {
    if (el.id !== ID.TRACKENTRY) continue;
    const t = { lang: 'eng', name: '', default: true, forced: false };
    for (const c of children(el.data)) {
      switch (c.id) {
        case ID.TRACKNUMBER: t.number = readUint(c.data); break;
        case ID.TRACKTYPE: t.mkvType = readUint(c.data); break;
        case ID.CODECID: t.codecId = c.data.toString('latin1').replace(/\0+$/, ''); break;
        case ID.CODECPRIVATE: t.priv = Buffer.from(c.data); break;
        case ID.LANGUAGE: t.lang = c.data.toString('latin1').replace(/\0+$/, ''); break;
        case ID.LANGUAGEBCP47: t.bcp47 = c.data.toString('latin1').replace(/\0+$/, ''); break;
        case ID.NAME: t.name = decodeText(c.data).replace(/\0+$/, ''); break;
        case ID.FLAGDEFAULT: t.default = !!readUint(c.data); break;
        case ID.FLAGFORCED: t.forced = !!readUint(c.data); break;
        case ID.DEFAULTDURATION: t.defaultDuration = readUint(c.data); break;
        case ID.VIDEO:
          for (const v of children(c.data)) {
            if (v.id === ID.PIXELWIDTH) t.width = readUint(v.data);
            if (v.id === ID.PIXELHEIGHT) t.height = readUint(v.data);
          }
          break;
        case ID.AUDIO:
          for (const a of children(c.data)) if (a.id === ID.CHANNELS) t.channels = readUint(a.data);
          break;
        case ID.CONTENTENCODINGS:
          for (const enc of children(c.data)) {
            if (enc.id !== ID.CONTENTENCODING) continue;
            for (const comp of children(enc.data)) {
              if (comp.id !== ID.CONTENTCOMPRESSION) continue;
              t.comp = { algo: 0 };
              for (const x of children(comp.data)) {
                if (x.id === ID.COMPALGO) t.comp.algo = readUint(x.data);
                if (x.id === ID.COMPSETTINGS) t.comp.settings = Buffer.from(x.data);
              }
            }
          }
          break;
      }
    }
    tracks.push(t);
  }
  return tracks;
}

/* =========================================================
   Oturum: bir video adresi için iz listesi + çıkarılan altyazılar
   ========================================================= */
class MediaSession {
  constructor(emit) {
    this.emit = emit;
    this.kind = null; // 'mkv' | 'mp4'
    this.tracks = null; // dışa verilen iz listesi
    this.mkv = { scale: 1e6, byNumber: new Map() };
    this.mp4 = null; // { samples: [...] }
    this.pre = []; // MP4'te moov'dan önce geçen baytlar (sona yazılmış moov için)
    this.preBytes = 0;
    this.seen = new Map(); // izIndex → Set(anahtar)
    this.pending = [];
    this.flushTimer = null;
  }

  // Her HTTP isteği için ayrı okuyucu
  reader(start) {
    return new StreamReader(this, start);
  }

  setTracks(list) {
    this.tracks = list;
    this.emit({ type: 'tracks', tracks: list.map(({ priv, comp, number, mkvType, ...t }) => t) });
  }

  addCue(index, start, end, text) {
    if (!text || !(end > start)) return;
    let set = this.seen.get(index);
    if (!set) this.seen.set(index, (set = new Set()));
    const key = `${start.toFixed(3)}|${text}`;
    if (set.has(key)) return;
    set.add(key);
    this.pending.push([index, +start.toFixed(3), +end.toFixed(3), text]);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    this.flushTimer = null;
    if (!this.pending.length) return;
    const cues = this.pending;
    this.pending = [];
    this.emit({ type: 'cues', cues });
  }

  /* ---------- MKV ---------- */
  onMkvTracks(raw) {
    const out = [];
    raw.forEach((t, i) => {
      const type = t.mkvType === 1 ? 'video' : t.mkvType === 2 ? 'audio' : t.mkvType === 17 ? 'sub' : 'other';
      const { codec, supported } = mkvCodec(t.codecId);
      t.index = i;
      t.type = type;
      t.text = type === 'sub' && supported;
      if (t.text && /ASS|SSA/.test(t.codecId)) {
        // [Events] Format satırından alan sayısını öğren (ReadOrder dahil)
        const events = t.priv ? decodeText(t.priv).split(/\[Events\]/i)[1] : '';
        const fmt = events ? events.match(/^Format:\s*(.+)$/im) : null;
        t.assFields = fmt ? fmt[1].split(',').length + 1 - (/(^|,)\s*Start\s*(,|$)/i.test(fmt[1]) ? 2 : 0) : 9;
      }
      this.mkv.byNumber.set(t.number, t);
      out.push({
        index: i, type, codec, supported, text: t.text,
        lang: t.bcp47 || t.lang || '', name: t.name || '', default: t.default, forced: t.forced,
        channels: t.channels, width: t.width, height: t.height, priv: t.priv, comp: t.comp, number: t.number, mkvType: t.mkvType,
      });
    });
    this.setTracks(out);
  }

  mkvBlock(trackNo, tc, data, dur) {
    const t = this.mkv.byNumber.get(trackNo);
    if (!t || !t.text) return;
    let payload = data;
    try {
      if (t.comp) {
        if (t.comp.algo === 0) payload = zlib.inflateSync(payload);
        else if (t.comp.algo === 3 && t.comp.settings) payload = Buffer.concat([t.comp.settings, payload]);
        else return;
      }
    } catch { return; }
    const scale = this.mkv.scale / 1e9;
    const start = tc * scale;
    const len = dur != null ? dur * scale : t.defaultDuration ? t.defaultDuration / 1e9 : 4;
    const raw = decodeText(payload).replace(/\0+$/, '');
    const text = /ASS/.test(mkvCodec(t.codecId).codec) ? assToCue(raw, t.assFields) : srtToCue(raw);
    this.addCue(t.index, start, start + Math.min(len, 120), text);
  }

  /* ---------- MP4 ---------- */
  onMoov(buf) {
    if (this.mp4) return;
    const info = parseMoov(buf);
    if (!info) return;
    this.kind = 'mp4';
    this.mp4 = info;
    this.setTracks(info.tracks);
    // moov'dan önce geçmiş baytlardaki altyazıları şimdi çıkar
    const st = {};
    for (const { off, buf: b } of this.pre) this.extractMp4(off, b, st);
    this.pre = [];
    this.preBytes = 0;
  }

  // Bir veri parçasındaki tamamlanmış altyazı örneklerini çöz. carry: istek başına taşınan yarım örnek
  extractMp4(off, chunk, state) {
    if (!this.mp4) {
      if (this.preBytes < 32 * 1024 * 1024) {
        this.pre.push({ off, buf: Buffer.from(chunk) });
        this.preBytes += chunk.length;
      }
      return;
    }
    const s = this.mp4.samples;
    if (!s.length) return;
    let base = off;
    let data = chunk;
    if (state && state.carry && state.carryEnd === off) {
      data = Buffer.concat([state.carry, chunk]);
      base = state.carryStart;
    }
    if (state) state.carry = null;
    const end = base + data.length;
    // ilk aday örnek (ikili arama)
    let lo = 0, hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid].off + s[mid].size <= base) lo = mid + 1; else hi = mid;
    }
    for (let i = lo; i < s.length && s[i].off < end; i++) {
      const x = s[i];
      if (x.off < base) continue; // başı bu parçada değil
      if (x.off + x.size > end) {
        if (state && x.size < 1024 * 1024) {
          state.carry = Buffer.from(data.subarray(x.off - base));
          state.carryStart = x.off;
          state.carryEnd = end;
        }
        break;
      }
      const sample = data.subarray(x.off - base, x.off - base + x.size);
      const text = decodeMp4Sample(sample, x.fmt);
      if (text) this.addCue(x.track, x.start, x.end, text);
    }
  }
}

/* ---------- MP4 kutu ayrıştırma ---------- */
function* boxes(buf, start = 0, end = buf.length) {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let hlen = 8;
    if (size === 1) {
      if (p + 16 > end) return;
      size = Number(buf.readBigUInt64BE(p + 8));
      hlen = 16;
    } else if (size === 0) size = end - p;
    if (size < hlen || p + size > end) return;
    yield { type, start: p + hlen, end: p + size };
    p += size;
  }
}

function child(buf, box, type) {
  for (const b of boxes(buf, box.start, box.end)) if (b.type === type) return b;
  return null;
}

function path(buf, box, ...types) {
  let cur = box;
  for (const t of types) {
    cur = cur && child(buf, cur, t);
    if (!cur) return null;
  }
  return cur;
}

function mp4Lang(code) {
  if (!code || code === 0x7fff) return 'und';
  return String.fromCharCode(((code >> 10) & 31) + 0x60, ((code >> 5) & 31) + 0x60, (code & 31) + 0x60);
}

function parseMoov(buf) {
  const moov = { start: 0, end: buf.length };
  const tracks = [];
  const samples = [];
  let index = 0;
  for (const trak of boxes(buf, moov.start, moov.end)) {
    if (trak.type !== 'trak') continue;
    const i = index++;
    const mdia = child(buf, trak, 'mdia');
    if (!mdia) { tracks.push({ index: i, type: 'other', codec: '?', supported: false }); continue; }
    const mdhd = child(buf, mdia, 'mdhd');
    const hdlr = child(buf, mdia, 'hdlr');
    const stbl = path(buf, mdia, 'minf', 'stbl');
    let timescale = 1000, lang = 'und';
    if (mdhd) {
      const v = buf[mdhd.start];
      timescale = buf.readUInt32BE(mdhd.start + (v === 1 ? 20 : 12));
      lang = mp4Lang(buf.readUInt16BE(mdhd.start + (v === 1 ? 32 : 20)));
    }
    const handler = hdlr ? buf.toString('latin1', hdlr.start + 8, hdlr.start + 12) : '';
    let name = hdlr ? buf.toString('utf8', hdlr.start + 24, hdlr.end).replace(/\0[\s\S]*$/, '').trim() : '';
    if (/handler$/i.test(name) || /^(core media|mainconcept|apple)/i.test(name)) name = '';
    const type = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : /^(sbtl|text|subt|clcp)$/.test(handler) ? 'sub' : 'other';
    const t = { index: i, type, codec: '?', supported: false, text: false, lang, name, default: true, forced: false };
    const stsd = stbl && child(buf, stbl, 'stsd');
    if (stsd) {
      const entry = boxes(buf, stsd.start + 8, stsd.end).next().value;
      if (entry) {
        const [codec, ok] = MP4_CODECS[entry.type] || [entry.type, false];
        t.codec = codec;
        t.supported = ok;
        t.fmt = entry.type;
        if (type === 'audio' && entry.end - entry.start >= 18) t.channels = buf.readUInt16BE(entry.start + 16);
        if (type === 'video' && entry.end - entry.start >= 28) { t.width = buf.readUInt16BE(entry.start + 24); t.height = buf.readUInt16BE(entry.start + 26); }
      }
    }
    t.text = type === 'sub' && (t.fmt === 'tx3g' || t.fmt === 'wvtt');
    if (t.text && stbl) collectSamples(buf, stbl, timescale, i, t.fmt, samples);
    delete t.fmt;
    tracks.push(t);
  }
  if (!index) return null;
  samples.sort((a, b) => a.off - b.off);
  return { tracks, samples };
}

function collectSamples(buf, stbl, timescale, track, fmt, out) {
  const get = (t) => child(buf, stbl, t);
  const stts = get('stts'), stsc = get('stsc'), stsz = get('stsz');
  const stco = get('stco'), co64 = get('co64');
  if (!stts || !stsc || !stsz || (!stco && !co64)) return;
  // örnek boyutları
  const fixed = buf.readUInt32BE(stsz.start + 4);
  const count = buf.readUInt32BE(stsz.start + 8);
  if (count > 2e6) return;
  const size = (k) => (fixed ? fixed : buf.readUInt32BE(stsz.start + 12 + k * 4));
  // parça (chunk) ofsetleri
  const chunkOff = [];
  if (stco) {
    const n = buf.readUInt32BE(stco.start + 4);
    for (let k = 0; k < n; k++) chunkOff.push(buf.readUInt32BE(stco.start + 8 + k * 4));
  } else {
    const n = buf.readUInt32BE(co64.start + 4);
    for (let k = 0; k < n; k++) chunkOff.push(Number(buf.readBigUInt64BE(co64.start + 8 + k * 8)));
  }
  // zamanlar
  const times = [];
  let t = 0;
  const nStts = buf.readUInt32BE(stts.start + 4);
  for (let k = 0; k < nStts && times.length < count; k++) {
    const c = buf.readUInt32BE(stts.start + 8 + k * 8);
    const d = buf.readUInt32BE(stts.start + 12 + k * 8);
    for (let j = 0; j < c && times.length < count; j++) { times.push([t, d]); t += d; }
  }
  // örnek → parça eşlemesi
  const nStsc = buf.readUInt32BE(stsc.start + 4);
  const entries = [];
  for (let k = 0; k < nStsc; k++) {
    const p = stsc.start + 8 + k * 12;
    entries.push([buf.readUInt32BE(p), buf.readUInt32BE(p + 4)]);
  }
  let sample = 0;
  for (let e = 0; e < entries.length && sample < count; e++) {
    const [first, per] = entries[e];
    const last = e + 1 < entries.length ? entries[e + 1][0] - 1 : chunkOff.length;
    for (let c = first; c <= last && sample < count; c++) {
      let off = chunkOff[c - 1];
      if (off == null) return;
      for (let j = 0; j < per && sample < count; j++, sample++) {
        const sz = size(sample);
        const [st, du] = times[sample] || [0, 0];
        if (sz > 2) out.push({ off, size: sz, start: st / timescale, end: (st + du) / timescale, track, fmt });
        off += sz;
      }
    }
  }
}

function decodeMp4Sample(b, fmt) {
  if (fmt === 'tx3g') {
    if (b.length < 2) return '';
    const len = b.readUInt16BE(0);
    if (!len || len + 2 > b.length) return '';
    const raw = b.subarray(2, 2 + len);
    const text = raw[0] === 0xfe && raw[1] === 0xff ? new TextDecoder('utf-16be').decode(raw.subarray(2)) : decodeText(raw);
    return srtToCue(text);
  }
  if (fmt === 'wvtt') {
    const lines = [];
    for (const box of boxes(b)) {
      if (box.type !== 'vttc') continue;
      for (const c of boxes(b, box.start, box.end)) if (c.type === 'payl') lines.push(b.toString('utf8', c.start, c.end));
    }
    return lines.map(srtToCue).join('\n');
  }
  return '';
}

/* =========================================================
   İstek başına akış okuyucu
   ========================================================= */
const CLUSTER_SIG = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);

class StreamReader {
  constructor(session, start) {
    this.s = session;
    this.pos = start; // buf[0]'ın mutlak ofseti
    this.buf = Buffer.alloc(0);
    this.skip = 0;
    this.done = false;
    this.mp4State = {};
    // Konteyner henüz bilinmiyorsa ve istek baştan başlıyorsa imzadan anla
    this.mode = session.kind;
    this.synced = start === 0;
    this.cluster = null;
    this.group = null;
  }

  push(chunk) {
    if (this.done || !chunk || !chunk.length) return;
    try {
      this.handle(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    } catch {
      this.done = true; // ayrıştırma hatası oynatmayı asla etkilemesin
    }
  }

  handle(chunk) {
    const off = this.pos + this.buf.length;
    if (!this.mode) {
      // ilk baytlardan konteyneri belirle
      const head = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      if (head.length < 12) { this.buf = head; return; }
      if (this.pos === 0 && head.readUInt32BE(0) === ID.EBML) this.mode = this.s.kind = 'mkv';
      else if (this.pos === 0 && /^(ftyp|moov|free|mdat|wide|skip|pnot)$/.test(head.toString('latin1', 4, 8))) this.mode = this.s.kind = 'mp4';
      else if (this.pos !== 0) this.mode = 'unknown';
      else { this.done = true; return; }
      this.buf = Buffer.alloc(0);
      return this.handle(head);
    }
    if (this.mode === 'unknown') {
      if (this.s.kind) { this.mode = this.s.kind; } else { this.pos += this.buf.length + chunk.length; this.buf = Buffer.alloc(0); return; }
    }
    if (this.mode === 'mp4') return this.handleMp4(off, chunk);
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this.parseMkv();
  }

  consume(n) {
    this.buf = this.buf.subarray(n);
    this.pos += n;
  }

  /* ---------- MKV ---------- */
  parseMkv() {
    const s = this.s;
    for (let guard = 0; guard < 1e6; guard++) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, this.buf.length);
        this.consume(n);
        this.skip -= n;
        if (this.skip > 0) return;
      }
      if (!this.synced) {
        if (!this.resync()) return;
      }
      if (this.group && this.group.end >= 0 && this.pos >= this.group.end) this.flushGroup();
      if (this.buf.length < 2) return;
      const h = readHeader(this.buf, 0);
      if (!h) return;
      if (h.bad) { this.synced = false; this.consume(1); continue; }
      const total = h.size < 0 ? -1 : h.hlen + h.size;
      switch (h.id) {
        case ID.SEGMENT:
        case ID.INFO:
          this.consume(h.hlen);
          continue;
        case ID.CLUSTER:
          this.flushGroup();
          this.consume(h.hlen);
          this.cluster = { tc: null };
          continue;
        case ID.BLOCKGROUP:
          this.flushGroup();
          this.consume(h.hlen);
          this.group = { end: h.size < 0 ? -1 : this.pos + h.size, block: null, dur: null };
          continue;
        case ID.TRACKS:
        case ID.TIMECODESCALE:
        case ID.TIMECODE:
        case ID.BLOCKDURATION: {
          if (total < 0 || total > 16 * 1024 * 1024) { this.synced = false; this.consume(1); continue; }
          if (this.buf.length < total) return;
          const data = this.buf.subarray(h.hlen, total);
          if (h.id === ID.TRACKS) { if (!s.tracks) s.onMkvTracks(parseMkvTracks(data)); }
          else if (h.id === ID.TIMECODESCALE) s.mkv.scale = readUint(data) || 1e6;
          else if (h.id === ID.TIMECODE) { if (this.cluster) this.cluster.tc = readUint(data); }
          else if (this.group) this.group.dur = readUint(data);
          this.consume(total);
          continue;
        }
        case ID.SIMPLEBLOCK:
        case ID.BLOCK: {
          if (total < 0) { this.synced = false; this.consume(1); continue; }
          const tn = readVint(this.buf, h.hlen, false);
          if (!tn) return;
          if (tn.bad) { const n = Math.min(total, this.buf.length); this.consume(n); this.skip = total - n; continue; }
          const t = s.mkv.byNumber.get(tn.value);
          if (!t || !t.text || h.size > 1024 * 1024 || !this.cluster || this.cluster.tc == null) {
            this.consume(h.hlen);
            this.skip = h.size;
            continue;
          }
          if (this.buf.length < total) return;
          const p = h.hlen + tn.len;
          const rel = this.buf.readInt16BE(p);
          const flags = this.buf[p + 2];
          const data = Buffer.from(this.buf.subarray(p + 3, total));
          const tc = this.cluster.tc + rel;
          this.consume(total);
          if (flags & 0x06) continue; // lacing — altyazılarda kullanılmaz
          if (h.id === ID.BLOCK && this.group) this.group.block = { tn: tn.value, tc, data };
          else s.mkvBlock(tn.value, tc, data, null);
          continue;
        }
        default:
          if (h.size < 0) { this.synced = false; this.consume(1); continue; }
          this.consume(Math.min(h.hlen, this.buf.length));
          this.skip = h.size;
      }
    }
  }

  flushGroup() {
    const g = this.group;
    this.group = null;
    if (g && g.block) this.s.mkvBlock(g.block.tn, g.block.tc, g.block.data, g.dur);
  }

  // İstek ortadan başladıysa bir sonraki Cluster başlangıcını bul
  resync() {
    for (;;) {
      const i = this.buf.indexOf(CLUSTER_SIG);
      if (i < 0) {
        const keep = Math.min(3, this.buf.length);
        this.consume(this.buf.length - keep);
        return false;
      }
      this.consume(i);
      if (this.buf.length < 32) return false;
      const h = readHeader(this.buf, 0);
      if (h && !h.bad) {
        let p = h.hlen;
        let c = readHeader(this.buf, p);
        if (c && !c.bad && c.id === 0xbf && c.size >= 0) { p += c.hlen + c.size; c = readHeader(this.buf, p); } // CRC-32
        if (c && !c.bad && c.id === ID.TIMECODE && c.size > 0 && c.size <= 8) {
          this.synced = true;
          this.group = null;
          return true;
        }
      }
      this.consume(1);
    }
  }

  /* ---------- MP4 ---------- */
  handleMp4(off, chunk) {
    const s = this.s;
    s.extractMp4(off, chunk, this.mp4State);
    if (s.mp4) { this.buf = Buffer.alloc(0); this.pos = off + chunk.length; return; }
    // moov'u bul: baştan gelen istekte kutuları sırayla, ortadan gelende imzayla
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (let guard = 0; guard < 1e5 && !s.mp4; guard++) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, this.buf.length);
        this.consume(n);
        this.skip -= n;
        if (this.skip > 0) return;
      }
      if (!this.synced) {
        const i = this.buf.indexOf('moov', 4, 'latin1');
        if (i < 0) { this.consume(Math.max(0, this.buf.length - 8)); return; }
        if (this.buf.length < i + 12) { this.consume(i - 4); return; }
        if (this.buf.toString('latin1', i + 8, i + 12) !== 'mvhd') { this.consume(i + 1); continue; }
        this.consume(i - 4);
        this.synced = true;
      }
      if (this.buf.length < 16) return;
      let size = this.buf.readUInt32BE(0);
      const type = this.buf.toString('latin1', 4, 8);
      let hlen = 8;
      if (size === 1) { size = Number(this.buf.readBigUInt64BE(8)); hlen = 16; }
      if (!/^[\x20-\x7e]{4}$/.test(type) || (size !== 0 && size < hlen)) { this.done = true; return; }
      if (type === 'moov') {
        if (size === 0 || size > 128 * 1024 * 1024) { this.done = true; return; }
        if (this.buf.length < size) return;
        s.onMoov(Buffer.from(this.buf.subarray(hlen, size)));
        this.consume(size);
        continue;
      }
      if (size === 0) { this.done = true; return; }
      this.consume(Math.min(hlen, this.buf.length));
      this.skip = size - hlen;
    }
  }
}

module.exports = { MediaSession, srtToCue, assToCue };
