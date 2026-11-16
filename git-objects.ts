// Git object model: sha1 ids, object read/write, tree and commit parsing.
// Node 22 stdlib only (node:crypto, node:zlib). No wall clock, no Math.random here.

import { createHash } from 'node:crypto';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The stored form of one object: the full "type len\0payload" bytes, sha1 of which is its id. */
export function objectBytes(type: ObjType, payload: Buffer): Buffer {
  const header = Buffer.from(`${type} ${payload.length}\0`, 'ascii');
  return Buffer.concat([header, payload]);
}

export function objectId(type: ObjType, payload: Buffer): string {
  return sha1Hex(objectBytes(type, payload));
}

export interface TreeEntry {
  mode: string; // e.g. '100644', '40000'
  name: string;
  sha: string;
}

export function parseTree(payload: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < payload.length) {
    const sp = payload.indexOf(0x20, off);
    const mode = payload.subarray(off, sp).toString('ascii');
    const nul = payload.indexOf(0, sp);
    const name = payload.subarray(sp + 1, nul).toString('utf8');
    const sha = payload.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    off = nul + 21;
  }
  return entries;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  // Git sorts tree entries by name, with directories sorted as if they had a trailing '/'.
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** Raw header lines after the standard ones, preserved verbatim (e.g. gpgsig). */
  extra: string[];
}

export function parseCommit(payload: Buffer): CommitInfo {
  const text = payload.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  const extra: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
    else if (line.startsWith(' ') || line.startsWith('\t')) extra.push(line);
    else extra.push(line);
  }
  return { tree, parents, author, committer, message, extra };
}

export interface TagInfo {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object: `object`, `type`, `tag`, `tagger` headers, then a message. */
export function parseTag(payload: Buffer): TagInfo {
  const text = payload.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = '';
  let type: ObjType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Follow a tag (possibly through nested tags) to the object it ultimately points at. */
export function peelTag(store: ObjectStore, sha: string): string {
  let current = sha;
  for (let i = 0; i < 10; i++) {
    if (store.typeOf(current) !== 'tag') return current;
    const payload = store.payloadOf(current);
    if (!payload) return current;
    current = parseTag(payload).object;
  }
  return current;
}

export function serializeCommit(c: CommitInfo): Buffer {
  const lines: string[] = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  if (c.author) lines.push(`author ${c.author}`);
  if (c.committer) lines.push(`committer ${c.committer}`);
  for (const e of c.extra) lines.push(e);
  return Buffer.from(`${lines.join('\n')}\n\n${c.message}`, 'utf8');
}

/** In-memory object database for one repository. Objects are stored whole (header+payload). */
export class ObjectStore {
  readonly objects = new Map<string, Buffer>();

  has(sha: string): boolean {
    return this.objects.has(sha);
  }

  get(sha: string): Buffer | undefined {
    return this.objects.get(sha);
  }

  /** Store an object from type+payload; returns its id. */
  put(type: ObjType, payload: Buffer): string {
    const bytes = objectBytes(type, payload);
    const id = sha1Hex(bytes);
    if (!this.objects.has(id)) this.objects.set(id, bytes);
    return id;
  }

  /** Store already-framed bytes; returns its id. */
  putRaw(bytes: Buffer): string {
    const id = sha1Hex(bytes);
    if (!this.objects.has(id)) this.objects.set(id, bytes);
    return id;
  }

  typeOf(sha: string): ObjType | null {
    const bytes = this.objects.get(sha);
    if (!bytes) return null;
    const sp = bytes.indexOf(0x20);
    return bytes.subarray(0, sp).toString('ascii') as ObjType;
  }

  /** Payload bytes (without the "type len\0" header) or undefined. */
  payloadOf(sha: string): Buffer | undefined {
    const bytes = this.objects.get(sha);
    if (!bytes) return undefined;
    const nul = bytes.indexOf(0);
    return bytes.subarray(nul + 1);
  }
}

/** Walk all objects reachable from `tips` (commits), following parents and trees. */
export function reachableObjects(store: ObjectStore, tips: string[]): Set<string> {
  return reachableObjectsBounded(store, tips, new Set());
}

/**
 * Like reachableObjects, but the walk stops at commits in `stopAt`: those commits and their
 * trees/blobs are included, their parents are not. That is exactly what a shallow client holds
 * below its boundary, so a deepen fetch must not subtract the ancestors of its shallow tips.
 */
export function reachableObjectsBounded(store: ObjectStore, tips: string[], stopAt: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    const bytes = store.get(sha);
    if (!bytes) continue;
    seen.add(sha);
    const type = store.typeOf(sha);
    const payload = store.payloadOf(sha)!;
    if (type === 'commit') {
      const c = parseCommit(payload);
      stack.push(c.tree);
      if (!stopAt.has(sha)) for (const p of c.parents) stack.push(p);
    } else if (type === 'tree') {
      for (const e of parseTree(payload)) stack.push(e.sha);
    } else if (type === 'tag') {
      stack.push(parseTag(payload).object);
    }
  }
  return seen;
}

/** List the file paths (and blob shas) under a tree, recursively. */
export function flattenTree(store: ObjectStore, treeSha: string, prefix = ''): { path: string; sha: string; mode: string }[] {
  const out: { path: string; sha: string; mode: string }[] = [];
  const payload = store.payloadOf(treeSha);
  if (!payload) return out;
  for (const e of parseTree(payload)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') out.push(...flattenTree(store, e.sha, path));
    else out.push({ path, sha: e.sha, mode: e.mode });
  }
  return out;
}

/** Read one file's blob payload from a tree, or undefined. */
export function readPath(store: ObjectStore, treeSha: string, path: string): { sha: string; payload: Buffer } | undefined {
  const parts = path.split('/').filter((p) => p.length > 0);
  let cur = treeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const payload = store.payloadOf(cur);
    if (!payload) return undefined;
    const entry = parseTree(payload).find((e) => e.name === parts[i]);
    if (!entry) return undefined;
    if (i === parts.length - 1) {
      const blob = store.payloadOf(entry.sha);
      if (blob === undefined) return undefined;
      return { sha: entry.sha, payload: blob };
    }
    if (entry.mode !== '40000') return undefined;
    cur = entry.sha;
  }
  return undefined;
}

/** Build a new tree from an old tree with one path replaced/added/deleted. Returns new tree sha. */
export function writePath(store: ObjectStore, treeSha: string | null, path: string, blobSha: string | null): string {
  const parts = path.split('/').filter((p) => p.length > 0);
  function rec(curSha: string | null, depth: number): string {
    const entries: TreeEntry[] = curSha ? parseTree(store.payloadOf(curSha)!) : [];
    const name = parts[depth];
    if (depth === parts.length - 1) {
      const idx = entries.findIndex((e) => e.name === name);
      if (blobSha === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode: '100644', name, sha: blobSha };
      } else {
        entries.push({ mode: '100644', name, sha: blobSha });
      }
      return store.put('tree', serializeTree(entries));
    }
    const idx = entries.findIndex((e) => e.name === name);
    const child = idx >= 0 ? entries[idx].sha : null;
    const next = rec(child, depth + 1);
    if (idx >= 0) entries[idx] = { mode: '40000', name, sha: next };
    else entries.push({ mode: '40000', name, sha: next });
    return store.put('tree', serializeTree(entries));
  }
  return rec(treeSha, 0);
}

/** Is `ancestor` reachable from `tip` (following commit parents)? */
export function isAncestor(store: ObjectStore, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const payload = store.payloadOf(sha);
    if (!payload) continue;
    if (store.typeOf(sha) !== 'commit') continue;
    for (const p of parseCommit(payload).parents) {
      if (p === ancestor) return true;
      stack.push(p);
    }
  }
  return false;
}

/** Merge-base: the first common ancestor found by walking both histories (newest-first BFS). */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  if (a === b) return a;
  const ancA = new Set<string>();
  const qa = [a];
  while (qa.length > 0) {
    const sha = qa.shift()!;
    if (ancA.has(sha)) continue;
    ancA.add(sha);
    const payload = store.payloadOf(sha);
    if (!payload || store.typeOf(sha) !== 'commit') continue;
    for (const p of parseCommit(payload).parents) qa.push(p);
  }
  const qb = [b];
  const seenB = new Set<string>();
  while (qb.length > 0) {
    const sha = qb.shift()!;
    if (seenB.has(sha)) continue;
    seenB.add(sha);
    if (ancA.has(sha)) return sha;
    const payload = store.payloadOf(sha);
    if (!payload || store.typeOf(sha) !== 'commit') continue;
    for (const p of parseCommit(payload).parents) qb.push(p);
  }
  return null;
}

/** Diff two trees: list of {path, status, oldSha, newSha}. Status added|deleted|modified. */
export function diffTrees(
  store: ObjectStore,
  oldTree: string | null,
  newTree: string | null,
): { path: string; status: 'added' | 'deleted' | 'modified'; oldSha: string | null; newSha: string | null }[] {
  const oldFiles = new Map<string, string>();
  const newFiles = new Map<string, string>();
  if (oldTree) for (const f of flattenTree(store, oldTree)) oldFiles.set(f.path, f.sha);
  if (newTree) for (const f of flattenTree(store, newTree)) newFiles.set(f.path, f.sha);
  const out: { path: string; status: 'added' | 'deleted' | 'modified'; oldSha: string | null; newSha: string | null }[] = [];
  for (const [path, sha] of newFiles) {
    const old = oldFiles.get(path);
    if (old === undefined) out.push({ path, status: 'added', oldSha: null, newSha: sha });
    else if (old !== sha) out.push({ path, status: 'modified', oldSha: old, newSha: sha });
  }
  for (const [path, sha] of oldFiles) {
    if (!newFiles.has(path)) out.push({ path, status: 'deleted', oldSha: sha, newSha: null });
  }
  out.sort((x, y) => (x.path < y.path ? -1 : 1));
  return out;
}
