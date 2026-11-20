import { inflateRawSync } from "node:zlib";

// Just enough of the ZIP format to read the files Tidysum downloads (the SEC's data sets and the
// CFPB's .xlsx survey): the central directory, then each wanted entry, stored or deflated. No
// ZIP64, encryption or multi-disk archives; those are refused, never guessed at.

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function entries(zip: Buffer): Entry[] {
  // The end-of-central-directory record sits in the last 64 KiB + 22 bytes (it ends in a comment).
  const floor = Math.max(0, zip.length - 65_557);
  let eocd = -1;
  for (let i = zip.length - 22; i >= floor; i--) {
    if (zip.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error("zip64 archives aren't supported");
  const out: Entry[] = [];
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(at) !== CENTRAL) throw new Error("corrupt zip central directory");
    const flags = zip.readUInt16LE(at + 8);
    if (flags & 1) throw new Error("encrypted zip entries aren't supported");
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    out.push({
      method: zip.readUInt16LE(at + 10),
      compressedSize: zip.readUInt32LE(at + 20),
      size: zip.readUInt32LE(at + 24),
      localOffset: zip.readUInt32LE(at + 42),
      name: zip.toString("utf8", at + 46, at + 46 + nameLength),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/** The names of the files in a zip archive. */
export function zipNames(zip: Buffer): string[] {
  return entries(zip).map((e) => e.name);
}

/** One file from a zip archive, or undefined when it has no such file. */
export function unzipFile(zip: Buffer, name: string): Buffer | undefined {
  const e = entries(zip).find((x) => x.name === name);
  if (!e) return undefined;
  if (zip.readUInt32LE(e.localOffset) !== LOCAL) throw new Error(`corrupt zip entry ${name}`);
  const start =
    e.localOffset +
    30 +
    zip.readUInt16LE(e.localOffset + 26) +
    zip.readUInt16LE(e.localOffset + 28);
  const data = zip.subarray(start, start + e.compressedSize);
  const out =
    e.method === 0
      ? Buffer.from(data)
      : e.method === 8
        ? inflateRawSync(data)
        : (() => {
            throw new Error(`zip entry ${name} uses unsupported compression ${e.method}`);
          })();
  if (out.length !== e.size) throw new Error(`zip entry ${name} is truncated`);
  return out;
}
