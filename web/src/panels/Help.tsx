import { COMMANDS } from '@argus/shared';
import type { ArgSpec } from '@argus/shared';
import { prefillCommand } from '../lib/dispatch';
import { Panel } from '../components/Panel';
import styles from './Help.module.css';

const CURRENT_PHASE = 7;

/** "range: 30D|90D|MAX" — derived from the spec, never hand-written. */
function argSummary(args: readonly ArgSpec[]): string {
  if (args.length === 0) return '—';
  return args
    .map((a) => {
      const values = a.kind === 'enum' ? (a.values?.join('|') ?? '') : '‹ENTITY›';
      return `${a.name}${a.required ? '' : '?'}: ${values}`;
    })
    .join(' · ');
}

/**
 * PHASE-7 HELP: everything on this panel is generated from the command
 * registry — if HELP and the registry could disagree, HELP would be wrong,
 * so it derives instead. Examples are clickable (prefill the command line).
 */
export function Help() {
  return (
    <Panel fn="HELP" desc="Function reference">
      <div className={styles.primer}>
        <span className={styles.grammar}>[ENTITY] FUNCTION [ARGS] ‹GO›</span> — entity first
        (FABLE5 DES) or function first (DES FABLE5); a bare entity opens DES; ENTER executes.
      </div>
      <div className={styles.keys}>
        <b>/</b> or <b>CTRL+K</b> focus command · <b>TAB</b> accept ghost · <b>↑/↓</b> history ·{' '}
        <b>ESC</b> clear · <b>ENTER</b> = ‹GO› · <b>ALT+1-4</b> focus panel · commands fill the
        focused panel
      </div>
      <table className={styles.table}>
        <colgroup>
          <col style={{ width: '9ch' }} />
          <col style={{ width: '30ch' }} />
          <col style={{ width: '34ch' }} />
          <col />
          <col style={{ width: '26ch' }} />
          <col style={{ width: '9ch' }} />
        </colgroup>
        <thead>
          <tr>
            <th>Function</th>
            <th>Usage</th>
            <th>Args</th>
            <th>Description</th>
            <th>Example</th>
            <th style={{ textAlign: 'right' }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {COMMANDS.map((c) => (
            <tr key={c.fn}>
              <td className={styles.fn}>{c.fn}</td>
              <td className={styles.usage}>{c.usage}</td>
              <td className={styles.args}>{argSummary(c.args)}</td>
              <td className={styles.desc}>{c.description}</td>
              <td
                className={styles.example}
                title="click to put in the command line"
                onClick={() => prefillCommand(c.example)}
              >
                {c.example}
              </td>
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