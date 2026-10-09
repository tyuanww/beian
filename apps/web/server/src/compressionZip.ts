import { closeSync, openSync, readSync } from "node:fs";
import { Readable } from "node:stream";

type ZipEntry = { name: string; path: string };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    table[index] = crc >>> 0;
  }
  return table;
})();

function crc32Update(crc: number, chunk: Buffer): number {
  let next = crc;
  for (const byte of chunk) next = CRC_TABLE[(next ^ byte) & 0xff] ^ (next >>> 8);
  return next >>> 0;
}

function dosTime(date: Date): { time: number; day: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function u16(target: Buffer, offset: number, value: number): void {
  target.writeUInt16LE(value & 0xffff, offset);
}

function u32(target: Buffer, offset: number, value: number): void {
  target.writeUInt32LE(value >>> 0, offset);
}

/**
 * STORE 方式按 64 KiB 流式写出，并用 data descriptor 回填 CRC。
 * 不把整个 ZIP 或单个原件读进一个缓冲区。调用方必须保证至少有一个条目。
 */
export function compressionZipStream(entries: readonly ZipEntry[]): Readable {
  if (!entries.length) throw new Error("不会生成空的压缩包");
  const clock = dosTime(new Date());
  return Readable.from(generate(entries, clock.time, clock.day));
}

async function* generate(entries: readonly ZipEntry[], time: number, day: number): AsyncGenerator<Buffer> {
  const central: Buffer[] = [];
  let offset = 0;
  const chunk = Buffer.alloc(64 * 1024);
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    u32(local, 0, 0x04034b50);
    u16(local, 4, 20);
    u16(local, 6, 0x0008);
    u16(local, 8, 0);
    u16(local, 10, time);
    u16(local, 12, day);
    u32(local, 14, 0);
    u32(local, 18, 0);
    u32(local, 22, 0);
    u16(local, 26, name.length);
    u16(local, 28, 0);
    const localOffset = offset;
    yield Buffer.concat([local, name]);
    offset += local.length + name.length;
    let crc = 0xffffffff;
    let size = 0;
    const fd = openSync(entry.path, "r");
    try {
      for (;;) {
        const read = readSync(fd, chunk, 0, chunk.length, null);
        if (read <= 0) break;
        const piece = Buffer.from(chunk.subarray(0, read));
        crc = crc32Update(crc, piece);
        size += read;
        yield piece;
      }
    } finally {
      closeSync(fd);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    offset += size;
    const descriptor = Buffer.alloc(16);
    u32(descriptor, 0, 0x08074b50);
    u32(descriptor, 4, crc);
    u32(descriptor, 8, size);
    u32(descriptor, 12, size);
    yield descriptor;
    offset += descriptor.length;
    const header = Buffer.alloc(46);
    u32(header, 0, 0x02014b50);
    u16(header, 4, 20);
    u16(header, 6, 20);
    u16(header, 8, 0x0008);
    u16(header, 10, 0);
    u16(header, 12, time);
    u16(header, 14, day);
    u32(header, 16, crc);
    u32(header, 20, size);
    u32(header, 24, size);
    u16(header, 28, name.length);
    u16(header, 30, 0);
    u16(header, 32, 0);
    u16(header, 34, 0);
    u16(header, 36, 0);
    u32(header, 38, 0);
    u32(header, 42, localOffset);
    central.push(Buffer.concat([header, name]));
  }
  const centralBytes = Buffer.concat(central);
  const directoryOffset = offset;
  yield centralBytes;
  const end = Buffer.alloc(22);
  u32(end, 0, 0x06054b50);
  u16(end, 4, 0);
  u16(end, 6, 0);
  u16(end, 8, entries.length);
  u16(end, 10, entries.length);
  u32(end, 12, centralBytes.length);
  u32(end, 16, directoryOffset);
  u16(end, 20, 0);
  yield end;
}
