// Entry lifecycle for the trial harness (the contract lives in env/src/wire.ts).
//
// This process is a thin bridge between the trial environment and the forge
// server built by app.ts. Its whole life is five steps:
//   1. Read MAKEFUN_ENV_URL. It names the env's origin (http://store:8080
//      inside a trial container). Without it there is nobody to talk to, so
//      the process exits 1 right away.
//   2. Start the app on an ephemeral port via listen(0) and let the kernel
//      pick the number. Port 8080 belongs to the env; never bind it.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. The env records the
//      caller's address plus N as this entry's base URL and dials it from
//      then on. The first register wins; a 409 means another entry already
//      registered, and this process just keeps waiting like any other.
//   4. Poll GET $MAKEFUN_ENV_URL/done until the body reads {"done": true}.
//      The env answers each poll at once ({"done": false} while the suite
//      runs), so this is a short poll loop, not one long-held request. A
//      failed or slow poll is retried with a short exponential backoff; the
//      process never exits before the env says done.
//   5. Close the server and exit 0. The harness then stops the env, which
//      writes the export the scorer reads.
//
// main.ts only starts the server from app.ts and talks to the env: no
// packages, no extra Node built-ins, no model calls.

import { createApp } from './app.ts';

// The env's origin, with any trailing slashes stripped off.
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// The two env endpoints this process ever calls.
const REGISTER_URL = `${ENV_URL}/register`;
const DONE_URL = `${ENV_URL}/done`;

/** How long a single register or done request may run before it is dropped and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Backoff between retries: start here, double after each failure, never pass the cap. */
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;

/** Wait `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff after `failures` consecutive failed attempts: exponential, capped. */
function backoff(failures: number): number {
  const doubled = BACKOFF_START_MS * 2 ** Math.min(failures, 8);
  return Math.min(BACKOFF_CAP_MS, doubled);
}

/**
 * POST the bound port to the env until it is accepted. 200 is the normal
 * answer; 409 means a first register already won, which is not this
 * process's to fix. 400 and 405 are contract errors and end the program;
 * a network error or any other status is retried, since the env may still
 * be starting.
 */
async function register(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(REGISTER_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(backoff(failures));
  }
}

/** Poll GET /done until the env reports {"done": true}; never return sooner. */
async function waitForDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(DONE_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // No answer, or the poll timed out: the trial is not done yet.
    }
    await sleep(backoff(failures));
  }
}

/** Bind, register, wait for done: the whole life of the process. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
