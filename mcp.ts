// Model Context Protocol endpoint at POST /mcp: JSON-RPC 2.0 over Streamable HTTP.
// Speaks revision 2026-07-28 via server/discover, and the legacy handshake (initialize +
// notifications/initialized) for revisions <= 2025-11-25. Tools act on the same store as REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';
import { globalId, type Forge, type Repo } from './store.ts';
import { isAuthed, readBody, sendJson } from './rest.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string; enum?: string[] }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.', enum: ['open', 'closed', 'all'] },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

const ALIASES: Record<string, string> = {
  create_repository: 'create_repo',
  repo_create: 'create_repo',
  repos_create: 'create_repo',
  repository_create: 'create_repo',
  get_repository: 'get_repo',
  repo_get: 'get_repo',
  repos_get: 'get_repo',
  repository_get: 'get_repo',
  issue_create: 'create_issue',
  issues_create: 'create_issue',
  issues_list: 'list_issues',
  issue_list: 'list_issues',
  pull_request_create: 'create_pull_request',
  pulls_create: 'create_pull_request',
  create_pr: 'create_pull_request',
  pr_create: 'create_pull_request',
  pull_request_merge: 'merge_pull_request',
  pulls_merge: 'merge_pull_request',
  merge_pr: 'merge_pull_request',
  pr_merge: 'merge_pull_request',
};

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveTool(name: string): ToolDef | null {
  const norm = normalize(name);
  for (const tool of TOOLS) {
    if (normalize(tool.name) === norm) return tool;
  }
  const alias = ALIASES[norm] ?? ALIASES[name.toLowerCase()];
  if (alias) return TOOLS.find((t) => t.name === alias) ?? null;
  for (const tool of TOOLS) {
    if (norm.endsWith(normalize(tool.name))) return tool;
  }
  return null;
}

function toolsListPayload(): Record<string, unknown> {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: 'object', properties: t.properties, required: t.required },
    })),
  };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function toolResult(payload: unknown): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Split owner/repo from args, honouring full_name as a fallback. */
function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      if (owner === '') owner = parts[0];
      if (repo === '') repo = parts[1];
    }
  }
  return { owner, repo };
}

function repoJsonForMcp(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: repo.full_name,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
  };
}

function callTool(forge: Forge, tool: ToolDef, args: Record<string, unknown>): Record<string, unknown> {
  // Missing required arguments -> isError (accepted) rather than a JSON-RPC error.
  for (const req of tool.required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') {
      // full_name can stand in for owner+repo.
      if ((req === 'owner' || req === 'repo') && typeof args.full_name === 'string' && args.full_name.includes('/')) continue;
      return toolError(`Missing required argument: ${req}`);
    }
  }
  switch (tool.name) {
    case 'create_repo': {
      const name = String(args.name ?? '');
      const repo = forge.createRepo(name, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      if (!repo) return toolError(`Repository "${name}" already exists`);
      return toolResult(repoJsonForMcp(repo));
    }
    case 'get_repo': {
      const { owner, repo: name } = ownerRepo(args);
      const repo = owner === VIEWER.login ? forge.getRepo(owner, name) ?? null : null;
      if (!repo) return toolError(`Repository "${owner}/${name}" not found`);
      return toolResult(repoJsonForMcp(repo));
    }
    case 'create_issue': {
      const { owner, repo: name } = ownerRepo(args);
      const repo = owner === VIEWER.login ? forge.getRepo(owner, name) ?? null : null;
      if (!repo) return toolError(`Repository "${owner}/${name}" not found`);
      const now = forge.clock.nowIso();
      const issue = {
        id: repo.nextIssueId++,
        number: repo.nextIssueNumber++,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        created_at: now,
        updated_at: now,
        user: { login: VIEWER.login },
      };
      repo.issues.push(issue);
      return toolResult({ id: issue.id, node_id: globalId('Issue', issue.id), number: issue.number, title: issue.title, body: issue.body, state: 'open', full_name: repo.full_name });
    }
    case 'list_issues': {
      const { owner, repo: name } = ownerRepo(args);
      const repo = owner === VIEWER.login ? forge.getRepo(owner, name) ?? null : null;
      if (!repo) return toolError(`Repository "${owner}/${name}" not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues.filter((i) => (state === 'all' ? true : i.state === state));
      const issues = list.map((i) => ({ id: i.id, node_id: globalId('Issue', i.id), number: i.number, title: i.title, body: i.body, state: i.state }));
      return toolResult({ issues, full_name: repo.full_name });
    }
    case 'create_pull_request': {
      const { owner, repo: name } = ownerRepo(args);
      const repo = owner === VIEWER.login ? forge.getRepo(owner, name) ?? null : null;
      if (!repo) return toolError(`Repository "${owner}/${name}" not found`);
      const headRef = String(args.head ?? '');
      const baseRef = String(args.base ?? '');
      const headSha = forge.resolveRef(repo, headRef);
      const baseSha = forge.resolveRef(repo, baseRef);
      if (!headSha || !baseSha) return toolError('Head or base branch not found');
      const now = forge.clock.nowIso();
      const pr = {
        id: repo.nextPullId++,
        number: repo.nextPullNumber++,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
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
      return toolResult({ id: pr.id, node_id: globalId('PullRequest', pr.id), number: pr.number, title: pr.title, body: pr.body, state: 'open', head: pr.head, base: pr.base, full_name: repo.full_name });
    }
    case 'merge_pull_request': {
      const { owner, repo: name } = ownerRepo(args);
      const repo = owner === VIEWER.login ? forge.getRepo(owner, name) ?? null : null;
      if (!repo) return toolError(`Repository "${owner}/${name}" not found`);
      const n = Number(args.pull_number);
      const pr = repo.pulls.find((p) => p.number === n);
      if (!pr) return toolError(`Pull request ${n} not found`);
      if (pr.state !== 'open') return toolError(`Pull request ${n} is already closed`);
      const mergeSha = forge.squashMerge(repo, pr);
      if (mergeSha === null) return toolError('Merge conflict');
      pr.state = 'closed';
      pr.merged = true;
      pr.merged_at = forge.clock.nowIso();
      pr.merge_commit_sha = mergeSha;
      pr.updated_at = pr.merged_at;
      return toolResult({ number: pr.number, merged: true, sha: mergeSha, state: 'closed', full_name: repo.full_name });
    }
    default:
      return toolError(`Unknown tool: ${tool.name}`);
  }
}

export async function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'POST') {
    sendJson(forge, res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (!isAuthed(req)) {
    sendJson(forge, res, 401, { message: 'Requires authentication' });
    return true;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    // Non-JSON body: HTTP 400 with JSON-RPC -32700.
    sendJson(forge, res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(forge, res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const body = parsed as Record<string, unknown>;
  const id = body.id ?? null;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = (body.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) get no JSON-RPC response: 202 with an empty body.
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return true;
  }

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    sendJson(forge, res, 200, rpcResult(id, {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    }));
    return true;
  }

  if (method === 'initialize') {
    const offered = typeof (params as Record<string, unknown>).protocolVersion === 'string'
      ? (params as Record<string, unknown>).protocolVersion as string
      : '2025-11-25';
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    sendJson(forge, res, 200, rpcResult(id, {
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo,
    }));
    return true;
  }

  if (method === 'tools/list') {
    sendJson(forge, res, 200, rpcResult(id, toolsListPayload()));
    return true;
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = resolveTool(name);
    if (!tool) {
      sendJson(forge, res, 200, rpcError(id, -32601, `Unknown tool: ${name}`));
      return true;
    }
    const result = callTool(forge, tool, args);
    sendJson(forge, res, 200, rpcResult(id, result));
    return true;
  }

  if (method === 'ping') {
    sendJson(forge, res, 200, rpcResult(id, {}));
    return true;
  }

  sendJson(forge, res, 200, rpcError(id, -32601, `Method not found: ${method}`));
  return true;
}
