import type { NewsItem } from '@argus/shared';
import { dispatchFn, entityRef } from '../lib/dispatch';
import { fmtTime, sourceCode } from '../lib/fmt';
import styles from './NewsList.module.css';

/** Dense news feed rows: time, source tag, headline, blue tickers, salience. */
export function NewsList({
  items,
  fresh,
  tickers,
}: {
  items: NewsItem[];
  /** Item ids that just arrived via SSE — they slide in. */
  fresh: Set<string>;
  tickers: Map<string, string>;
}) {
  return (
    <div>
      {items.map((n) => (
        <div key={n.id} className={`${styles.newsitem} ${fresh.has(n.id) ? styles.slidein : ''}`}>
          <span className={styles.newstime}>{fmtTime(n.ts)}</span>
          <span className={styles.newssrc}>{sourceCode(n.source)}</span>
          <span className={styles.newsbody}>
            <a className={styles.headline} href={n.url} target="_blank" rel="noreferrer" title={n.title}>
              {n.title}
            </a>
            {n.model_ids.length > 0 ? (
              <span>
                {n.model_ids.map((id) => {
                  const code = tickers.get(id) ?? id.split('/').pop()?.toUpperCase() ?? id;
                  return (
                    <span key={id} className={styles.newscode} onClick={() => dispatchFn('DES', [entityRef(id, code)])}>
                      {code}
                    </span>
                  );
                })}
              </span>
            ) : null}
          </span>
          <span className={styles.salience}>{n.salience !== null && n.salience > 0 ? `${n.salience}▲` : ''}</span>
        </div>
      ))}
    </div>
  );
}