// Small dependency-free encoders: animated GIF (EXP-012) and store-only ZIP (EXP-007).

// ---------- GIF ----------

function lzw(pixels: Uint8Array, out: number[]): void {
  const min = 8;
  const clear = 1 << min;
  const eoi = clear + 1;
  let size = min + 1;
  let next = eoi + 1;
  let table = new Map<number, number>();
  let buf = 0;
  let bits = 0;
  let block: number[] = [];
  const flushBlock = () => {
    if (!block.length) return;
    out.push(block.length, ...block);
    block = [];
  };
  const emit = (code: number) => {
    buf |= code << bits;
    bits += size;
    while (bits >= 8) {
      block.push(buf & 255);
      if (block.length === 255) flushBlock();
      buf >>>= 8;
      bits -= 8;
    }
  };
  out.push(min);
  emit(clear);
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const k = pixels[i];
    const key = (prefix << 8) | k;
    const found = table.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      next = eoi + 1;
      size = min + 1;
      table = new Map();
    } else {
      if (next >= 1 << size) size++;
      table.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) block.push(buf & 255);
  flushBlock();
  out.push(0);
}

export class GifWriter {
  private parts: Uint8Array[] = [];
  private palette: Uint8Array | null = null;
  private cache = new Map<number, number>();
  private frame = 0;

  constructor(
    private w: number,
    private h: number,
  ) {}

  // The palette is built from the most common colors of a few sample frames.
  buildPalette(samples: Uint8ClampedArray[]): void {
    const counts = new Map<number, number>();
    for (const data of samples) {
      for (let i = 0; i < data.length; i += 8) {
        const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 256);
    const pal = new Uint8Array(768);
    top.forEach(([key], i) => {
      pal[i * 3] = ((key >> 10) & 31) << 3;
      pal[i * 3 + 1] = ((key >> 5) & 31) << 3;
      pal[i * 3 + 2] = (key & 31) << 3;
    });
    this.palette = pal;
    const head = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, this.w & 255, this.w >> 8, this.h & 255, this.h >> 8, 0xf7, 0, 0];
    const loop = [0x21, 0xff, 0x0b, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0];
    this.parts.push(new Uint8Array(head), pal, new Uint8Array(loop));
  }

  private index(r: number, g: number, b: number): number {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const pal = this.palette!;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < 256; i++) {
      const d = (pal[i * 3] - r) ** 2 + (pal[i * 3 + 1] - g) ** 2 + (pal[i * 3 + 2] - b) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    this.cache.set(key, best);
    return best;
  }

  addFrame(data: Uint8ClampedArray): void {
    const px = new Uint8Array(this.w * this.h);
    for (let i = 0, j = 0; j < px.length; i += 4, j++) px[j] = this.index(data[i], data[i + 1], data[i + 2]);
    // 15 fps is 6.67 hundredths of a second per frame: 7, 7, 6 on repeat.
    const delay = this.frame++ % 3 === 2 ? 6 : 7;
    const out: number[] = [0x21, 0xf9, 4, 0, delay, 0, 0, 0, 0x2c, 0, 0, 0, 0, this.w & 255, this.w >> 8, this.h & 255, this.h >> 8, 0];
    lzw(px, out);
    this.parts.push(new Uint8Array(out));
  }

  get bytes(): number {
    return this.parts.reduce((n, p) => n + p.length, 0);
  }

  finish(): Blob {
    return new Blob([...this.parts, new Uint8Array([0x3b])] as BlobPart[], { type: 'image/gif' });
  }
}

// ---------- ZIP (stored, no compression; PNGs are already compressed) ----------

let crcTable: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function makeZip(files: { name: string; data: Uint8Array }[]): Blob {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, f.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, f.data.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)] as BlobPart[], { type: 'application/zip' });
}
