import type Database from 'better-sqlite3';
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SseEvent } from '@argus/shared';

/**
 * PHASE-4 SSE (§6): GET /api/stream pushes compact change events after each
 * poll cycle so the terminal can tick without re-polling. The scheduler's
 * onRunComplete hook feeds this hub; change detection is watermark-based
 * (max snapshot ts / news rowid seen at boot, advanced after every poll), so
 * events carry exactly the just-changed model ids and nothing else.
 *
 * Events (shared/src/types.ts SseEvent):
 *   snapshot — a market-data facet changed for these model ids
 *   news     — new news_item rows landed
 *   status   — every poller run's outcome (drives the status bar live)
 * A `: keepalive` comment goes out every ~25s per connection.
 */

const KEEPALIVE_MS = 25_000;

/** source_status name → snapshot table it writes, for change detection. */
const SNAPSHOT_SOURCES: Record<string, { table: string; field: 'price' | 'arena' | 'downloads' }> = {
  openrouter: { table: 'price_snapshot', field: 'price' },
  lmarena: { table: 'arena_snapshot', field: 'arena' },
  'hf-hub': { table: 'hub_snapshot', field: 'downloads' },
};

function isNewsSource(source: string): boolean {
  return source === 'hn' || source === 'arxiv' || source.startsWith('rss:');
}

export class SseHub {
  private readonly clients = new Set<(e: SseEvent) => void>();
  private readonly watermarks = new Map<string, string>(); // table → max ts
  private newsWatermark: number; // news_item max rowid
  private eventId = 0;

  constructor(private readonly db: Database.Database) {
    for (const { table } of Object.values(SNAPSHOT_SOURCES)) {
      this.watermarks.set(table, this.maxTs(table));
    }
    this.newsWatermark = (
      db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS wm FROM news_item`).get() as { wm: number }
    ).wm;
  }

  private maxTs(table: string): string {
    return (this.db.prepare(`SELECT COALESCE(MAX(ts), '') AS wm FROM ${table}`).get() as { wm: string })
      .wm;
  }

  register(app: Hono): void {
    app.get('/api/stream', (c) =>
      streamSSE(c, async (stream) => {
        let open = true;
        const send = (e: SseEvent): void => {
          void stream
            .writeSSE({ event: e.type, data: JSON.stringify(e), id: String(++this.eventId) })
            .catch(() => {
              open = false;
            });
        };
        this.clients.add(send);
        stream.onAbort(() => {
          open = false;
          this.clients.delete(send);
        });
        try {
          while (open) {
            await stream.write(`: keepalive\n\n`);
            await stream.sleep(KEEPALIVE_MS);
          }
        } finally {
          this.clients.delete(send);
        }
      }),
    );
  }

  /** Wired to Scheduler.onRunComplete in index.ts. */
  handleRunComplete(source: string, ok: boolean): void {
    if (source === 'heartbeat') return;
    const ts = new Date().toISOString();

    const status = this.db
      .prepare(`SELECT consecutive_failures FROM source_status WHERE source = ?`)
      .get(source) as { consecutive_failures: number } | undefined;
    this.broadcast({
      type: 'status',
      source,
      ok,
      consecutive_failures: status?.consecutive_failures ?? 0,
      ts,
    });
    if (!ok) return;

    const snapshot = SNAPSHOT_SOURCES[source];
    if (snapshot) {
      const since = this.watermarks.get(snapshot.table) ?? '';
      const rows = this.db
        .prepare(`SELECT DISTINCT model_id FROM ${snapshot.table} WHERE ts > ?`)
        .all(since) as { model_id: string }[];
      this.watermarks.set(snapshot.table, this.maxTs(snapshot.table));
      if (rows.length > 0) {
        this.broadcast({
          type: 'snapshot',
          source,
          fields: [snapshot.field],
          model_ids: rows.map((r) => r.model_id).sort(),
          ts,
        });
      }
      return;
    }

    if (isNewsSource(source)) {
      const rows = this.db
        .prepare(`SELECT rowid, id, model_ids FROM news_item WHERE rowid > ?`)
        .all(this.newsWatermark) as { rowid: number; id: string; model_ids: string }[];
      if (rows.length === 0) return;
      this.newsWatermark = Math.max(...rows.map((r) => r.rowid));
      const modelIds = new Set<string>();
      for (const r of rows) {
        for (const id of JSON.parse(r.model_ids) as string[]) modelIds.add(id);
      }
      this.broadcast({
        type: 'news',
        ids: rows.map((r) => r.id),
        model_ids: [...modelIds].sort(),
        ts,
      });
    }
  }

  private broadcast(event: SseEvent): void {
    for (const send of this.clients) send(event);
  }
}