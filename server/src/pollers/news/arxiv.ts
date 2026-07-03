import type Database from 'better-sqlite3';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import type { Poller } from '../../scheduler/scheduler';
import { buildMentionIndex, extractMentions, type MentionIndex } from './mentions';

/**
 * arXiv news poller (cs.CL / cs.LG / cs.AI). Observed (fixture
 * arxiv-sample.xml): Atom feed, entries carry id (…/abs/XXXX.XXXXX),
 * title, summary, published. Politeness: arXiv asks ≤ 1 request / 3s —
 * this poller makes exactly ONE request per hourly run (max_results=50)
 * with a descriptive User-Agent. Plain http:// 301s; use https.
 * Note: export.arxiv.org intermittently returns 503 (observed live); that
 * fails the run and the scheduler's backoff handles the retry.
 */

const ARXIV_URL =
  'https://export.arxiv.org/api/query?search_query=cat:cs.CL+OR+cat:cs.LG+OR+cat:cs.AI' +
  '&sortBy=submittedDate&sortOrder=descending&max_results=50';
const USER_AGENT = 'ArgusTerminal/0.1 (local research tool)';

const parser = new XMLParser({
  ignoreAttributes: true,
  isArray: (name) => name === 'entry',
});

const entrySchema = z.object({
  id: z.string().min(1),
  title: z.coerce.string().min(1),
  summary: z.coerce.string().optional(),
  published: z.string().min(1),
});

const feedSchema = z.object({
  feed: z.object({
    entry: z.array(z.unknown()).default([]),
  }),
});

export interface ArxivIngestStats {
  items: number;
  inserted: number;
  skippedMalformed: number;
}

export function ingestArxivFeed(db: Database.Database, index: MentionIndex, xml: string): ArxivIngestStats {
  const doc = feedSchema.parse(parser.parse(xml)); // envelope failure = poll failure
  const entries = doc.feed.entry;
  const stats: ArxivIngestStats = { items: entries.length, inserted: 0, skippedMalformed: 0 };
  const insert = db.prepare(
    `INSERT OR IGNORE INTO news_item (id, ts, source, title, url, summary, salience, model_ids, org)
     VALUES (?, ?, 'arxiv', ?, ?, ?, NULL, ?, NULL)`,
  );

  db.transaction(() => {
    for (const raw of entries) {
      const parsed = entrySchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        console.warn(`[arxiv] skipping malformed entry: ${issue?.path.join('.')} ${issue?.message}`);
        stats.skippedMalformed++;
        continue;
      }
      const entry = parsed.data;
      const absId = entry.id.split('/abs/')[1] ?? entry.id;
      const title = entry.title.replace(/\s+/g, ' ').trim();
      const summary = entry.summary ? entry.summary.replace(/\s+/g, ' ').trim().slice(0, 500) : null;
      stats.inserted += insert.run(
        `arxiv:${absId}`,
        entry.published,
        title,
        `https://arxiv.org/abs/${absId}`,
        summary,
        JSON.stringify(extractMentions(index, `${title} ${summary ?? ''}`)),
      ).changes;
    }
  })();

  return stats;
}

export function createArxivPoller(db: Database.Database): Poller {
  return {
    name: 'arxiv',
    cadence: 60 * 60 * 1000,
    async run() {
      const res = await fetch(ARXIV_URL, {
        headers: { accept: 'application/atom+xml', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`arxiv HTTP ${res.status}`);
      const index = buildMentionIndex(db);
      const stats = ingestArxivFeed(db, index, await res.text());
      console.log(`[arxiv] poll ok: ${stats.inserted} new of ${stats.items} entries`);
    },
  };
}
