import { execSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * npm run smoke — fresh-clone simulation:
 *   git archive HEAD → temp dir → npm install → seed → boot server →
 *   assert /api/health, /api/overview, one entity route → PASS/FAIL → teardown.
 * Uses PORT 3101 so a running dev stack is untouched.
 */

const PORT = 3101;
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 60_000;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`check failed: ${name}`);
};

const tempDir = mkdtempSync(join(tmpdir(), 'argus-smoke-'));
let server = null;

const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

async function waitForHealth() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return (await res.json());
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server did not answer /api/health within ${BOOT_TIMEOUT_MS / 1000}s`);
}

try {
  console.log(`[smoke] fresh checkout → ${tempDir}`);
  // checkout-index is portable (Windows tar variants mangle drive paths).
  const fwd = tempDir.replaceAll('\\', '/');
  execSync(`git checkout-index -a --prefix="${fwd}/"`, { stdio: 'inherit' });

  console.log('[smoke] npm install (this is the slow step)…');
  sh('npm install --no-audit --no-fund', tempDir);

  console.log('[smoke] npm run seed…');
  const seedOut = sh('npm run seed', tempDir);
  check('seed populates a fresh DB', /\[seed\] done: \d+ models/.test(seedOut));

  console.log('[smoke] booting server…');
  server = spawn('npm', ['run', 'start', '-w', 'server'], {
    cwd: tempDir,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
    shell: true,
  });

  const health = await waitForHealth();
  check('/api/health responds ok', health.ok === true);

  const overview = await (await fetch(`${BASE}/api/overview`)).json();
  check('/api/overview envelope shape', 'data' in overview && 'asOf' in overview);
  check('overview has models', overview.data.stats.models > 100, `${overview.data.stats.models} models`);
  check('overview has news', overview.data.news.length > 0, `${overview.data.news.length} items`);
  check(
    'overview frontier gap computed',
    typeof overview.data.frontier.gap === 'number',
    `gap ${overview.data.frontier.gap?.toFixed(1)}`,
  );

  const des = await (await fetch(`${BASE}/api/models/anthropic/claude-fable-5`)).json();
  check('entity route resolves', des.data.model.id === 'anthropic/claude-fable-5');
  check('entity has pricing', typeof des.data.pricing?.prompt_usd_per_mtok === 'number');
  check('entity has arena standings', des.data.arena.length > 0, `${des.data.arena.length} categories`);

  const board = await (await fetch(`${BASE}/api/arena/leaderboard?category=text`)).json();
  check('leaderboard has historical rows', board.data.rows.length > 50, `${board.data.rows.length} rows`);

  console.log(`\n[smoke] PASS — ${results.length}/${results.length} checks green`);
} catch (err) {
  console.error(`\n[smoke] FAIL — ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  if (server?.pid) {
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        /* already gone */
      }
    } else {
      server.kill('SIGTERM');
    }
  }
  // Windows can hold file locks briefly after taskkill.
  await new Promise((r) => setTimeout(r, 1500));
  try {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    console.log('[smoke] teardown complete');
  } catch {
    console.warn(`[smoke] teardown incomplete — remove manually: ${tempDir}`);
  }
}