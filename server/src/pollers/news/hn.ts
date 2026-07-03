import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { Poller } from '../../scheduler/scheduler';
import { buildMentionIndex, extractMentions, type MentionIndex } from './mentions';

/**
 * HN Algolia news poller. Observed shape (fixture hn-search.json): envelope
 * {hits: [...]} where a hit has objectID, created_at (ISO Z), title, url
 * (null on Ask/Show HN — 10/50 in the sample; the HN item page is the
 * fallback link), points, num_comments, story_text, _tags. Salience = points.
 */

const HN_URL = 'https://hn.algolia.com/api/v1/search_by_date';
const QUERIES = ['LLM', 'language model', 'OpenAI', 'Anthropic', 'Claude', 'Gemini', 'DeepSeek', 'Mistral'];
const QUERY_DELAY_MS = 200;

const hnHitSchema = z.object({
  objectID: z.string().min(1),
  created_at: z.string().min(1),
  title: z.string().min(1),
  url: z.string().nullish(),
  points: z.number().nullish(),
});

const hnEnvelopeSchema = z.object({ hits: z.array(z.unknown()) });

export interface NewsIngestStats {
  items: number;
  inserted: number;
  skippedMalformed: number;
}

export function ingestHnHits(db: Database.Database, index: MentionIndex, payload: unknown): NewsIngestStats {
  const envelope = hnEnvelopeSchema.parse(payload); // envelope failure = poll failure
  const stats: NewsIngestStats = { items: envelope.hits.length, inserted: 0, skippedMalformed: 0 };
  const insert = db.prepare(
    `INSERT OR IGNORE INTO news_item (id, ts, source, title, url, summary, salience, model_ids, org)
     VALUES (?, ?, 'hn', ?, ?, NULL, ?, ?, NULL)`,
  );

  db.transaction(() => {
    for (const raw of envelope.hits) {
      const parsed = hnHitSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        console.warn(`[hn] skipping malformed hit: ${issue?.path.join('.')} ${issue?.message}`);
        stats.skippedMalformed++;
        continue;
      }
      const hit = parsed.data;
      stats.inserted += insert.run(
        `hn:${hit.objectID}`,
        hit.created_at,
        hit.title,
        hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
        hit.points ?? 0,
        JSON.stringify(extractMentions(index, hit.title)),
      ).changes;
    }
  })();

  return stats;
}

export function createHnPoller(db: Database.Database): Poller {
  return {
    name: 'hn',
    cadence: 15 * 60 * 1000,
    async run() {
      const index = buildMentionIndex(db);
      let inserted = 0;
      for (const query of QUERIES) {
        const url = new URL(HN_URL);
        url.searchParams.set('query', query);
        url.searchParams.set('tags', 'story');
        url.searchParams.set('hitsPerPage', '30');
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`hn HTTP ${res.status} for "${query}"`);
        const stats = ingestHnHits(db, index, await res.json());
        inserted += stats.inserted;
        await new Promise((resolve) => setTimeout(resolve, QUERY_DELAY_MS));
      }
      console.log(`[hn] poll ok: ${inserted} new items across ${QUERIES.length} queries`);
    },
  };
}
