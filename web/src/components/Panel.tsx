import type { ReactNode } from 'react';
import styles from './Panel.module.css';

/** Panel chrome: accent bar, `FN ▸ DESCRIPTION` title, right-side meta. */
export function Panel({
  fn,
  desc,
  meta,
  stale,
  children,
}: {
  fn: string;
  desc: string;
  meta?: string;
  stale?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={styles.panel}>
      <header className={styles.titlebar}>
        <span className={styles.accent} />
        <span className={styles.fn}>{fn}</span>
        <span className={styles.desc}>▸ {desc}</span>
        <span className={styles.meta}>
          {stale ? <span className={styles.stale}>STALE</span> : null}
          {meta ? <span>{meta}</span> : null}
        </span>
      </header>
      <div className={styles.body}>{children}</div>
    </section>
  );
}