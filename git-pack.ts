// Packfile read/write for the git smart-HTTP forge. Node 22 stdlib only (node:zlib).
// No deltas on write (plain objects); full delta support on read (OFS + REF).

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import { objectId, type ObjType } from './git-objects.ts';

export const TYPE_COMMIT = 1;
export const TYPE_TREE = 2;
export const TYPE_BLOB = 3;
export const TYPE_TAG = 4;
export const TYPE_OFS_DELTA = 6;
export const TYPE_REF_DELTA = 7;

const TYPE_TO_NAME: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const NAME_TO_TYPE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export interface ParsedPackObject {
  type: ObjType;
  /** Full framed bytes ("type len\0payload"). */
  bytes: Buffer;
  sha: string;
}

/** Parse one varint size from a pack object header; returns [value, bytesRead]. */
function readVarint(buf: Buffer, off: number): [number, number] {
  // First byte: bit 7 = continue, bits 6-4 = type, bits 3-0 = size low 4 bits.
  let value = buf[off] & 0x0f;
  let shift = 4;
  let i = off;
  let b = buf[i++];
  while (b & 0x80) {
    b = buf[i++];
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return [value, i - off];
}

function readOfsOffset(buf: Buffer, off: number): [number, number] {
  let byte = buf[off];
  let offset = byte & 0x7f;
  let i = off + 1;
  while (byte & 0x80) {
    byte = buf[i];
    offset = ((offset + 1) << 7) | (byte & 0x7f);
    i += 1;
  }
  return [offset, i - off];
}

/** Apply a git delta (base -> result). Throws on malformed delta. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++];
      value |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return value;
  };
  const baseSize = readDeltaVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} != ${base.length}`);
  const resultSize = readDeltaVarint();
  const chunks: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) cpOff = delta[off++];
      if (op & 0x02) cpOff |= delta[off++] << 8;
      if (op & 0x04) cpOff |= delta[off++] << 16;
      if (op & 0x08) cpOff |= delta[off++] << 24;
      if (op & 0x10) cpSize = delta[off++];
      if (op & 0x20) cpSize |= delta[off++] << 8;
      if (op & 0x40) cpSize |= delta[off++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      chunks.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op !== 0) {
      chunks.push(delta.subarray(off, off + op));
      off += op;
      total += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  if (total !== resultSize) throw new Error(`delta result size ${total} != ${resultSize}`);
  return Buffer.concat(chunks, total);
}

/**
 * Inflate exactly one zlib stream starting at `off`. Node's inflateSync ignores trailing
 * bytes, so the smallest end that inflates to the same data is the true stream end.
 */
function inflateOne(pack: Buffer, off: number): { data: Buffer; consumed: number } {
  const max = pack.length;
  let hi = Math.min(max, off + 16);
  let data: Buffer | null = null;
  while (hi <= max) {
    try {
      data = inflateSync(pack.subarray(off, hi));
      break;
    } catch {
      if (hi === max) throw new Error('zlib inflate failed');
      hi = Math.min(max, hi * 2);
    }
  }
  if (data === null) throw new Error('zlib inflate failed');
  // Tighten to the smallest end producing the same data.
  let lo = off + 2;
  let end = hi;
  while (lo < end) {
    const mid = (lo + end) >> 1;
    try {
      const d = inflateSync(pack.subarray(off, mid));
      if (d.equals(data)) {
        end = mid;
        continue;
      }
    } catch {
      // too short: not a complete stream
    }
    lo = mid + 1;
  }
  return { data, consumed: end - off };
}

function framed(type: ObjType, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${payload.length}\0`, 'ascii'), payload]);
}

/**
 * Parse a whole packfile. REF_DELTA bases resolve against objects already in this pack first,
 * then against `lookup` (the repository's object store). Returns framed objects with shas.
 */
export function parsePack(pack: Buffer, lookup: (sha: string) => { type: ObjType; bytes: Buffer } | null): ParsedPackObject[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const out: ParsedPackObject[] = [];
  const byOffset = new Map<number, ParsedPackObject>();
  const bySha = new Map<string, ParsedPackObject>();
  let off = 12;
  for (let n = 0; n < count; n += 1) {
    const objStart = off;
    const first = pack[off];
    const typeNum = (first >> 4) & 0x7;
    const [size, sizeLen] = readVarint(pack, off);
    off += sizeLen;
    let base: ParsedPackObject | null = null;
    if (typeNum === TYPE_OFS_DELTA) {
      const [negOff, negLen] = readOfsOffset(pack, off);
      off += negLen;
      base = byOffset.get(objStart - negOff) ?? null;
      if (!base) throw new Error('ofs-delta base not found');
    } else if (typeNum === TYPE_REF_DELTA) {
      const baseSha = pack.subarray(off, off + 20).toString('hex');
      off += 20;
      base = bySha.get(baseSha) ?? null;
      if (!base && lookup) {
        const found = lookup(baseSha);
        if (found) base = { type: found.type, bytes: found.bytes, sha: baseSha };
      }
      if (!base) throw new Error(`ref-delta base ${baseSha} not found`);
    }
    const { data, consumed } = inflateOne(pack, off);
    off += consumed;
    let obj: ParsedPackObject;
    if (base) {
      // For deltas the header size is the delta data's size, not the result's.
      if (data.length !== size) throw new Error(`delta size mismatch ${data.length} != ${size}`);
      const basePayload = base.bytes.subarray(base.bytes.indexOf(0) + 1);
      const applied = applyDelta(basePayload, data);
      const bytes = framed(base.type, applied);
      obj = { type: base.type, bytes, sha: objectId(base.type, applied) };
    } else {
      const type = TYPE_TO_NAME[typeNum];
      if (!type) throw new Error(`unknown pack object type ${typeNum}`);
      if (data.length !== size) throw new Error(`object size mismatch ${data.length} != ${size}`);
      const bytes = framed(type, data);
      obj = { type, bytes, sha: objectId(type, data) };
    }
    out.push(obj);
    byOffset.set(objStart, obj);
    bySha.set(obj.sha, obj);
  }
  return out;
}

/** Encode one object into a pack entry (no delta). */
function packEntry(type: ObjType, payload: Buffer): Buffer {
  const typeNum = NAME_TO_TYPE[type];
  const size = payload.length;
  const headerBytes: number[] = [];
  let first = (typeNum << 4) | (size & 0x0f);
  let rest = size >> 4;
  if (rest > 0) first |= 0x80;
  headerBytes.push(first);
  while (rest > 0) {
    let b = rest & 0x7f;
    rest >>= 7;
    if (rest > 0) b |= 0x80;
    headerBytes.push(b);
  }
  return Buffer.concat([Buffer.from(headerBytes), deflateSync(payload, { level: 6 })]);
}

/** Build a packfile (v2) from framed objects. The trailer is the SHA-1 of all preceding bytes — git verifies it. */
export function buildPack(objects: { type: ObjType; bytes: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const obj of objects) {
    const nul = obj.bytes.indexOf(0);
    const payload = obj.bytes.subarray(nul + 1);
    parts.push(packEntry(obj.type, payload));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
