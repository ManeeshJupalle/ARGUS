import type Database from 'better-sqlite3';
import type { Poller } from '../scheduler/scheduler';

// PHASE-1 ONLY: demo poller proving the scheduler loop end-to-end.
// PHASE-2 replaces this pattern with the real OpenRouter poller
// (fetch → zod-parse → resolve entities → write snapshots in one transaction).
export function createHeartbeatPoller(db: Database.Database): Poller {
  const insert = db.prepare('INSERT INTO heartbeat (ts) VALUES (?)');
  return {
    name: 'heartbeat',
    cadence: 5_000,
    async run() {
      insert.run(new Date().toISOString());
    },
  };
}
