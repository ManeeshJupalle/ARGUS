import type Database from 'better-sqlite3';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import type { Poller } from '../../scheduler/scheduler';
import { buildMentionIndex, extractMentions, type MentionIndex } from './mentions';

/**
 * Lab blog RSS pollers. Feed URLs verified live 2026-07-03 (fixtures
 * rss-openai.xml / rss-deepmind.xml / rss-qwen.xml — all RSS 2.0
 * <rss><channel><item> with title/link/pubDate/description, CDATA-wrapped):
 *   openai          https://openai.com/news/rss.xml          → 200 ✓
 *   google-deepmind https://deepmind.google/blog/rss.xml     → 200 ✓
 *   qwen            https://qwenlm.github.io/blog/index.xml  → 200 ✓
 * No working public feed was found for the remaining §4 labs (all candidates
 * returned 404 at build time): anthropic (/news/rss.xml, /rss.xml),
 * meta (ai.meta.com/blog/rss/, about.fb.com/news/category/ai/feed/),
 * mistral (/feed.xml, /news/rss.xml, /news/feed.xml), x-ai (/rss.xml,
 * /blog/rss.xml, /blog/feed), deepseek (deepseek.com/rss.xml, api-docs and
 * www /blog/rss.xml). Those labs are covered via the HN poller instead; a
 * feed that later dies simply fails its own source_status row and backs off.
 */

export interface LabFeed {
  name: string; // scheduler/source_status name
  org: string; // news_item.org
  url: string;
}

export const LAB_FEEDS: LabFeed[] = [
  { name: 'rss:openai', org: 'openai', url: 'https://openai.com/news/rss.xml' },
  { name: 'rss:google-deepmind', org: 'google-deepmind', url: 'https://deepmind.google/blog/rss.xml' },
  { name: 'rss:qwen', org: 'qwen', url: 'https://qwenlm.github.io/blog/index.xml' },
];

const parser = new XMLParser({
  ignoreAttributes: true,
  isArray: (name) => name === 'item',
});

const rssItemSchema = z.object({
  title: z.coerce.string().min(1),
  link: z.string().min(1),
  pubDate: z.string().optional(),
  description: z.coerce.string().optional(),
});

const rssDocSchema = z.object({
  rss: z.object({
    channel: z.object({
      item: z.array(z.unknown()).default([]),
    }),
  }),
});

/** FNV-1a 32-bit — stable short id component for feed item links. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface RssIngestStats {
  items: number;
  inserted: number;
  skippedMalformed: number;
}

export function ingestRssFeed(
  db: Database.Database,
  index: MentionIndex,
  org: string,
  xml: string,
): RssIngestStats {
  const doc = rssDocSchema.parse(parser.parse(xml)); // envelope failure = poll failure
  const items = doc.rss.channel.item;
  const stats: RssIngestStats = { items: items.length, inserted: 0, skippedMalformed: 0 };
  const insert = db.prepare(
    `INSERT OR IGNORE INTO news_item (id, ts, source, title, url, summary, salience, model_ids, org)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  );

  db.transaction(() => {
    for (const raw of items) {
      const parsed = rssItemSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        console.warn(`[rss:${org}] skipping malformed item: ${issue?.path.join('.')} ${issue?.message}`);
        stats.skippedMalformed++;
        continue;
      }
      const item = parsed.data;
      const published = item.pubDate ? new Date(item.pubDate) : null;
      const ts =
        published !== null && !Number.isNaN(published.getTime())
          ? published.toISOString()
          : new Date().toISOString();
      const summary = item.description ? stripHtml(item.description).slice(0, 500) : null;
      stats.inserted += insert.run(
        `rss:${org}:${fnv1a(item.link)}`,
        ts,
        `rss:${org}`,
        item.title.trim(),
        item.link,
        summary,
        JSON.stringify(extractMentions(index, `${item.title} ${summary ?? ''}`)),
        org,
      ).changes;
    }
  })();

  return stats;
}

export function createRssPoller(db: Database.Database, feed: LabFeed): Poller {
  return {
    name: feed.name,
    cadence: 30 * 60 * 1000,
    async run() {
      const res = await fetch(feed.url, {
        headers: { accept: 'application/rss+xml, application/xml, text/xml' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`${feed.name} HTTP ${res.status}`);
      const index = buildMentionIndex(db);
      const stats = ingestRssFeed(db, index, feed.org, await res.text());
      console.log(`[${feed.name}] poll ok: ${stats.inserted} new of ${stats.items} items`);
    },
  };
}
