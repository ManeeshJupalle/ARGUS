import { COMMANDS } from '@argus/shared';
import { Panel } from '../components/Panel';
import styles from './Help.module.css';

const CURRENT_PHASE = 6;

/** Registry-driven function reference. Phase 7 enriches with examples. */
export function Help() {
  return (
    <Panel fn="HELP" desc="Function reference">
      <div className={styles.keys}>
        <b>/</b> or <b>CTRL+K</b> focus command · <b>TAB</b> accept ghost · <b>↑/↓</b> history ·{' '}
        <b>ESC</b> clear · <b>ENTER</b> = ‹GO› · <b>ALT+1-4</b> focus panel · commands fill the focused panel
      </div>
      <table className={styles.table}>
        <colgroup>
          <col style={{ width: '9ch' }} />
          <col style={{ width: '42ch' }} />
          <col />
          <col style={{ width: '10ch' }} />
        </colgroup>
        <thead>
          <tr>
            <th>Function</th>
            <th>Usage</th>
            <th>Description</th>
            <th style={{ textAlign: 'right' }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {COMMANDS.map((c) => (
            <tr key={c.fn}>
              <td className={styles.fn}>{c.fn}</td>
              <td className={styles.usage}>{c.usage}</td>
              <td className={styles.desc}>{c.description}</td>
              <td className={c.implementedInPhase <= CURRENT_PHASE ? styles.live : styles.phase}>
                {c.implementedInPhase <= CURRENT_PHASE ? 'LIVE' : `PHASE ${c.implementedInPhase}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}