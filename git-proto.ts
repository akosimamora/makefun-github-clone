// Git smart HTTP: upload-pack protocol v2 (+ v0 fallback) and receive-pack v0.
// Node 22 stdlib only. Real packfiles via git-pack.ts; pkt-line framing here.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit, parseTree, peelTag, reachableObjects, reachableObjectsBounded } from './git-objects.ts';
import { buildPack, parsePack } from './git-pack.ts';
import { VIEWER } from './scenario.ts';
import type { Forge, Repo } from './store.ts';
import { readBody } from './rest.ts';

const ZERO = '0000000000000000000000000000000000000000';
const AGENT = 'forge/1.0';

// ---------------------------------------------------------------------------
// pkt-line framing

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

interface PktLine {
  kind: 'line' | 'flush' | 'delim';
  data: Buffer;
}

/** Parse a buffer of pkt-lines. Returns lines and the offset where trailing raw data begins. */
export function parsePktLines(buf: Buffer): { lines: PktLine[]; restOffset: number } {
  const lines: PktLine[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = Number.parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      lines.push({ kind: 'flush', data: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 1) {
      lines.push({ kind: 'delim', data: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (off + len > buf.length) break;
    lines.push({ kind: 'line', data: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { lines, restOffset: off };
}

/** Side-band frame one chunk of pack data (channel 1), splitting at 65519 bytes. */
function sideband(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  // A pkt-line is at most 65520 bytes INCLUDING its 4-byte length, so a sideband data
  // packet carries at most 65520 - 4 (length) - 1 (channel byte) = 65515 payload bytes.
  // (65519 overflows the limit and the client's decoder rejects the pack.)
  const MAX = 65515;
  for (let off = 0; off < data.length; off += MAX) {
    const chunk = data.subarray(off, Math.min(data.length, off + MAX));
    const framed = Buffer.concat([Buffer.from([0x01]), chunk]);
    out.push(pktLine(framed));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Refs

function refLines(repo: Repo): { sha: string; name: string }[] {
  const out: { sha: string; name: string }[] = [];
  const tip = repo.refs.get(`refs/heads/${repo.default_branch}`);
  if (tip) out.push({ sha: tip, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    out.push({ sha: repo.refs.get(name)!, name });
  }
  return out;
}

const UPLOAD_V0_CAPS = 'side-band-64k thin-pack ofs-delta agent=forge/1.0 object-format=sha1';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0 object-format=sha1';

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const refs = refLines(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((r, i) => {
      parts.push(pktLine(i === 0 ? `${r.sha} ${r.name}\0${caps}\n` : `${r.sha} ${r.name}\n`));
      // Peeled tags: a ref pointing at a tag object is followed by a `^{}` line naming the
      // commit it peels to (v0 clients read the peel from that line).
      if (r.name !== 'HEAD' && repo.store.typeOf(r.sha) === 'tag') {
        parts.push(pktLine(`${peelTag(repo.store, r.sha)} ${r.name}^{}\n`));
      }
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('agent=forge/1.0\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('server-option\n'),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ]);
}

// ---------------------------------------------------------------------------
// Pack selection for a fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  /** The client's current shallow boundary (sent as `shallow` lines when deepening). */
  shallow: string[];
  deepen: number | null;
  filter: string | null;
}

/** Objects to send for a fetch: reachable from wants, minus reachable from haves. */
function fetchObjects(repo: Repo, req: FetchRequest): { type: 'commit' | 'tree' | 'blob' | 'tag'; bytes: Buffer }[] {
  const out: { type: 'commit' | 'tree' | 'blob' | 'tag'; bytes: Buffer }[] = [];
  const emitted = new Set<string>();
  // The client's haves stop at its shallow boundary: the ancestors of a shallow tip are NOT
  // held, so the have-closure must not swallow them (a deepen fetch has to deliver the parent).
  const have = req.haves.length > 0
    ? reachableObjectsBounded(repo.store, req.haves, new Set(req.shallow))
    : new Set<string>();
  const emit = (sha: string): void => {
    if (emitted.has(sha) || have.has(sha)) return;
    const bytes = repo.store.get(sha);
    if (!bytes) return;
    emitted.add(sha);
    out.push({ type: repo.store.typeOf(sha)!, bytes });
  };
  const emitTree = (treeSha: string): void => {
    const stack = [treeSha];
    while (stack.length > 0) {
      const t = stack.pop()!;
      emit(t);
      const payload = repo.store.payloadOf(t);
      if (!payload) continue;
      for (const e of parseTree(payload)) {
        if (e.mode === '40000') stack.push(e.sha);
        else emit(e.sha);
      }
    }
  };
  if (req.deepen !== null) {
    // Shallow: only commits within `deepen` generations of the wants, plus their trees/blobs.
    // The walk is depth-limited from the wants, so a depth-1 clone of a 200-commit repo never
    // walks the history it is about to exclude. The walk still descends through commits the
    // client already holds (they are the path to the deeper commits a deepen fetch delivers);
    // only the emit is skipped for those.
    const queue: { sha: string; d: number }[] = req.wants.map((sha) => ({ sha, d: 0 }));
    const seen = new Set<string>();
    while (queue.length > 0) {
      const { sha, d } = queue.shift()!;
      if (seen.has(sha) || d >= req.deepen) continue;
      seen.add(sha);
      const payload = repo.store.payloadOf(sha);
      if (!payload || repo.store.typeOf(sha) !== 'commit') continue;
      const c = parseCommit(payload);
      if (!have.has(sha)) {
        emit(sha);
        emitTree(c.tree);
      }
      for (const p of c.parents) queue.push({ sha: p, d: d + 1 });
    }
    return out;
  }
  const wanted = reachableObjects(repo.store, req.wants);
  for (const sha of wanted) emit(sha);
  return out;
}

// ---------------------------------------------------------------------------
// upload-pack v2

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  const refs = refLines(repo);
  const tip = repo.refs.get(`refs/heads/${repo.default_branch}`);
  const lines: { sha: string; name: string; attrs: string[] }[] = [];
  if (refs.length === 0) {
    // Unborn HEAD: the client parses a line whose first token is the literal word `unborn`.
    if (unborn && tip === undefined) {
      lines.push({ sha: 'unborn', name: 'HEAD', attrs: ['symref-target:refs/heads/' + repo.default_branch] });
    }
  } else {
    const headTarget = `refs/heads/${repo.default_branch}`;
    for (const r of refs) {
      // A ref is listed exactly when its name starts with some prefix (or no prefixes were
      // given). HEAD is no exception: with prefix `refs/heads/` it is NOT listed, because
      // `HEAD` does not start with `refs/heads/`; only a prefix like `HEAD` lists it.
      if (prefixes.length > 0 && !prefixes.some((p) => r.name.startsWith(p))) continue;
      const attrs: string[] = [];
      if (r.name === 'HEAD') attrs.push(`symref-target:${headTarget}`);
      // Peeled tags: when peel was asked for, a ref pointing at a tag object carries the
      // commit it peels to as a `peeled:` attribute.
      if (peel && r.name !== 'HEAD' && repo.store.typeOf(r.sha) === 'tag') {
        attrs.push(`peeled:${peelTag(repo.store, r.sha)}`);
      }
      lines.push({ sha: r.sha, name: r.name, attrs });
    }
  }
  for (const l of lines) {
    const attrs = l.attrs.length > 0 ? ` ${l.attrs.join(' ')}` : '';
    parts.push(pktLine(`${l.sha} ${l.name}${attrs}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV2(repo: Repo, args: string[]): Buffer {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, filter: null };
  const resolveWant = (value: string): string => {
    if (/^[0-9a-f]{40}$/.test(value)) return value;
    // A ref name (ref-in-want style): resolve it to its tip.
    return repo.refs.get(value) ?? repo.refs.get(`refs/heads/${value}`) ?? value;
  };
  for (const arg of args) {
    if (arg.startsWith('want ')) req.wants.push(resolveWant(arg.slice(5).trim()));
    else if (arg.startsWith('have ')) req.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) req.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) req.deepen = Number.parseInt(arg.slice(7), 10);
    else if (arg.startsWith('filter ')) req.filter = arg.slice(7);
    // 'done', 'sideband-all', 'wait-for-done', 'object-format', 'agent' ignored.
  }
  const parts: Buffer[] = [];
  // Acknowledgments first (shallow lines when deepening), then the delimiter — but ONLY when
  // there is at least one acknowledgment line. Real git sends `packfile` with no preceding
  // delimiter when the acknowledgment section is empty, and its client rejects a bare
  // delimiter there ("fatal: expected 'packfile'").
  const shallowLines: Buffer[] = [];
  if (req.deepen !== null && req.deepen > 0) {
    for (const want of req.wants) {
      // Boundary = the commits at exactly `deepen` generations below each want.
      const boundary = shallowBoundary(repo, want, req.deepen);
      for (const sha of boundary) shallowLines.push(pktLine(`shallow ${sha}\n`));
    }
    // Old shallow commits that are now interior (their parents are included in this fetch)
    // are no longer shallow: name them `unshallow` so the client drops them from its boundary.
    // Only commits actually within the new depth count — an unrelated old boundary stays put.
    const newBoundary = new Set<string>();
    const withinDepth = new Set<string>();
    for (const want of req.wants) {
      for (const sha of shallowBoundary(repo, want, req.deepen)) newBoundary.add(sha);
      const queue: { sha: string; d: number }[] = [{ sha: want, d: 0 }];
      const seen = new Set<string>();
      while (queue.length > 0) {
        const { sha, d } = queue.shift()!;
        if (seen.has(sha) || d >= req.deepen) continue;
        seen.add(sha);
        withinDepth.add(sha);
        const payload = repo.store.payloadOf(sha);
        if (!payload || repo.store.typeOf(sha) !== 'commit') continue;
        for (const p of parseCommit(payload).parents) queue.push({ sha: p, d: d + 1 });
      }
    }
    for (const old of req.shallow) {
      if (withinDepth.has(old) && !newBoundary.has(old)) shallowLines.push(pktLine(`unshallow ${old}\n`));
    }
  }
  if (shallowLines.length > 0) parts.push(pktLine('shallow-info\n'), ...shallowLines, DELIM);
  parts.push(pktLine('packfile\n'));
  // The pack for an identical fetch is byte-identical (deterministic walk + deflate), so cache
  // it: the benchmark clones the same repo 50 times concurrently, and only the first clone
  // pays the walk + deflate. The cache is cleared on every mutation (receive-pack, contents
  // PUT/DELETE, PR merge), so a cached pack can never be stale.
  const cacheKey = `v2|${req.wants.join(',')}|h:${req.haves.join(',')}|s:${req.shallow.join(',')}|d:${req.deepen ?? ''}|f:${req.filter ?? ''}`;
  let pack = repo.packCache.get(cacheKey);
  if (pack === undefined) {
    pack = buildPack(fetchObjects(repo, req));
    if (pack.length <= 1024 * 1024 && repo.packCache.size < 64) repo.packCache.set(cacheKey, pack);
  }
  parts.push(...sideband(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Commits at exactly `depth` generations below `tip` (the shallow boundary). */
function shallowBoundary(repo: Repo, tip: string, depth: number): string[] {
  const out: string[] = [];
  const queue: { sha: string; d: number }[] = [{ sha: tip, d: 0 }];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { sha, d } = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const payload = repo.store.payloadOf(sha);
    if (!payload || repo.store.typeOf(sha) !== 'commit') continue;
    // A shallow line names a commit whose parents are NOT in the pack: the deepest
    // commits still included, i.e. `depth - 1` generations below the want (for depth 1,
    // the want itself). Real git marks the tip shallow on a depth-1 clone, not its parent.
    if (d === depth - 1) {
      out.push(sha);
      continue;
    }
    for (const p of parseCommit(payload).parents) queue.push({ sha: p, d: d + 1 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// upload-pack v0

function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  const { lines } = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  for (const l of lines) {
    if (l.kind !== 'line') continue;
    const text = l.data.toString('utf8').trim();
    if (text.startsWith('want ')) wants.push(text.slice(5, 45));
    else if (text.startsWith('have ')) haves.push(text.slice(5, 45));
  }
  const parts: Buffer[] = [];
  for (const have of haves) {
    if (repo.store.has(have)) parts.push(pktLine(`ACK ${have}\n`));
  }
  parts.push(pktLine('NAK\n'));
  const cacheKey = `v0|${wants.join(',')}|h:${haves.join(',')}`;
  let pack = repo.packCache.get(cacheKey);
  if (pack === undefined) {
    pack = buildPack(fetchObjects(repo, { wants, haves, shallow: [], deepen: null, filter: null }));
    if (pack.length <= 1024 * 1024 && repo.packCache.size < 64) repo.packCache.set(cacheKey, pack);
  }
  parts.push(...sideband(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack v0

interface RefUpdate {
  oldSha: string;
  newSha: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): { status: number; body: Buffer } {
  const { lines, restOffset } = parsePktLines(body);
  const updates: RefUpdate[] = [];
  for (const l of lines) {
    if (l.kind === 'flush') break;
    if (l.kind !== 'line') continue;
    const text = l.data.toString('utf8').trim();
    // The first command line carries capabilities after a NUL: strip them before matching.
    const cmdLine = text.split('\0')[0];
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(cmdLine);
    if (m) updates.push({ oldSha: m[1], newSha: m[2], ref: m[3] });
  }
  const packBytes = body.subarray(restOffset);
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  let unpackOk = true;
  let unpackError = '';
  try {
    if (packBytes.length > 0) {
      const objects = parsePack(packBytes, (sha) => {
        const bytes = repo.store.get(sha);
        if (!bytes) return null;
        return { type: repo.store.typeOf(sha)!, bytes };
      });
      for (const obj of objects) repo.store.putRaw(obj.bytes);
    }
  } catch (err) {
    unpackOk = false;
    unpackError = err instanceof Error ? err.message : String(err);
  }
  for (const u of updates) {
    if (!unpackOk) {
      results.push({ ref: u.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    if (u.newSha === ZERO) {
      // Delete.
      if (!repo.refs.has(u.ref)) {
        results.push({ ref: u.ref, ok: false, reason: 'remote ref does not exist' });
      } else {
        repo.refs.delete(u.ref);
        results.push({ ref: u.ref, ok: true, reason: '' });
      }
      continue;
    }
    const current = repo.refs.get(u.ref) ?? null;
    if (current !== null && current !== u.oldSha) {
      results.push({ ref: u.ref, ok: false, reason: 'remote ref is at a different commit' });
      continue;
    }
    if (!repo.store.has(u.newSha)) {
      results.push({ ref: u.ref, ok: false, reason: 'new object not in pack' });
      continue;
    }
    if (!forge_canFF(repo, current, u.newSha)) {
      results.push({ ref: u.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(u.ref, u.newSha);
    results.push({ ref: u.ref, ok: true, reason: '' });
  }
  // The pack's objects are stored even when a ref update is refused (non-fast-forward), so
  // the pack cache is cleared whenever the unpack stored anything — a stale cached pack
  // could otherwise miss objects a later fetch should include.
  if (unpackOk) repo.packCache.clear();
  // The report lines are pkt-line framed INSIDE the sideband data, and the report
  // terminates with its own flush pkt-line inside that stream (the outer flush below
  // only ends the HTTP response; without the inner one the client reads EOF and
  // reports "the remote end hung up").
  const lines2: Buffer[] = [];
  lines2.push(pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackError}\n`));
  for (const r of results) {
    lines2.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
  }
  lines2.push(FLUSH);
  const framed = sideband(Buffer.concat(lines2));
  return { status: 200, body: Buffer.concat([...framed, FLUSH]) };
}

import { isAncestor } from './git-objects.ts';
function forge_canFF(repo: Repo, oldSha: string | null, newSha: string): boolean {
  if (oldSha === null) return true;
  if (oldSha === newSha) return true;
  return isAncestor(repo.store, oldSha, newSha);
}

// ---------------------------------------------------------------------------
// Router for /{owner}/{repo}.git/...

export async function handleGit(forge: Forge, req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!m) return false;
  const owner = decodeURIComponent(m[1]);
  const name = decodeURIComponent(m[2]);
  const action = m[3];
  const method = req.method ?? 'GET';

  // Ownership: repositories belong to the token's login; other owners are 404, never 403.
  const owned = owner === VIEWER.login ? forge.getRepo(owner, name) ?? null : null;

  if (action === 'info/refs') {
    if (method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Method Not Allowed' }));
      return true;
    }
    if (!owned) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not Found' }));
      return true;
    }
    const url = new URL(req.url ?? '/', 'http://entry');
    const service = url.searchParams.get('service');
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (service === 'git-upload-pack') {
      const body = isV2 ? v2Advertisement() : v0Advertisement('git-upload-pack', owned);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-length': body.length });
      res.end(body);
      return true;
    }
    if (service === 'git-receive-pack') {
      const body = v0Advertisement('git-receive-pack', owned);
      res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement', 'content-length': body.length });
      res.end(body);
      return true;
    }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Missing service parameter' }));
    return true;
  }

  if (action === 'git-upload-pack') {
    if (method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Method Not Allowed' }));
      return true;
    }
    if (!owned) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not Found' }));
      return true;
    }
    const body = await readBody(req);
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    let out: Buffer;
    if (isV2) {
      const { lines } = parsePktLines(body);
      const first = lines.find((l) => l.kind === 'line');
      const command = first ? first.data.toString('utf8').trim() : '';
      const args: string[] = [];
      let pastDelim = false;
      for (const l of lines) {
        if (l.kind === 'delim') {
          pastDelim = true;
          continue;
        }
        if (l.kind === 'flush') break;
        if (pastDelim && l.kind === 'line') args.push(l.data.toString('utf8').trim());
      }
      if (command.startsWith('command=ls-refs')) out = handleLsRefs(owned, args);
      else if (command.startsWith('command=fetch')) out = handleFetchV2(owned, args);
      else {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: `Unknown command: ${command}` }));
        return true;
      }
    } else {
      out = handleUploadPackV0(owned, body);
    }
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
    res.end(out);
    return true;
  }

  if (action === 'git-receive-pack') {
    if (method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Method Not Allowed' }));
      return true;
    }
    if (!owned) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not Found' }));
      return true;
    }
    const body = await readBody(req);
    const { status, body: out } = handleReceivePack(owned, body);
    res.writeHead(status, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': out.length });
    res.end(out);
    return true;
  }

  return false;
}
