import { useCallback, useEffect, useRef, useState } from 'react';
import { findCommand } from '@argus/shared';
import type { CommandSpec, Envelope, NewsItem, Overview } from '@argus/shared';
import { api } from '../api/client';
import { onSseEvent, onSseState } from '../api/sse';
import { FlashValue } from '../components/FlashValue';
import { Panel } from '../components/Panel';
import { deltaClass, fmtCompact, fmtDate, fmtDelta, fmtPct, fmtPrice, fmtTime, sourceCode } from '../lib/fmt';
import { useArgusStore } from '../store/store';
import styles from './Top.module.css';

const REFETCH_DEBOUNCE_MS = 400;
const TREND_LOOKBACK_POINTS = 7;
const NEWS_FEED_LIMIT = 40;

/** id → display code for news model links (fetched once, tickers win). */
function useTickerMap(): Map<string, string> {
  const [map, setMap] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    void fetch('/api/models')
      .then((r) => r.json())
      .then((body: Envelope<{ id: string; ticker: string | null }[]>) => {
        setMap(new Map(body.data.map((m) => [m.id, m.ticker ?? m.id.split('/').pop()?.toUpperCase() ?? m.id])));
      })
      .catch(() => undefined);
  }, []);
  return map;
}

export function Top() {
  const [envelope, setEnvelope] = useState<Envelope<Overview> | null>(null);
  const [news, setNews] = useState<Envelope<NewsItem[]> | null>(null);
  const setDispatch = useArgusStore((s) => s.setDispatch);
  const tickers = useTickerMap();
  const knownNewsIds = useRef<Set<string>>(new Set());
  const freshNewsIds = useRef<Set<string>>(new Set());
  const debounce = useRef<number | undefined>(undefined);

  const loadOverview = useCallback(() => {
    void api.overview().then(setEnvelope).catch(() => undefined);
  }, []);

  const loadNews = useCallback(() => {
    void api
      .news(NEWS_FEED_LIMIT)
      .then((env) => {
        const incoming = new Set(env.data.map((n) => n.id));
        freshNewsIds.current = new Set(
          [...incoming].filter((id) => knownNewsIds.current.size > 0 && !knownNewsIds.current.has(id)),
        );
        knownNewsIds.current = incoming;
        setNews(env);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadOverview();
    loadNews();
    const offEvent = onSseEvent((e) => {
      if (e.type !== 'snapshot' && e.type !== 'news') return;
      window.clearTimeout(debounce.current);
      debounce.current = window.setTimeout(() => {
        loadOverview();
        if (e.type === 'news') loadNews();
      }, REFETCH_DEBOUNCE_MS);
    });
    // Resync on every (re)connect: events emitted while the stream was down
    // are never replayed, so each 'live' transition refetches (the debounce
    // coalesces the startup double-load).
    const offState = onSseState((s) => {
      if (s !== 'live') return;
      window.clearTimeout(debounce.current);
      debounce.current = window.setTimeout(() => {
        loadOverview();
        loadNews();
      }, REFETCH_DEBOUNCE_MS);
    });
    return () => {
      offEvent();
      offState();
    };
  }, [loadOverview, loadNews]);

  const openDes = useCallback(
    (id: string, code: string) => {
      setDispatch({
        spec: findCommand('DES') as CommandSpec,
        entities: [{ id, ticker: code, name: code, via: 'id', score: 100 }],
        args: {},
      });
    },
    [setDispatch],
  );

  if (!envelope) {
    return (
      <Panel fn="TOP" desc="Market overview">
        <div className={styles.note}>LOADING…</div>
      </Panel>
    );
  }

  const { data, asOf, stale } = envelope;
  const gap = data.frontier.gap;
  const trend = data.frontier.trend;
  const trendPrev =
    trend.length > TREND_LOOKBACK_POINTS ? trend[trend.length - 1 - TREND_LOOKBACK_POINTS] : trend[0];
  const gapDelta = gap !== null && trendPrev?.gap != null ? gap - trendPrev.gap : null;
  const code = (id: string, ticker: string | null): string =>
    ticker ?? id.split('/').pop()?.toUpperCase() ?? id;

  return (
    <Panel fn="TOP" desc="Market overview" meta={`AS OF ${fmtTime(asOf)}`} stale={stale}>
      <div className={styles.root}>
        {/* ---- stat strip ---- */}
        <div className={styles.strip}>
          <span className={styles.stat}>
            <span className={styles.statlabel}>Models</span>
            <FlashValue watch={data.stats.models}>
              <span className={styles.statvalue}>{data.stats.models}</span>
            </FlashValue>
          </span>
          <span className={styles.stat}>
            <span className={styles.statlabel}>Open/Closed</span>
            <FlashValue watch={`${data.stats.open}/${data.stats.closed}`}>
              <span className={styles.statvalue}>
                <span className={styles.up}>{data.stats.open}</span>
                <span className={styles.dim}>/</span>
                <span>{data.stats.closed}</span>
              </span>
            </FlashValue>
          </span>
          <span className={styles.stat}>
            <span className={styles.statlabel}>Frontier gap</span>
            <FlashValue watch={gap}>
              <span className={styles.statvalue}>
                {gap === null ? '—' : gap.toFixed(1)}
                {gapDelta !== null && gapDelta !== 0 ? (
                  <span
                    className={gapDelta > 0 ? styles.up : styles.down}
                    title="open vs closed best text ELO, Δ7 boards"
                  >
                    {' '}
                    {gapDelta > 0 ? '▲' : '▼'}
                    {Math.abs(gapDelta).toFixed(1)}
                  </span>
                ) : null}
              </span>
            </FlashValue>
            <span className={styles.statsub}>
              {data.frontier.open?.ticker ?? '—'} <span className={styles.dim}>vs</span>{' '}
              {data.frontier.closed?.ticker ?? '—'}
            </span>
          </span>
          <span className={styles.stat}>
            <span className={styles.statlabel}>Sources</span>
            <span className={styles.statvalue}>
              {data.stats.sources_healthy}
              <span className={styles.dim}>/</span>
              {data.stats.sources_total}
            </span>
          </span>
        </div>

        {/* ---- two-column body: market sections | news feed ---- */}
        <div className={styles.cols}>
          <div className={styles.col}>
            <div className={styles.section}>
              <div className={styles.sectiontitle}>Price movers · Δ24H/7D</div>
              {data.price_movers.length === 0 ? (
                <div className={styles.note}>ACCRUING HISTORY…</div>
              ) : (
                <table className={styles.table}>
                  <colgroup>
                    <col style={{ width: '13ch' }} />
                    <col />
                    <col style={{ width: '10ch' }} />
                    <col style={{ width: '10ch' }} />
                  </colgroup>
                  <tbody>
                    {data.price_movers.map((m) => (
                      <tr key={m.id}>
                        <td className={styles.ticker} onClick={() => openDes(m.id, code(m.id, m.ticker))}>
                          {code(m.id, m.ticker)}
                        </td>
                        <td className={`${styles.num} num ${styles.amber}`}>
                          <FlashValue watch={m.prompt_usd_per_mtok}>{fmtPrice(m.prompt_usd_per_mtok)}</FlashValue>
                        </td>
                        <td className={`${styles.num} num ${styles[deltaClass(m.delta_pct_24h)] ?? styles.dim}`}>
                          {fmtPct(m.delta_pct_24h)}
                        </td>
                        <td className={`${styles.num} num ${styles[deltaClass(m.delta_pct_7d)] ?? styles.dim}`}>
                          {fmtPct(m.delta_pct_7d)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className={styles.section}>
              <div className={styles.sectiontitle}>Arena movers · text · Δ7D</div>
              {data.arena_movers.length === 0 ? (
                <div className={styles.note}>NO RANK MOVES THIS WEEK</div>
              ) : (
                <table className={styles.table}>
                  <colgroup>
                    <col style={{ width: '13ch' }} />
                    <col style={{ width: '7ch' }} />
                    <col style={{ width: '7ch' }} />
                    <col />
                    <col style={{ width: '9ch' }} />
                  </colgroup>
                  <tbody>
                    {data.arena_movers.map((m) => (
                      <tr key={m.id}>
                        <td className={styles.ticker} onClick={() => openDes(m.id, code(m.id, m.ticker))}>
                          {code(m.id, m.ticker)}
                        </td>
                        <td className={`${styles.num} num ${styles.amber}`}>
                          <FlashValue watch={m.rank}>#{m.rank}</FlashValue>
                        </td>
                        <td className={`${styles.num} num ${styles[deltaClass(m.rank_delta_7d)]}`}>
                          {fmtDelta(m.rank_delta_7d)}
                        </td>
                        <td className={`${styles.num} num ${styles.white}`}>
                          <FlashValue watch={Math.round(m.elo)}>{Math.round(m.elo)}</FlashValue>
                        </td>
                        <td className={`${styles.num} num ${styles[deltaClass(m.elo_delta_7d)] ?? styles.dim}`}>
                          {fmtDelta(m.elo_delta_7d, 1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className={styles.section}>
              <div className={styles.sectiontitle}>Download spikes · 7D</div>
              {data.download_spikes.length === 0 ? (
                <div className={styles.note}>ACCRUING HISTORY…</div>
              ) : (
                <table className={styles.table}>
                  <colgroup>
                    <col style={{ width: '13ch' }} />
                    <col />
                    <col style={{ width: '10ch' }} />
                  </colgroup>
                  <tbody>
                    {data.download_spikes.map((m) => (
                      <tr key={m.id}>
                        <td className={styles.ticker} onClick={() => openDes(m.id, code(m.id, m.ticker))}>
                          {code(m.id, m.ticker)}
                        </td>
                        <td className={`${styles.num} num ${styles.amber}`}>
                          <FlashValue watch={m.downloads}>{fmtCompact(m.downloads)}</FlashValue>
                        </td>
                        <td className={`${styles.num} num ${styles[deltaClass(m.delta_pct_7d)] ?? styles.dim}`}>
                          {fmtPct(m.delta_pct_7d)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className={styles.section}>
              <div className={styles.sectiontitle}>Newest models</div>
              <table className={styles.table}>
                <colgroup>
                  <col style={{ width: '13ch' }} />
                  <col />
                  <col style={{ width: '9ch' }} />
                  <col style={{ width: '13ch' }} />
                </colgroup>
                <tbody>
                  {data.newest.map((m) => (
                    <tr key={m.id}>
                      <td className={styles.ticker} onClick={() => openDes(m.id, code(m.id, m.ticker))}>
                        {code(m.id, m.ticker)}
                      </td>
                      <td className={styles.name}>{m.name}</td>
                      <td className={`${styles.num} num ${m.openness === 'open' ? styles.up : styles.dim}`}>
                        {m.openness.toUpperCase()}
                      </td>
                      <td className={`${styles.num} num ${styles.dim}`}>{fmtDate(m.released_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className={styles.col}>
            <div className={styles.sectiontitle}>
              Latest news{news?.stale ? <span className={styles.down}> · STALE</span> : null}
            </div>
            <div className={styles.news}>
              {(news?.data ?? []).map((n) => (
                <NewsRow
                  key={n.id}
                  item={n}
                  fresh={freshNewsIds.current.has(n.id)}
                  tickers={tickers}
                  onCode={openDes}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function NewsRow({
  item,
  fresh,
  tickers,
  onCode,
}: {
  item: NewsItem;
  fresh: boolean;
  tickers: Map<string, string>;
  onCode: (id: string, code: string) => void;
}) {
  return (
    <div className={`${styles.newsitem} ${fresh ? styles.slidein : ''}`}>
      <span className={styles.newstime}>{fmtTime(item.ts)}</span>
      <span className={styles.newssrc}>{sourceCode(item.source)}</span>
      <span className={styles.newsbody}>
        <a className={styles.headline} href={item.url} target="_blank" rel="noreferrer" title={item.title}>
          {item.title}
        </a>
        {item.model_ids.length > 0 ? (
          <span className={styles.newscodes}>
            {item.model_ids.map((id) => {
              const modelCode = tickers.get(id) ?? id.split('/').pop()?.toUpperCase() ?? id;
              return (
                <span key={id} className={styles.newscode} onClick={() => onCode(id, modelCode)}>
                  {modelCode}
                </span>
              );
            })}
          </span>
        ) : null}
      </span>
      <span className={styles.salience}>
        {item.salience !== null && item.salience > 0 ? `${item.salience}▲` : ''}
      </span>
    </div>
  );
}