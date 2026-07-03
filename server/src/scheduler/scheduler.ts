import type Database from 'better-sqlite3';
import {
  ensureSourceStatus,
  recordSourceFailure,
  recordSourceSuccess,
} from '../db/db';

/** Contract every poller implements (§6). */
export interface Poller {
  /** Source name; keys the source_status table. */
  name: string;
  /** Milliseconds between successful runs. */
  cadence: number;
  /** One poll. Throwing marks the source failed and triggers backoff. */
  run(): Promise<void>;
}

/** Failures never push the retry interval past this. */
const MAX_BACKOFF_MS = 60 * 60 * 1000;
/** First runs are jittered so pollers don't all fire at boot simultaneously. */
const MAX_START_JITTER_MS = 10_000;

/**
 * In-process interval scheduler (§6). setTimeout chains rather than
 * setInterval so a slow run never overlaps itself and failure backoff can
 * stretch the gap: next delay = cadence * 2^consecutive_failures, capped.
 * Every run's outcome is written to source_status.
 */
export class Scheduler {
  private readonly pollers: Poller[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();

  /**
   * PHASE-4: called after every poller run (success or failure) — the SSE
   * layer derives change events from it. Runs outside the poller's try/catch
   * so a hook error is never recorded as a source failure.
   */
  onRunComplete?: (source: string, ok: boolean) => void;

  constructor(private readonly db: Database.Database) {}

  register(poller: Poller): void {
    ensureSourceStatus(this.db, poller.name);
    this.pollers.push(poller);
  }

  start(): void {
    for (const poller of this.pollers) {
      const jitter = Math.random() * Math.min(poller.cadence, MAX_START_JITTER_MS);
      console.log(
        `[scheduler] ${poller.name}: cadence ${poller.cadence}ms, first run in ${Math.round(jitter)}ms`,
      );
      this.schedule(poller, jitter);
    }
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private schedule(poller: Poller, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.runOnce(poller);
    }, delayMs);
    this.timers.add(timer);
  }

  private async runOnce(poller: Poller): Promise<void> {
    let ok = true;
    try {
      await poller.run();
      recordSourceSuccess(this.db, poller.name);
      this.schedule(poller, poller.cadence);
    } catch (err) {
      ok = false;
      const message = err instanceof Error ? err.message : String(err);
      const failures = recordSourceFailure(this.db, poller.name, message);
      const backoff = Math.min(poller.cadence * 2 ** failures, MAX_BACKOFF_MS);
      console.error(
        `[scheduler] ${poller.name} failed (${failures} consecutive): ${message} — retrying in ${backoff}ms`,
      );
      this.schedule(poller, backoff);
    }
    this.onRunComplete?.(poller.name, ok);
  }
}
