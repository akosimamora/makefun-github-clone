// GitHub GraphQL v4 at POST /api/graphql. A small hand-written executor for exactly the
// documents gh and github-mcp-server send: viewer, repository (+ node), issues, pull requests,
// createIssue / closeIssue / createPullRequest / mergePullRequest / addComment, __type
// introspection, and JSON-array batching. Unknown fields -> HTTP 200 + errors naming them.
// Unauthenticated -> exactly 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';
import { flattenTree, parseCommit } from './git-objects.ts';
import { globalId, parseGlobalId, type Forge, type Issue, type PullRequest, type Repo } from './store.ts';
import { isAuthed, readBody, sendError, sendJson } from './rest.ts';

interface GqlError {
  message: string;
  path?: (string | number)[];
}

interface Selection {
  name: string;
  alias: string;
  args: Record<string, unknown>;
  children: Selection[];
}

// ---------------------------------------------------------------------------
// A tiny GraphQL document parser (enough for the suite's documents).

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if ('{}():!@$=&|'.includes(c) || c === '[' || c === ']') {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    // name / number / variable
    let j = i;
    while (j < src.length && /[A-Za-z0-9_.$-]/.test(src[j])) j += 1;
    if (j === i) {
      i += 1;
      continue;
    }
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
}

class Parser {
  toks: string[];
  pos = 0;
  constructor(src: string) {
    this.toks = tokenize(src);
  }
  peek(): string | undefined {
    return this.toks[this.pos];
  }
  next(): string {
    return this.toks[this.pos++];
  }
  expect(t: string): void {
    const got = this.next();
    if (got !== t) throw new Error(`expected ${t}, got ${got}`);
  }

  parseValue(variables: Record<string, unknown>): unknown {
    const t = this.next();
    if (t === '{') {
      const obj: Record<string, unknown> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        obj[key] = this.parseValue(variables);
      }
      this.expect('}');
      return obj;
    }
    if (t === '[') {
      const arr: unknown[] = [];
      while (this.peek() !== ']') arr.push(this.parseValue(variables));
      this.expect(']');
      return arr;
    }
    if (t === '$') {
      const name = this.next();
      return variables[name];
    }
    if (t.startsWith('"')) return JSON.parse(t);
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    const n = Number(t);
    if (t !== '' && !Number.isNaN(n)) return n;
    return t; // enum value as string
  }

  parseArgs(variables: Record<string, unknown>): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    this.expect('(');
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args[name] = this.parseValue(variables);
    }
    this.expect(')');
    return args;
  }

  parseSelectionSet(variables: Record<string, unknown>): Selection[] {
    this.expect('{');
    const sels: Selection[] = [];
    while (this.peek() !== '}') {
      sels.push(this.parseSelection(variables));
    }
    this.expect('}');
    return sels;
  }

  parseSelection(variables: Record<string, unknown>): Selection {
    let tok = this.next();
    if (tok === '...') {
      // Fragment spread or inline fragment: `... on Type { ... }` or `...Frag`.
      const next = this.peek();
      if (next === 'on') {
        this.next();
        this.next(); // type name
        const children = this.parseSelectionSet(variables);
        return { name: '__inline', alias: '__inline', args: {}, children };
      }
      this.next(); // fragment name
      return { name: '__spread', alias: '__spread', args: {}, children: [] };
    }
    let alias = tok;
    let name = tok;
    if (this.peek() === ':') {
      this.next();
      name = this.next();
    }
    let args: Record<string, unknown> = {};
    if (this.peek() === '(') args = this.parseArgs(variables);
    let children: Selection[] = [];
    if (this.peek() === '{') children = this.parseSelectionSet(variables);
    return { name, alias, args, children };
  }

  parseDocument(variables: Record<string, unknown>): { kind: string; name: string; selections: Selection[] } {
    let kind = 'query';
    let name = '';
    let t = this.peek();
    if (t === 'query' || t === 'mutation' || t === 'subscription') {
      kind = this.next();
      t = this.peek();
      if (t !== undefined && t !== '{' && t !== '(') name = this.next();
    }
    // Skip variable definitions (...)
    if (this.peek() === '(') {
      let depth = 0;
      while (this.pos < this.toks.length) {
        const tok = this.next();
        if (tok === '(') depth += 1;
        else if (tok === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
    }
    const selections = this.parseSelectionSet(variables);
    return { kind, name, selections };
  }
}

// ---------------------------------------------------------------------------
// Schema knowledge (for introspection + unknown-field errors).

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Viewer: ['login'],
  User: ['login', 'id', 'name'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'labels', 'comments', 'createdAt', 'updatedAt', 'author', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'mergedAt', 'mergeCommit', 'createdAt', 'updatedAt', 'author'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo'],
  Ref: ['name', 'target'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'createdAt', 'author'],
  __Type: ['fields', 'enumValues', 'name', 'kind'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

const ISSUE_STATE_MAP: Record<string, string> = { OPEN: 'open', CLOSED: 'closed' };

// ---------------------------------------------------------------------------
// Execution context: resolves selections against the store.

class Executor {
  forge: Forge;
  errors: GqlError[] = [];
  constructor(forge: Forge) {
    this.forge = forge;
  }

  findRepoById(id: string): Repo | null {
    const parsed = parseGlobalId(id);
    if (!parsed || parsed.kind !== 'Repository') return null;
    for (const repo of this.forge.repos.values()) {
      if (repo.id === parsed.dbId) return repo;
    }
    return null;
  }

  findIssueById(id: string): { repo: Repo; issue: Issue } | null {
    const parsed = parseGlobalId(id);
    if (!parsed || parsed.kind !== 'Issue') return null;
    for (const repo of this.forge.repos.values()) {
      const issue = repo.issues.find((i) => i.id === parsed.dbId);
      if (issue) return { repo, issue };
    }
    return null;
  }

  findPullById(id: string): { repo: Repo; pr: PullRequest } | null {
    const parsed = parseGlobalId(id);
    if (!parsed || parsed.kind !== 'PullRequest') return null;
    for (const repo of this.forge.repos.values()) {
      const pr = repo.pulls.find((p) => p.id === parsed.dbId);
      if (pr) return { repo, pr };
    }
    return null;
  }

  repoObject(repo: Repo, sels: Selection[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const sel of sels) {
      switch (sel.name) {
        case 'id':
          out[sel.alias] = globalId('Repository', repo.id);
          break;
        case 'databaseId':
          out[sel.alias] = repo.id;
          break;
        case 'name':
          out[sel.alias] = repo.name;
          break;
        case 'nameWithOwner':
          out[sel.alias] = repo.full_name;
          break;
        case 'owner':
          out[sel.alias] = this.userObject(VIEWER.login, sel.children);
          break;
        case 'defaultBranchRef': {
          const tip = this.forge.defaultTip(repo);
          out[sel.alias] = tip ? this.refObject(repo.default_branch, sel.children) : null;
          break;
        }
        case 'viewerPermission':
          out[sel.alias] = 'ADMIN';
          break;
        case 'hasIssuesEnabled':
          out[sel.alias] = true;
          break;
        case 'issue': {
          const n = sel.args.number as number;
          const issue = repo.issues.find((i) => i.number === n);
          out[sel.alias] = issue ? this.issueObject(issue, sel.children) : null;
          break;
        }
        case 'issues':
          out[sel.alias] = this.issuesConnection(repo, sel);
          break;
        case 'pullRequests':
          out[sel.alias] = this.pullsConnection(repo, sel);
          break;
        case 'pullRequest': {
          const n = sel.args.number as number;
          const pr = repo.pulls.find((p) => p.number === n);
          out[sel.alias] = pr ? this.pullObject(repo, pr, sel.children) : null;
          break;
        }
        default:
          this.errors.push({ message: `Cannot query field "${sel.name}" on type "Repository".` });
          break;
      }
    }
    return out;
  }

  refObject(name: string, sels: Selection[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const sel of sels) {
      if (sel.name === 'name') out[sel.alias] = name;
      else if (sel.name === 'id') out[sel.alias] = globalId('Ref', name.length);
      else this.errors.push({ message: `Cannot query field "${sel.name}" on type "Ref".` });
    }
    return out;
  }

  userObject(login: string, sels: Selection[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const sel of sels) {
      if (sel.name === 'login') out[sel.alias] = login;
      else if (sel.name === 'id') out[sel.alias] = globalId('User', 1000);
      else if (sel.name === 'name') out[sel.alias] = login;
      else this.errors.push({ message: `Cannot query field "${sel.name}" on type "User".` });
    }
    return out;
  }

  issueObject(issue: Issue, sels: Selection[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const sel of sels) {
      switch (sel.name) {
        case 'id':
          out[sel.alias] = globalId('Issue', issue.id);
          break;
        case 'number':
          out[sel.alias] = issue.number;
          break;
        case 'title':
          out[sel.alias] = issue.title;
          break;
        case 'state':
          out[sel.alias] = issue.state.toUpperCase();
          break;
        case 'body':
          out[sel.alias] = issue.body;
          break;
        case 'createdAt':
          out[sel.alias] = issue.created_at;
          break;
        case 'updatedAt':
          out[sel.alias] = issue.updated_at;
          break;
        case 'labels':
          out[sel.alias] = { nodes: issue.labels.map((l) => ({ name: l.name })) };
          break;
        case 'comments':
          out[sel.alias] = { nodes: issue.comments.map((c) => ({ id: globalId('IssueComment', c.id), body: c.body })) };
          break;
        case 'author':
          out[sel.alias] = this.userObject(issue.user.login, sel.children);
          break;
        case 'url':
          out[sel.alias] = '';
          break;
        default:
          this.errors.push({ message: `Cannot query field "${sel.name}" on type "Issue".` });
          break;
      }
    }
    return out;
  }

  issuesConnection(repo: Repo, sel: Selection): Record<string, unknown> {
    let list = [...repo.issues];
    const states = sel.args.states as string[] | undefined;
    if (states && states.length > 0) {
      const wanted = new Set(states.map((s) => ISSUE_STATE_MAP[s] ?? s.toLowerCase()));
      list = list.filter((i) => wanted.has(i.state));
    }
    const orderBy = sel.args.orderBy as { field?: string; direction?: string } | undefined;
    if (orderBy?.field === 'CREATED_AT') {
      list.sort((a, b) => {
        const d = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.number - b.number;
        return orderBy.direction === 'DESC' ? -d : d;
      });
    } else {
      list.sort((a, b) => a.number - b.number);
    }
    // Cursor pagination: cursor is base64 of the issue number.
    const after = sel.args.after as string | null | undefined;
    if (after) {
      try {
        const n = Number(Buffer.from(after, 'base64').toString('utf8'));
        if (Number.isFinite(n)) {
          const idx = list.findIndex((i) => i.number === n);
          if (idx >= 0) list = list.slice(idx + 1);
        }
      } catch {
        // ignore a bad cursor
      }
    }
    const first = (sel.args.first as number | undefined) ?? list.length;
    const page = list.slice(0, first);
    const hasNext = list.length > first;
    const endCursor = page.length > 0 ? Buffer.from(String(page[page.length - 1].number), 'utf8').toString('base64') : null;
    const out: Record<string, unknown> = {};
    for (const child of sel.children) {
      if (child.name === 'nodes') out[child.alias] = page.map((i) => this.issueObject(i, child.children));
      else if (child.name === 'edges') out[child.alias] = page.map((i) => ({ node: this.issueObject(i, child.children), cursor: Buffer.from(String(i.number), 'utf8').toString('base64') }));
      else if (child.name === 'pageInfo') {
        const pi: Record<string, unknown> = {};
        for (const f of child.children) {
          if (f.name === 'hasNextPage') pi[f.alias] = hasNext;
          else if (f.name === 'hasPreviousPage') pi[f.alias] = false;
          else if (f.name === 'endCursor') pi[f.alias] = endCursor;
          else if (f.name === 'startCursor') pi[f.alias] = page.length > 0 ? Buffer.from(String(page[0].number), 'utf8').toString('base64') : null;
        }
        out[child.alias] = pi;
      } else if (child.name === 'totalCount') out[child.alias] = list.length;
      else this.errors.push({ message: `Cannot query field "${child.name}" on type "IssueConnection".` });
    }
    return out;
  }

  pullsConnection(repo: Repo, sel: Selection): Record<string, unknown> {
    let list = [...repo.pulls];
    const first = (sel.args.first as number | undefined) ?? list.length;
    const page = list.slice(0, first);
    const out: Record<string, unknown> = {};
    for (const child of sel.children) {
      if (child.name === 'nodes') out[child.alias] = page.map((p) => this.pullObject(repo, p, child.children));
      else if (child.name === 'edges') out[child.alias] = page.map((p) => ({ node: this.pullObject(repo, p, child.children) }));
      else if (child.name === 'pageInfo') {
        const pi: Record<string, unknown> = {};
        for (const f of child.children) {
          if (f.name === 'hasNextPage') pi[f.alias] = list.length > first;
          else if (f.name === 'hasPreviousPage') pi[f.alias] = false;
          else if (f.name === 'endCursor') pi[f.alias] = null;
          else if (f.name === 'startCursor') pi[f.alias] = null;
        }
        out[child.alias] = pi;
      } else if (child.name === 'totalCount') out[child.alias] = list.length;
      else this.errors.push({ message: `Cannot query field "${child.name}" on type "PullRequestConnection".` });
    }
    return out;
  }

  pullObject(repo: Repo, pr: PullRequest, sels: Selection[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const sel of sels) {
      switch (sel.name) {
        case 'id':
          out[sel.alias] = globalId('PullRequest', pr.id);
          break;
        case 'number':
          out[sel.alias] = pr.number;
          break;
        case 'title':
          out[sel.alias] = pr.title;
          break;
        case 'body':
          out[sel.alias] = pr.body;
          break;
        case 'state':
          out[sel.alias] = pr.merged ? 'MERGED' : pr.state.toUpperCase();
          break;
        case 'merged':
          out[sel.alias] = pr.merged;
          break;
        case 'headRefName':
          out[sel.alias] = pr.head.ref;
          break;
        case 'baseRefName':
          out[sel.alias] = pr.base.ref;
          break;
        case 'mergeable':
          out[sel.alias] = pr.state === 'open' ? 'MERGEABLE' : 'UNKNOWN';
          break;
        case 'mergedAt':
          out[sel.alias] = pr.merged_at;
          break;
        case 'mergeCommit':
          out[sel.alias] = pr.merge_commit_sha ? { oid: pr.merge_commit_sha } : null;
          break;
        case 'createdAt':
          out[sel.alias] = pr.created_at;
          break;
        case 'updatedAt':
          out[sel.alias] = pr.updated_at;
          break;
        case 'author':
          out[sel.alias] = this.userObject(pr.user.login, sel.children);
          break;
        case 'files': {
          const first = (sel.args.first as number | undefined) ?? 100;
          const files = this.forge.diffCommits(repo, pr.baseShaAtCreate, pr.headShaAtCreate).slice(0, first);
          const nodes: Record<string, unknown>[] = [];
          for (const f of files) {
            const node: Record<string, unknown> = {};
            for (const child of sel.children) {
              if (child.name === 'nodes') {
                node[child.alias] = files.map((ff) => {
                  const n: Record<string, unknown> = {};
                  for (const g of child.children) {
                    if (g.name === 'path') n[g.alias] = ff.filename;
                    else if (g.name === 'additions') n[g.alias] = ff.additions;
                    else if (g.name === 'deletions') n[g.alias] = ff.deletions;
                    else if (g.name === 'changeType') n[g.alias] = ff.status.toUpperCase();
                  }
                  return n;
                });
              } else if (child.name === 'pageInfo') node[child.alias] = { hasNextPage: false, endCursor: null };
              else if (child.name === 'totalCount') node[child.alias] = files.length;
            }
            nodes.push(node);
          }
          // files is itself a connection object, not a list.
          const conn: Record<string, unknown> = {};
          for (const child of sel.children) {
            if (child.name === 'nodes') {
              conn[child.alias] = files.map((ff) => {
                const n: Record<string, unknown> = {};
                for (const g of child.children) {
                  if (g.name === 'path') n[g.alias] = ff.filename;
                  else if (g.name === 'additions') n[g.alias] = ff.additions;
                  else if (g.name === 'deletions') n[g.alias] = ff.deletions;
                  else if (g.name === 'changeType') n[g.alias] = ff.status.toUpperCase();
                }
                return n;
              });
            } else if (child.name === 'pageInfo') conn[child.alias] = { hasNextPage: false, endCursor: null };
            else if (child.name === 'totalCount') conn[child.alias] = files.length;
          }
          out[sel.alias] = conn;
          void nodes;
          break;
        }
        default:
          this.errors.push({ message: `Cannot query field "${sel.name}" on type "PullRequest".` });
          break;
      }
    }
    return out;
  }

  typeObject(name: string, sels: Selection[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const fields = TYPE_FIELDS[name];
    const enums = ENUM_VALUES[name];
    for (const sel of sels) {
      if (sel.name === 'name') out[sel.alias] = name;
      else if (sel.name === 'kind') out[sel.alias] = fields ? 'OBJECT' : enums ? 'ENUM' : 'SCALAR';
      else if (sel.name === 'fields') {
        out[sel.alias] = fields
          ? fields.map((f) => {
              const o: Record<string, unknown> = { name: f };
              for (const child of sel.children) {
                if (child.name === 'name') o[child.alias] = f;
                else if (child.name === 'type') o[child.alias] = { name: 'String', kind: 'SCALAR' };
              }
              return o;
            })
          : null;
      } else if (sel.name === 'enumValues') {
        out[sel.alias] = enums
          ? enums.map((v) => {
              const o: Record<string, unknown> = { name: v };
              for (const child of sel.children) {
                if (child.name === 'name') o[child.alias] = v;
              }
              return o;
            })
          : null;
      }
    }
    return out;
  }

  execute(doc: { kind: string; selections: Selection[] }): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    if (doc.kind === 'mutation') {
      for (const sel of doc.selections) this.executeMutation(sel, data);
      return data;
    }
    for (const sel of doc.selections) {
      if (sel.name === '__inline' || sel.name === '__spread') {
        for (const child of sel.children) this.executeQueryField(child, data);
        continue;
      }
      this.executeQueryField(sel, data);
    }
    return data;
  }

  executeQueryField(sel: Selection, data: Record<string, unknown>): void {
    switch (sel.name) {
      case 'viewer':
        data[sel.alias] = this.userObject(VIEWER.login, sel.children);
        break;
      case 'repository': {
        const owner = sel.args.owner as string;
        const name = sel.args.name as string;
        const repo = owner === VIEWER.login ? this.forge.getRepo(owner, name) ?? null : null;
        data[sel.alias] = repo ? this.repoObject(repo, sel.children) : null;
        break;
      }
      case 'node': {
        const id = sel.args.id as string;
        const repo = this.findRepoById(id);
        if (repo) {
          const node: Record<string, unknown> = { id: globalId('Repository', repo.id) };
          for (const child of sel.children) {
            if (child.name === '__inline') {
              for (const g of child.children) {
                if (g.name === 'name') node[g.alias] = repo.name;
                else if (g.name === 'nameWithOwner') node[g.alias] = repo.full_name;
                else if (g.name === 'id') node[g.alias] = globalId('Repository', repo.id);
              }
            } else if (child.name === 'id') node[child.alias] = globalId('Repository', repo.id);
          }
          data[sel.alias] = node;
        } else {
          const issue = this.findIssueById(id);
          if (issue) {
            data[sel.alias] = { id: globalId('Issue', issue.issue.id) };
          } else {
            data[sel.alias] = null;
          }
        }
        break;
      }
      case '__type': {
        const name = sel.args.name as string;
        data[sel.alias] = this.typeObject(name, sel.children);
        break;
      }
      case '__schema': {
        const out: Record<string, unknown> = {};
        for (const child of sel.children) {
          if (child.name === 'types') out[child.alias] = Object.keys(TYPE_FIELDS).map((n) => ({ name: n }));
          else if (child.name === 'queryType') out[child.alias] = { name: 'Query' };
          else if (child.name === 'mutationType') out[child.alias] = { name: 'Mutation' };
        }
        data[sel.alias] = out;
        break;
      }
      default:
        this.errors.push({ message: `Cannot query field "${sel.name}" on type "Query".` });
        data[sel.alias] = null;
        break;
    }
  }

  executeMutation(sel: Selection, data: Record<string, unknown>): void {
    const input = (sel.args.input ?? {}) as Record<string, unknown>;
    const payload: Record<string, unknown> = {};
    switch (sel.name) {
      case 'createIssue': {
        const repo = this.findRepoById(String(input.repositoryId ?? ''));
        if (!repo) {
          this.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
          data[sel.alias] = null;
          return;
        }
        const now = this.forge.clock.nowIso();
        const issue: Issue = {
          id: repo.nextIssueId++,
          number: repo.nextIssueNumber++,
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
          state: 'open',
          labels: [],
          comments: [],
          created_at: now,
          updated_at: now,
          user: { login: VIEWER.login },
        };
        repo.issues.push(issue);
        for (const child of sel.children) {
          if (child.name === 'issue') payload[child.alias] = this.issueObject(issue, child.children);
        }
        data[sel.alias] = payload;
        return;
      }
      case 'closeIssue': {
        const found = this.findIssueById(String(input.issueId ?? ''));
        if (!found) {
          this.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
          data[sel.alias] = null;
          return;
        }
        found.issue.state = 'closed';
        found.issue.updated_at = this.forge.clock.nowIso();
        for (const child of sel.children) {
          if (child.name === 'issue') payload[child.alias] = this.issueObject(found.issue, child.children);
        }
        data[sel.alias] = payload;
        return;
      }
      case 'createPullRequest': {
        const repo = this.findRepoById(String(input.repositoryId ?? ''));
        const headRef = String(input.headRefName ?? '');
        const baseRef = String(input.baseRefName ?? '');
        if (!repo) {
          this.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
          data[sel.alias] = null;
          return;
        }
        const headSha = this.forge.resolveRef(repo, headRef);
        const baseSha = this.forge.resolveRef(repo, baseRef);
        if (!headSha || !baseSha) {
          this.errors.push({ message: 'Head or base ref not found.' });
          data[sel.alias] = null;
          return;
        }
        const now = this.forge.clock.nowIso();
        const pr: PullRequest = {
          id: repo.nextPullId++,
          number: repo.nextPullNumber++,
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
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
        for (const child of sel.children) {
          if (child.name === 'pullRequest') payload[child.alias] = this.pullObject(repo, pr, child.children);
        }
        data[sel.alias] = payload;
        return;
      }
      case 'mergePullRequest': {
        const found = this.findPullById(String(input.pullRequestId ?? ''));
        if (!found) {
          this.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
          data[sel.alias] = null;
          return;
        }
        const { repo, pr } = found;
        if (pr.state === 'open') {
          const mergeSha = this.forge.squashMerge(repo, pr);
          if (mergeSha === null) {
            this.errors.push({ message: 'Merge conflict.' });
            data[sel.alias] = null;
            return;
          }
          pr.state = 'closed';
          pr.merged = true;
          pr.merged_at = this.forge.clock.nowIso();
          pr.merge_commit_sha = mergeSha;
          pr.updated_at = pr.merged_at;
        }
        for (const child of sel.children) {
          if (child.name === 'pullRequest') payload[child.alias] = this.pullObject(repo, pr, child.children);
        }
        data[sel.alias] = payload;
        return;
      }
      case 'addComment': {
        const found = this.findIssueById(String(input.subjectId ?? ''));
        if (!found) {
          this.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
          data[sel.alias] = null;
          return;
        }
        const now = this.forge.clock.nowIso();
        const comment = { id: found.repo.nextCommentId++, body: String(input.body ?? ''), created_at: now, updated_at: now, user: { login: VIEWER.login } };
        found.issue.comments.push(comment);
        for (const child of sel.children) {
          if (child.name === 'commentEdge') {
            const edge: Record<string, unknown> = {};
            for (const g of child.children) {
              if (g.name === 'node') {
                const node: Record<string, unknown> = {};
                for (const h of g.children) {
                  if (h.name === 'id') node[h.alias] = globalId('IssueComment', comment.id);
                  else if (h.name === 'body') node[h.alias] = comment.body;
                }
                edge[g.alias] = node;
              }
            }
            payload[child.alias] = edge;
          } else if (child.name === 'comment') {
            payload[child.alias] = { id: globalId('IssueComment', comment.id), body: comment.body };
          }
        }
        data[sel.alias] = payload;
        return;
      }
      default:
        this.errors.push({ message: `Cannot query field "${sel.name}" on type "Mutation".` });
        data[sel.alias] = null;
        return;
    }
  }
}

export async function handleGraphQL(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!isAuthed(req)) {
    sendError(forge, res, 401, 'Requires authentication');
    return true;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendError(forge, res, 400, 'Problems parsing JSON');
    return true;
  }
  const ops = Array.isArray(parsed) ? parsed : [parsed];
  const results = ops.map((op) => {
    const query = typeof (op as Record<string, unknown>)?.query === 'string' ? ((op as Record<string, unknown>).query as string) : '';
    const variables = ((op as Record<string, unknown>)?.variables ?? {}) as Record<string, unknown>;
    const executor = new Executor(forge);
    try {
      const doc = new Parser(query).parseDocument(variables);
      const data = executor.execute(doc);
      const out: Record<string, unknown> = { data };
      if (executor.errors.length > 0) out.errors = executor.errors;
      return out;
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  });
  sendJson(forge, res, 200, Array.isArray(parsed) ? results : results[0]);
  return true;
}

// Keep the import used (flattenTree/parseCommit are used by store; here for tree reads if needed).
void flattenTree;
void parseCommit;
