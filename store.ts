// The forge's store: repositories, git objects, issues, pull requests, labels, comments.
// One in-memory store per process (a fresh pod per trial). Deterministic: every timestamp
// comes from MAKEFUN_TRIAL_NOW plus a monotonic counter, never the wall clock or Math.random,
// so a replay leaves byte-identical state.

import {
  ObjectStore,
  diffTrees,
  flattenTree,
  isAncestor,
  mergeBase,
  parseCommit,
  readPath,
  serializeCommit,
  writePath,
  type CommitInfo,
} from './git-objects.ts';
import { VIEWER } from './scenario.ts';

/** Deterministic clock: MAKEFUN_TRIAL_NOW is the base; each tick adds one second. */
export class Clock {
  readonly baseMs: number;
  #tick = 0;
  constructor() {
    const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = raw === '' ? NaN : Date.parse(raw);
    this.baseMs = Number.isNaN(parsed) ? 1_735_689_600_000 : parsed;
  }
  /** ISO timestamp, strictly increasing. */
  nowIso(): string {
    const ms = this.baseMs + this.#tick * 1000;
    this.#tick += 1;
    return new Date(ms).toISOString();
  }
  /** Epoch seconds for a git author/committer line. */
  nowSec(): number {
    return Math.floor(this.baseMs / 1000) + this.#tick;
  }
  /** Advance one tick and return the epoch seconds (used when a commit is made). */
  tickSec(): number {
    const sec = this.nowSec();
    this.#tick += 1;
    return sec;
  }
}

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
  user: { login: string };
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  created_at: string;
  updated_at: string;
  user: { login: string };
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  /** Head/base tips at creation, for the files diff. */
  headShaAtCreate: string;
  baseShaAtCreate: string;
  created_at: string;
  updated_at: string;
  user: { login: string };
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  private: boolean;
  description: string;
  default_branch: string;
  refs: Map<string, string>;
  store: ObjectStore;
  labels: Map<string, Label>;
  issues: Issue[];
  nextIssueNumber: number;
  nextIssueId: number;
  pulls: PullRequest[];
  nextPullNumber: number;
  nextPullId: number;
  nextCommentId: number;
  created_at: string;
  updated_at: string;
  /** Cached pack for (tip sha) used by shallow clones; invalidated on ref moves. */
  packCache: Map<string, Buffer>;
}

export class Forge {
  readonly clock = new Clock();
  readonly repos = new Map<string, Repo>();
  #nextRepoId = 5000;
  #requestSeq = 0;

  requestId(): string {
    this.#requestSeq += 1;
    return `req-${this.#requestSeq.toString(16).padStart(8, '0')}`;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, opts: { private?: boolean; description?: string }): Repo | null {
    if (this.repos.has(this.key(VIEWER.login, name))) return null;
    const now = this.clock.nowIso();
    const repo: Repo = {
      id: this.#nextRepoId++,
      owner: VIEWER.login,
      name,
      full_name: `${VIEWER.login}/${name}`,
      private: opts.private ?? false,
      description: opts.description ?? '',
      default_branch: 'main',
      refs: new Map(),
      store: new ObjectStore(),
      labels: new Map(),
      issues: [],
      nextIssueNumber: 1,
      nextIssueId: 1,
      pulls: [],
      nextPullNumber: 1,
      nextPullId: 1,
      nextCommentId: 1,
      created_at: now,
      updated_at: now,
      packCache: new Map(),
    };
    this.repos.set(repo.full_name, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.full_name);
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === VIEWER.login) out.push(repo);
    }
    return out;
  }

  /** The tip of a ref, resolving short branch names to refs/heads/<name>. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    const head = repo.refs.get(`refs/heads/${ref}`);
    if (head) return head;
    return repo.refs.get(ref);
  }

  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.default_branch}`);
  }

  /** Create a commit on a branch (or unborn) with one file change; returns the commit sha. */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: string | null,
    message: string,
  ): { commitSha: string; blobSha: string | null } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    let treeSha: string | null = null;
    const parents: string[] = [];
    if (tip) {
      const payload = repo.store.payloadOf(tip);
      if (payload) {
        const c = parseCommit(payload);
        treeSha = c.tree;
        parents.push(tip);
      }
    }
    let blobSha: string | null = null;
    if (content !== null) {
      blobSha = repo.store.put('blob', Buffer.from(content, 'utf8'));
    }
    const newTree = writePath(repo.store, treeSha, path, blobSha);
    const sec = this.clock.tickSec();
    const stamp = `${sec} +0000`;
    const commit: CommitInfo = {
      tree: newTree,
      parents,
      author: `${VIEWER.name} <${VIEWER.email}> ${stamp}`,
      committer: `${VIEWER.name} <${VIEWER.email}> ${stamp}`,
      message,
      extra: [],
    };
    const commitSha = repo.store.put('commit', serializeCommit(commit));
    repo.refs.set(ref, commitSha);
    repo.packCache.clear();
    return { commitSha, blobSha };
  }

  /** The commit objects reachable from a ref, newest first (by traversal order). */
  listCommits(repo: Repo, ref: string): { sha: string; message: string; tree: string }[] {
    const tip = this.resolveRef(repo, ref);
    if (!tip) return [];
    const out: { sha: string; message: string; tree: string }[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const sha = queue.shift()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const payload = repo.store.payloadOf(sha);
      if (!payload) continue;
      const c = parseCommit(payload);
      out.push({ sha, message: c.message, tree: c.tree });
      for (const p of c.parents) queue.push(p);
    }
    return out;
  }

  /** Diff the trees of two commits for the pull-request files list. */
  diffCommits(
    repo: Repo,
    oldSha: string,
    newSha: string,
  ): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const oldPayload = repo.store.payloadOf(oldSha);
    const newPayload = repo.store.payloadOf(newSha);
    const oldTree = oldPayload ? parseCommit(oldPayload).tree : null;
    const newTree = newPayload ? parseCommit(newPayload).tree : null;
    const diffs = diffTrees(repo.store, oldTree, newTree);
    return diffs.map((d) => {
      let additions = 0;
      let deletions = 0;
      const countLines = (sha: string | null): string[] => {
        if (!sha) return [];
        const p = repo.store.payloadOf(sha);
        if (!p) return [];
        const text = p.toString('utf8');
        return text === '' ? [] : text.split('\n');
      };
      if (d.status === 'added') {
        additions = countLines(d.newSha).length;
      } else if (d.status === 'deleted') {
        deletions = countLines(d.oldSha).length;
      } else {
        const oldLines = countLines(d.oldSha);
        const newLines = countLines(d.newSha);
        const oldSet = new Map<string, number>();
        for (const l of oldLines) oldSet.set(l, (oldSet.get(l) ?? 0) + 1);
        let shared = 0;
        for (const l of newLines) {
          const n = oldSet.get(l) ?? 0;
          if (n > 0) {
            oldSet.set(l, n - 1);
            shared += 1;
          }
        }
        additions = newLines.length - shared;
        deletions = oldLines.length - shared;
      }
      return {
        filename: d.path,
        status: d.status === 'modified' ? 'modified' : d.status,
        additions,
        deletions,
        changes: additions + deletions,
      };
    });
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge commit sha, or null
   * when the merge conflicts (both sides changed the same path differently since merge-base).
   */
  squashMerge(repo: Repo, pr: PullRequest): string | null {
    const baseTip = this.resolveRef(repo, pr.base.ref);
    const headTip = this.resolveRef(repo, pr.head.ref);
    if (!baseTip || !headTip) return null;
    const base = mergeBase(repo.store, baseTip, headTip);
    const baseTree = base ? parseCommit(repo.store.payloadOf(base)!).tree : null;
    const headTree = parseCommit(repo.store.payloadOf(headTip)!).tree;
    const defaultTree = parseCommit(repo.store.payloadOf(baseTip)!).tree;
    const baseFiles = new Map<string, string>();
    const headFiles = new Map<string, string>();
    const defaultFiles = new Map<string, string>();
    if (baseTree) for (const f of flattenTree(repo.store, baseTree)) baseFiles.set(f.path, f.sha);
    for (const f of flattenTree(repo.store, headTree)) headFiles.set(f.path, f.sha);
    for (const f of flattenTree(repo.store, defaultTree)) defaultFiles.set(f.path, f.sha);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...defaultFiles.keys()]);
    let mergedTree: string | null = defaultTree;
    for (const path of paths) {
      const b = baseFiles.get(path) ?? null;
      const h = headFiles.get(path) ?? null;
      const d = defaultFiles.get(path) ?? null;
      const headChanged = h !== b;
      const defaultChanged = d !== b;
      if (headChanged && defaultChanged && h !== d) return null; // conflict
      if (headChanged) mergedTree = writePath(repo.store, mergedTree, path, h);
    }
    const sec = this.clock.tickSec();
    const stamp = `${sec} +0000`;
    const commit: CommitInfo = {
      tree: mergedTree ?? parseCommit(repo.store.payloadOf(baseTip)!).tree,
      parents: [baseTip],
      author: `${VIEWER.name} <${VIEWER.email}> ${stamp}`,
      committer: `${VIEWER.name} <${VIEWER.email}> ${stamp}`,
      message: `Merge pull request #${pr.number} from ${pr.head.ref}\n\n${pr.title}`,
      extra: [],
    };
    const mergeSha = repo.store.put('commit', serializeCommit(commit));
    repo.refs.set(`refs/heads/${pr.base.ref}`, mergeSha);
    repo.packCache.clear();
    return mergeSha;
  }

  /** Fast-forward check: can `newSha` replace `oldSha` (null = unborn)? */
  canFastForward(repo: Repo, oldSha: string | null, newSha: string): boolean {
    if (oldSha === null) return true;
    if (oldSha === newSha) return true;
    return isAncestor(repo.store, oldSha, newSha);
  }
}

/** Opaque GraphQL global id: base64 of "<Kind>:<dbid>". Never equals the plain number. */
export function globalId(kind: string, dbId: number): string {
  return Buffer.from(`${kind}:${dbId}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; dbId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const m = /^([A-Za-z]+):(\d+)$/.exec(text);
    if (!m) return null;
    return { kind: m[1], dbId: Number(m[2]) };
  } catch {
    return null;
  }
}
