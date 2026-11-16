// The forge's HTTP server: git smart HTTP, REST v3, GraphQL v4 and MCP, one process.
// main.ts (the lifecycle) is unchanged from the starter.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './git-proto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, sendJson } from './rest.ts';
import { Forge } from './store.ts';

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(forge, res, 200, { ok: true });
          return;
        }

        if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
          if (await handleGit(forge, req, res, path)) return;
        }

        if (path === '/api/graphql' && method === 'POST') {
          if (await handleGraphQL(forge, req, res)) return;
        }

        if (path === '/mcp') {
          if (await handleMcp(forge, req, res)) return;
        }

        if (path.startsWith('/api/v3')) {
          if (await handleRest(forge, req, res, path)) return;
        }

        sendJson(forge, res, 404, { message: 'Not Found' });
      } catch (err) {
        // Never leak a stack or HTML: a JSON 500 for an unexpected failure.
        try {
          sendJson(forge, res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          // The response is already gone; nothing more to do.
        }
      }
    })();
  });
}
