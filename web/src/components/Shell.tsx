import { useEffect } from 'react';
import { connectSse } from '../api/sse';
import { useArgusStore } from '../store/store';
import { Help } from '../panels/Help';
import { Stub } from '../panels/Stub';
import { Top } from '../panels/Top';
import { CommandLine } from './CommandLine';
import { StatusBar } from './StatusBar';
import styles from './Shell.module.css';

const CURRENT_PHASE = 5;

/** Panel router: instant content swap, no transitions (§8). */
function ActivePanel() {
  const dispatch = useArgusStore((s) => s.dispatch);
  if (!dispatch || dispatch.spec.fn === 'TOP') return <Top />;
  if (dispatch.spec.fn === 'HELP') return <Help />;
  if (dispatch.spec.implementedInPhase <= CURRENT_PHASE) return <Top />;
  return <Stub dispatch={dispatch} />;
}

export function Shell() {
  useEffect(() => {
    connectSse();
  }, []);

  return (
    <>
      <div className={styles.shell}>
        <CommandLine />
        <main className={styles.panelarea}>
          <ActivePanel />
        </main>
        <StatusBar />
      </div>
      <div className={styles.gate}>
        <div className={styles.gatebrand}>ARGUS</div>
        <div className={styles.gatemsg}>Argus requires a desktop viewport (≥1100px)</div>
      </div>
    </>
  );
}