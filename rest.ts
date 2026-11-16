// GitHub REST v3 API under /api/v3. Node 22 stdlib only.
// Every reply: application/json + non-empty X-GitHub-Request-Id; errors {"message": string}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';
import { flattenTree, parseCommit, parseTree, readPath } from './git-objects.ts';
import { globalId, type Forge, type Issue, type PullRequest, type Repo } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(
  forge: Forge,
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': forge.requestId(),
    ...headers,
  });
  res.end(text);
}

export function sendError(forge: Forge, res: ServerResponse, status: number, message: string): void {
  sendJson(forge, res, status, { message });
}

/** Read the whole request body as a Buffer. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; returns null (and sends 400) on malformed JSON. */
export async function readJsonBody(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    sendError(forge, res, 400, 'Problems parsing JSON');
    return null;
  }
}

export function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/.exec(auth);
  return m ? m[1] : null;
}

export function isAuthed(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return token !== null && expected !== '' && token === expected;
}

function parseQuery(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown, def: number): number {
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** GitHub-style repo JSON. Extra fields are harmless; the checks read a subset. */
export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: repo.full_name,
    private: repo.private,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.updated_at,
    html_url: `https://github.com/${repo.full_name}`,
    url: `/api/v3/repos/${repo.full_name}`,
    clone_url: `https://github.com/${repo.full_name}.git`,
    git_url: `git://github.com/${repo.full_name}.git`,
    ssh_url: `git@github.com:${repo.full_name}.git`,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    watchers_count: 0,
    size: 0,
    language: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    archived: false,
    disabled: false,
    license: null,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: issue.user.login, id: 1000, type: 'User' },
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.full_name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.full_name}`,
    comments_url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}/comments`,
    comments: issue.comments.length,
    author_association: 'OWNER',
  };
}

function pullJson(pr: PullRequest, repo: Repo): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: globalId('PullRequest', pr.id),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    mergeable: pr.state === 'open',
    mergeable_state: pr.state === 'open' ? 'clean' : 'unknown',
    head: { ref: pr.head.ref, sha: pr.head.sha, label: `${repo.owner}:${pr.head.ref}`, user: { login: repo.owner } },
    base: { ref: pr.base.ref, sha: pr.base.sha, label: `${repo.owner}:${pr.base.ref}`, user: { login: repo.owner } },
    user: { login: pr.user.login, id: 1000, type: 'User' },
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.state === 'closed' ? pr.updated_at : null,
    url: `/api/v3/repos/${repo.full_name}/pulls/${pr.number}`,
    html_url: `https://github.com/${repo.full_name}/pull/${pr.number}`,
    diff_url: `https://github.com/${repo.full_name}/pull/${pr.number}.diff`,
    patch_url: `https://github.com/${repo.full_name}/pull/${pr.number}.patch`,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

/** Paginate a list with ?page=&per_page=, adding a Link rel="next" when more remain. */
function paginate<T>(forge: Forge, res: ServerResponse, req: IncomingMessage, items: T[], basePath: string): T[] {
  const q = parseQuery(req);
  const perPage = Math.min(100, num(q.get('per_page'), 30));
  const page = num(q.get('page'), 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage < items.length) {
    // The Link URL must be ABSOLUTE: the client's sameOrigin() does `new URL(a)` with no
    // base, so a relative URL throws and is treated as "left the entry's origin".
    const host = req.headers.host ?? '127.0.0.1';
    const url = new URL(basePath, `http://${host}`);
    url.searchParams.set('page', String(page + 1));
    url.searchParams.set('per_page', String(perPage));
    const link = `<${url.toString()}>; rel="next"`;
    res.setHeader('link', link);
  }
  return slice;
}

/** Resolve /repos/{owner}/{name} with the ownership rule: other owners are 404, never 403. */
function resolveRepo(forge: Forge, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return forge.getRepo(owner, name) ?? null;
}

export async function handleRest(forge: Forge, req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const method = req.method ?? 'GET';
  const segments = path.split('/').filter((s) => s.length > 0);
  // segments[0] = 'api', segments[1] = 'v3', rest follows.
  const rest = segments.slice(2);

  // Public roots: GET /api/v3/ and GET /api/v3/meta (no token needed).
  if (method === 'GET' && rest.length === 0) {
    sendJson(forge, res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    sendJson(forge, res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0' });
    return true;
  }

  if (!isAuthed(req)) {
    sendError(forge, res, 401, 'Requires authentication');
    return true;
  }

  // GET /api/v3/user
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    sendJson(forge, res, 200, { login: VIEWER.login, id: 1000, type: 'User', name: VIEWER.name, email: VIEWER.email });
    return true;
  }

  // GET /api/v3/user/repos  +  POST /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const repos = forge.listViewerRepos();
      const page = paginate(forge, res, req, repos, '/api/v3/user/repos');
      sendJson(forge, res, 200, page.map(repoJson));
      return true;
    }
    if (method === 'POST') {
      const body = await readJsonBody(forge, req, res);
      if (body === null) return true;
      const name = str(body.name);
      if (name === '') {
        sendError(forge, res, 422, 'name is required');
        return true;
      }
      const repo = forge.createRepo(name, { private: body.private === true, description: str(body.description) });
      if (repo === null) {
        sendError(forge, res, 422, 'Repository creation failed: name already exists');
        return true;
      }
      sendJson(forge, res, 201, repoJson(repo));
      return true;
    }
    return false;
  }

  // /api/v3/repos/{owner}/{name}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1];
    const name = rest[2];
    const repo = resolveRepo(forge, owner, name);
    const tail = rest.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') {
        if (!repo) return sendError(forge, res, 404, 'Not Found'), true;
        sendJson(forge, res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        if (!repo) return sendError(forge, res, 404, 'Not Found'), true;
        const body = await readJsonBody(forge, req, res);
        if (body === null) return true;
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        repo.updated_at = forge.clock.nowIso();
        sendJson(forge, res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        if (!repo) return sendError(forge, res, 404, 'Not Found'), true;
        forge.deleteRepo(repo);
        sendJson(forge, res, 204, null);
        return true;
      }
      return false;
    }

    if (!repo) {
      sendError(forge, res, 404, 'Not Found');
      return true;
    }

    // GET /repos/{o}/{r}/branches
    if (tail.length === 1 && tail[0] === 'branches' && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r) } }));
      sendJson(forge, res, 200, branches);
      return true;
    }

    // GET /repos/{o}/{r}/branches/{branch}
    if (tail.length === 2 && tail[0] === 'branches' && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${decodeURIComponent(tail[1])}`);
      if (!sha) return sendError(forge, res, 404, 'Not Found'), true;
      sendJson(forge, res, 200, { name: decodeURIComponent(tail[1]), commit: { sha } });
      return true;
    }

    // GET /repos/{o}/{r}/commits[?sha=]
    if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
      const q = parseQuery(req);
      const ref = q.get('sha') ?? repo.default_branch;
      const commits = forge.listCommits(repo, ref).map((c) => ({
        sha: c.sha,
        commit: { message: c.message, author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } },
        author: { login: VIEWER.login },
        committer: { login: VIEWER.login },
      }));
      sendJson(forge, res, 200, commits);
      return true;
    }

    // POST /repos/{o}/{r}/git/refs
    if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && method === 'POST') {
      const body = await readJsonBody(forge, req, res);
      if (body === null) return true;
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref.startsWith('refs/') || !repo.store.has(sha)) {
        sendError(forge, res, 422, 'Invalid ref or sha');
        return true;
      }
      repo.refs.set(ref, sha);
      repo.packCache.clear();
      sendJson(forge, res, 201, { ref, object: { sha, type: 'commit' } });
      return true;
    }

    // GET /repos/{o}/{r}/git/refs/heads/{branch}
    if (tail.length >= 4 && tail[0] === 'git' && tail[1] === 'refs' && method === 'GET') {
      const ref = tail.slice(2).map(decodeURIComponent).join('/');
      const sha = repo.refs.get(ref);
      if (!sha) return sendError(forge, res, 404, 'Not Found'), true;
      sendJson(forge, res, 200, { ref, object: { sha, type: 'commit' } });
      return true;
    }

    // contents: /repos/{o}/{r}/contents/{path...}
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).map(decodeURIComponent).join('/');
      return handleContents(forge, req, res, repo, filePath);
    }

    // labels
    if (tail.length === 1 && tail[0] === 'labels' && method === 'POST') {
      const body = await readJsonBody(forge, req, res);
      if (body === null) return true;
      const name = str(body.name);
      const color = str(body.color) || 'ededed';
      if (name === '') return sendError(forge, res, 422, 'name is required'), true;
      let label = repo.labels.get(name);
      if (!label) {
        label = { name, color };
        repo.labels.set(name, label);
      }
      sendJson(forge, res, 201, { name: label.name, color: label.color });
      return true;
    }
    if (tail.length === 1 && tail[0] === 'labels' && method === 'GET') {
      sendJson(forge, res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
      return true;
    }

    // issues
    if (tail[0] === 'issues') {
      return handleIssues(forge, req, res, repo, tail.slice(1));
    }

    // pulls
    if (tail[0] === 'pulls') {
      return handlePulls(forge, req, res, repo, tail.slice(1));
    }

    return false;
  }

  return false;
}

async function handleContents(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  filePath: string,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const q = parseQuery(req);
  const ref = q.get('ref') ?? repo.default_branch;
  const tip = forge.resolveRef(repo, ref);

  if (method === 'GET') {
    if (!tip) return sendError(forge, res, 404, 'Not Found'), true;
    const payload = repo.store.payloadOf(tip);
    if (!payload) return sendError(forge, res, 404, 'Not Found'), true;
    const treeSha = parseCommit(payload).tree;
    if (filePath === '') {
      // Root listing.
      const entries = flattenTree(repo.store, treeSha).map((f) => ({
        type: 'file', name: f.path.split('/').pop(), path: f.path, sha: f.sha, size: repo.store.payloadOf(f.sha)?.length ?? 0,
      }));
      sendJson(forge, res, 200, entries);
      return true;
    }
    const file = readPath(repo.store, treeSha, filePath);
    // readPath returns the payload of whatever the final segment names — a tree payload
    // is a directory, not a file, so it falls through to the listing below.
    if (file && repo.store.typeOf(file.sha) !== 'tree') {
      sendJson(forge, res, 200, {
        type: 'file',
        encoding: 'base64',
        content: file.payload.toString('base64'),
        sha: file.sha,
        size: file.payload.length,
        name: filePath.split('/').pop(),
        path: filePath,
      });
      return true;
    }
    // Directory listing: entries directly under filePath.
    const all = flattenTree(repo.store, treeSha);
    const prefix = `${filePath}/`;
    const direct = new Map<string, { type: string; name: string; path: string; sha: string }>();
    for (const f of all) {
      if (!f.path.startsWith(prefix)) continue;
      const rest = f.path.slice(prefix.length);
      const first = rest.split('/')[0];
      if (rest.includes('/')) {
        if (!direct.has(first)) direct.set(first, { type: 'dir', name: first, path: `${filePath}/${first}`, sha: '' });
      } else {
        direct.set(first, { type: 'file', name: first, path: f.path, sha: f.sha });
      }
    }
    if (direct.size > 0) {
      // Directory entries need a sha; for dirs use the subtree sha.
      const entries = [...direct.values()].map((e) => {
        if (e.type === 'dir') {
          const sub = readPathDirSha(repo, treeSha, e.path);
          return { ...e, sha: sub ?? '' };
        }
        return e;
      });
      sendJson(forge, res, 200, entries);
      return true;
    }
    sendError(forge, res, 404, 'Not Found');
    return true;
  }

  if (method === 'PUT') {
    const body = await readJsonBody(forge, req, res);
    if (body === null) return true;
    const branch = str(body.branch) || repo.default_branch;
    const message = str(body.message) || 'Update file';
    const contentB64 = str(body.content);
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      return sendError(forge, res, 422, 'content is not valid base64'), true;
    }
    const sha = str(body.sha);
    const tipBranch = forge.resolveRef(repo, branch);
    const isUpdate = tipBranch !== undefined && readPath(repo.store, tipBranch ? parseCommit(repo.store.payloadOf(tipBranch)!).tree : '', filePath) !== undefined;
    if (sha !== '') {
      // Stale-sha check: the sha must be the current blob sha.
      const current = tipBranch ? readPath(repo.store, parseCommit(repo.store.payloadOf(tipBranch)!).tree, filePath) : undefined;
      if (!current || current.sha !== sha) {
        return sendError(forge, res, 409, 'sha does not match the current blob'), true;
      }
    }
    const { commitSha, blobSha } = forge.commitFile(repo, branch, filePath, content.toString('utf8'), message);
    sendJson(forge, res, isUpdate ? 200 : 201, {
      content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: content.length, encoding: 'base64' },
      commit: { sha: commitSha, message },
    });
    return true;
  }

  if (method === 'DELETE') {
    const body = await readJsonBody(forge, req, res);
    if (body === null) return true;
    const branch = str(body.branch) || repo.default_branch;
    const message = str(body.message) || 'Delete file';
    const tipBranch = forge.resolveRef(repo, branch);
    if (!tipBranch) return sendError(forge, res, 404, 'Not Found'), true;
    const current = readPath(repo.store, parseCommit(repo.store.payloadOf(tipBranch)!).tree, filePath);
    if (!current) return sendError(forge, res, 404, 'Not Found'), true;
    const { commitSha } = forge.commitFile(repo, branch, filePath, null, message);
    sendJson(forge, res, 200, { commit: { sha: commitSha, message } });
    return true;
  }

  return false;
}

function readPathDirSha(repo: Repo, treeSha: string, dirPath: string): string | null {
  const parts = dirPath.split('/').filter((p) => p.length > 0);
  let cur = treeSha;
  for (const part of parts) {
    const payload = repo.store.payloadOf(cur);
    if (!payload) return null;
    const entry = parseTree(payload).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return null;
    cur = entry.sha;
  }
  return cur;
}

async function handleIssues(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  tail: string[],
): Promise<boolean> {
  const method = req.method ?? 'GET';

  if (tail.length === 0) {
    if (method === 'GET') {
      const q = parseQuery(req);
      const state = q.get('state') ?? 'open';
      const sort = q.get('sort') ?? 'created';
      const direction = q.get('direction') ?? 'desc';
      let list = repo.issues.filter((i) => (state === 'all' ? true : i.state === state));
      if (sort === 'created') {
        list = [...list].sort((a, b) => {
          const d = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.number - b.number;
          return direction === 'asc' ? d : -d;
        });
      }
      const page = paginate(forge, res, req, list, `/api/v3/repos/${repo.full_name}/issues`);
      sendJson(forge, res, 200, page.map((i) => issueJson(i, repo)));
      return true;
    }
    if (method === 'POST') {
      const body = await readJsonBody(forge, req, res);
      if (body === null) return true;
      const title = str(body.title);
      const issueBody = str(body.body);
      const labelNames: string[] = Array.isArray(body.labels) ? body.labels.map((l) => (typeof l === 'string' ? l : str((l as Record<string, unknown>).name))) : [];
      for (const name of labelNames) {
        if (!repo.labels.has(name)) {
          return sendError(forge, res, 422, `Label "${name}" does not exist`), true;
        }
      }
      const now = forge.clock.nowIso();
      const issue: Issue = {
        id: repo.nextIssueId++,
        number: repo.nextIssueNumber++,
        title,
        body: issueBody,
        state: 'open',
        labels: labelNames.map((n) => repo.labels.get(n)!),
        comments: [],
        created_at: now,
        updated_at: now,
        user: { login: VIEWER.login },
      };
      repo.issues.push(issue);
      sendJson(forge, res, 201, issueJson(issue, repo));
      return true;
    }
    return false;
  }

  const number = Number.parseInt(tail[0], 10);
  if (!Number.isFinite(number)) return false;
  const issue = repo.issues.find((i) => i.number === number);
  if (!issue) return sendError(forge, res, 404, 'Not Found'), true;

  if (tail.length === 1) {
    if (method === 'GET') {
      sendJson(forge, res, 200, issueJson(issue, repo));
      return true;
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(forge, req, res);
      if (body === null) return true;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      issue.updated_at = forge.clock.nowIso();
      sendJson(forge, res, 200, issueJson(issue, repo));
      return true;
    }
    return false;
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'GET') {
      sendJson(forge, res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, created_at: c.created_at, updated_at: c.updated_at, user: c.user })));
      return true;
    }
    if (method === 'POST') {
      const body = await readJsonBody(forge, req, res);
      if (body === null) return true;
      const now = forge.clock.nowIso();
      const comment: Comment = { id: repo.nextCommentId++, body: str(body.body), created_at: now, updated_at: now, user: { login: VIEWER.login } };
      issue.comments.push(comment);
      issue.updated_at = now;
      sendJson(forge, res, 201, { id: comment.id, body: comment.body, created_at: comment.created_at, updated_at: comment.updated_at, user: comment.user });
      return true;
    }
    return false;
  }

  return false;
}

async function handlePulls(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  tail: string[],
): Promise<boolean> {
  const method = req.method ?? 'GET';

  if (tail.length === 0) {
    if (method === 'GET') {
      const q = parseQuery(req);
      const state = q.get('state') ?? 'open';
      const list = repo.pulls.filter((p) => (state === 'all' ? true : p.state === state));
      const page = paginate(forge, res, req, list, `/api/v3/repos/${repo.full_name}/pulls`);
      sendJson(forge, res, 200, page.map((p) => pullJson(p, repo)));
      return true;
    }
    if (method === 'POST') {
      const body = await readJsonBody(forge, req, res);
      if (body === null) return true;
      const headRef = str(body.head);
      const baseRef = str(body.base) || repo.default_branch;
      const headSha = forge.resolveRef(repo, headRef);
      const baseSha = forge.resolveRef(repo, baseRef);
      if (!headSha || !baseSha) {
        return sendError(forge, res, 422, 'head or base branch not found'), true;
      }
      const now = forge.clock.nowIso();
      const pr: PullRequest = {
        id: repo.nextPullId++,
        number: repo.nextPullNumber++,
        title: str(body.title),
        body: str(body.body),
        state: 'open',
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        head: { ref: headRef, sha: headSha },
        base: { ref: baseRef, sha: baseSha },
        headShaAtCreate: headSha,
        baseShaAtCreate: baseSha,
        created_at: now,
        updated_at: now,
        user: { login: VIEWER.login },
      };
      repo.pulls.push(pr);
      sendJson(forge, res, 201, pullJson(pr, repo));
      return true;
    }
    return false;
  }

  const number = Number.parseInt(tail[0], 10);
  if (!Number.isFinite(number)) return false;
  const pr = repo.pulls.find((p) => p.number === number);

  if (tail.length === 1) {
    if (method === 'GET') {
      if (!pr) return sendError(forge, res, 404, 'Not Found'), true;
      sendJson(forge, res, 200, pullJson(pr, repo));
      return true;
    }
    return false;
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (!pr) return sendError(forge, res, 404, 'Not Found'), true;
    const files = forge.diffCommits(repo, pr.baseShaAtCreate, pr.headShaAtCreate);
    sendJson(forge, res, 200, files);
    return true;
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (!pr) return sendError(forge, res, 404, 'Not Found'), true;
    const body = await readJsonBody(forge, req, res);
    if (body === null) return true;
    if (pr.state !== 'open') {
      return sendError(forge, res, 405, 'Pull request is already closed'), true;
    }
    const mergeSha = forge.squashMerge(repo, pr);
    if (mergeSha === null) {
      return sendError(forge, res, 405, 'Merge conflict'), true;
    }
    pr.state = 'closed';
    pr.merged = true;
    pr.merged_at = forge.clock.nowIso();
    pr.merge_commit_sha = mergeSha;
    pr.updated_at = pr.merged_at;
    sendJson(forge, res, 200, { sha: mergeSha, merged: true, message: `Pull request successfully merged` });
    return true;
  }

  return false;
}
