import { api } from '../api/client';
import type { Dispatch } from '../command/parser';
import { Panel } from '../components/Panel';
import { useEnvelope } from '../hooks/useEnvelope';
import { dispatchFn, prefillCommand } from '../lib/dispatch';
import { fmtCompact, fmtDate, fmtInt, fmtPrice, fmtTime } from '../lib/fmt';
import common from './common.module.css';
import styles from './Des.module.css';

/** DES — the model spec sheet. */
export function Des({ dispatch }: { dispatch: Dispatch }) {
  const entity = dispatch.entities[0];
  const id = entity?.id ?? '';

  const { env, error, loading } = useEnvelope(
    () => api.detail(id),
    [id],
    (e) => (e.type === 'snapshot' || e.type === 'news') && e.model_ids.includes(id),
  );

  const d = env?.data;
  const code = d?.model.ticker ?? entity?.ticker ?? id.toUpperCase();

  return (
    <Panel fn="DES" desc={`${code} description`} meta={env ? `AS OF ${fmtTime(env.asOf)}` : undefined} stale={env?.stale}>
      {loading ? (
        <div className={common.note}>LOADING…</div>
      ) : error ? (
        <div className={common.error}>API ERROR — {error}</div>
      ) : !d ? (
        <div className={common.note}>NO DATA</div>
      ) : (
        <div className={styles.root}>
          <div className={styles.cols}>
            <div className={styles.col}>
              <div className={styles.headline}>
                <span className={styles.name}>{d.model.name}</span>
                <span className={common.ticker}>{code}</span>
                <span className={d.model.openness === 'open' ? common.up : common.dim}>
                  {d.model.openness.toUpperCase()}
                </span>
              </div>
              <div className={common.sectiontitle}>Identity</div>
              <dl>
                <div className={styles.kv}><dt>CANONICAL ID</dt><dd className={common.dim}>{d.model.id}</dd></div>
                <div className={styles.kv}><dt>ORG</dt><dd>{d.model.author_org.toUpperCase()}</dd></div>
                <div className={styles.kv}><dt>LICENSE</dt><dd>{d.model.license ?? '—'}</dd></div>
                <div className={styles.kv}><dt>RELEASED</dt><dd>{fmtDate(d.model.released_at)}</dd></div>
                <div className={styles.kv}>
                  <dt>ALIASES</dt>
                  <dd className={common.dim} title={d.aliases.join(', ')}>{d.aliases.length ? d.aliases.join(' · ') : '—'}</dd>
                </div>
              </dl>
              <div className={common.sectiontitle}>Pricing</div>
              <dl>
                <div className={styles.kv}>
                  <dt>PROMPT</dt>
                  <dd className={common.amber}>{d.pricing ? `${fmtPrice(d.pricing.prompt_usd_per_mtok)}/MTOK` : '—'}</dd>
                </div>
                <div className={styles.kv}>
                  <dt>COMPLETION</dt>
                  <dd className={common.amber}>{d.pricing ? `${fmtPrice(d.pricing.completion_usd_per_mtok)}/MTOK` : '—'}</dd>
                </div>
              </dl>
              <div className={common.sectiontitle}>Capabilities</div>
              <dl>
                <div className={styles.kv}><dt>CONTEXT</dt><dd>{d.model.context_len ? fmtInt(d.model.context_len) : '—'}</dd></div>
                <div className={styles.kv}><dt>MODALITIES</dt><dd>{d.model.modalities.join(' · ').toUpperCase() || '—'}</dd></div>
              </dl>
              {d.hub ? (
                <>
                  <div className={common.sectiontitle}>HF Hub</div>
                  <dl>
                    <div className={styles.kv}><dt>DOWNLOADS</dt><dd className={common.amber}>{fmtCompact(d.hub.downloads)}</dd></div>
                    <div className={styles.kv}><dt>LIKES</dt><dd>{fmtInt(d.hub.likes)}</dd></div>
                    <div className={styles.kv}><dt>TRENDING</dt><dd>{d.hub.trending_rank ? `#${d.hub.trending_rank}` : '—'}</dd></div>
                  </dl>
                </>
              ) : null}
            </div>
            <div className={styles.col}>
              <div className={common.sectiontitle}>Arena standings</div>
              {d.arena.length === 0 ? (
                <div className={common.note}>NOT ON ANY BOARD</div>
              ) : (
                <table className={common.table}>
                  <colgroup>
                    <col />
                    <col style={{ width: '7ch' }} />
                    <col style={{ width: '8ch' }} />
                    <col style={{ width: '9ch' }} />
                    <col style={{ width: '14ch' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left' }}>CATEGORY</th>
                      <th>RANK</th>
                      <th>ELO</th>
                      <th>VOTES</th>
                      <th>BOARD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.arena.map((a) => (
                      <tr key={a.category}>
                        <td className={common.white}>{a.category.toUpperCase()}</td>
                        <td className={`${common.amber} num`} style={{ textAlign: 'right' }}>#{a.rank}</td>
                        <td className={`${common.amber} num`} style={{ textAlign: 'right' }}>{Math.round(a.elo)}</td>
                        <td className={`${common.dim} num`} style={{ textAlign: 'right' }}>{fmtInt(a.votes)}</td>
                        <td className={`${common.dim} num`} style={{ textAlign: 'right' }}>{a.ts}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {d.bench.length > 0 ? (
                <>
                  <div className={common.sectiontitle}>Benchmarks</div>
                  <table className={common.table}>
                    <colgroup>
                      <col />
                      <col style={{ width: '9ch' }} />
                      <col style={{ width: '20ch' }} />
                    </colgroup>
                    <tbody>
                      {d.bench.slice(0, 8).map((b) => (
                        <tr key={`${b.source}/${b.benchmark}`}>
                          <td className={common.white}>{b.benchmark.toUpperCase()}</td>
                          <td className={`${common.amber} num`} style={{ textAlign: 'right' }}>{b.score.toFixed(1)}</td>
                          <td className={common.dim}>{b.source.toUpperCase()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : null}
              <div className={common.sectiontitle}>News</div>
              {d.news.length === 0 ? (
                <div className={common.note}>NO LINKED NEWS</div>
              ) : (
                d.news.map((n) => (
                  <div key={n.id} className={styles.newsitem}>
                    <span className={styles.newsdate}>{fmtDate(n.ts)}</span>
                    <a className={styles.newstitle} href={n.url} target="_blank" rel="noreferrer" title={n.title}>
                      {n.title}
                    </a>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className={styles.codesrow}>
            {entity ? (
              <>
                <span className={common.code} onClick={() => dispatchFn('PX', [entity])}>PX</span>
                <span className={common.code} onClick={() => dispatchFn('ARENA', [entity])}>ARENA</span>
                <span className={common.code} onClick={() => prefillCommand(`${code} BENCH `)}>BENCH</span>
                <span className={common.code} onClick={() => dispatchFn('NEWS', [entity])}>NEWS</span>
                <span className={common.code} onClick={() => dispatchFn('WATCH', [entity], { action: 'ADD' })}>WATCH ADD</span>
              </>
            ) : null}
          </div>
        </div>
      )}
    </Panel>
  );
}