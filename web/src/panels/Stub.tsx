import type { Dispatch } from '../command/parser';
import { Panel } from '../components/Panel';
import styles from './Stub.module.css';

/** In-theme placeholder for §7 functions whose panels land in a later phase. */
export function Stub({ dispatch }: { dispatch: Dispatch }) {
  const { spec, entities, args } = dispatch;
  const context = [
    ...entities.map((e) => e.ticker ?? e.id.toUpperCase()),
    ...Object.values(args).map((v) => v.toUpperCase()),
  ].join(' · ');

  return (
    <Panel fn={spec.fn} desc={spec.description}>
      <div className={styles.stub}>
        <div className={styles.fn}>{spec.fn}</div>
        <div className={styles.msg}>Function not yet available — Phase {spec.implementedInPhase}</div>
        <div className={styles.usage}>{spec.usage}</div>
        {context ? <div className={styles.context}>{context}</div> : null}
      </div>
    </Panel>
  );
}