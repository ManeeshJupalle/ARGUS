import { useEffect } from 'react';
import { connectSse } from '../api/sse';
import type { Dispatch } from '../command/parser';
import { useArgusStore } from '../store/store';
import { Arena } from '../panels/Arena';
import { Bench } from '../panels/Bench';
import { Des } from '../panels/Des';
import { Help } from '../panels/Help';
import { Mkt } from '../panels/Mkt';
import { Mov } from '../panels/Mov';
import { News } from '../panels/News';
import { Px } from '../panels/Px';
import { Stub } from '../panels/Stub';
import { Top } from '../panels/Top';
import { Watch } from '../panels/Watch';
import { CommandLine } from './CommandLine';
import { StatusBar } from './StatusBar';
import styles from './Shell.module.css';

/** Dispatch → panel component. STAT stays a stub until Phase 7. */
function PanelFor({ dispatch }: { dispatch: Dispatch }) {
  switch (dispatch.spec.fn) {
    case 'TOP':
      return <Top />;
    case 'HELP':
      return <Help />;
    case 'DES':
      return <Des dispatch={dispatch} />;
    case 'PX':
      return <Px dispatch={dispatch} />;
    case 'ARENA':
      return <Arena dispatch={dispatch} />;
    case 'BENCH':
      return <Bench dispatch={dispatch} />;
    case 'NEWS':
      return <News dispatch={dispatch} />;
    case 'MKT':
      return <Mkt dispatch={dispatch} />;
    case 'MOV':
      return <Mov dispatch={dispatch} />;
    case 'WATCH':
      return <Watch dispatch={dispatch} />;
    default:
      return <Stub dispatch={dispatch} />;
  }
}

function PanelSlot({ index }: { index: number }) {
  const dispatch = useArgusStore((s) => s.panels[index] ?? null);
  const focused = useArgusStore((s) => s.focused === index);
  const focusPanel = useArgusStore((s) => s.focusPanel);

  return (
    <div
      className={`${styles.slot} ${focused ? styles.focused : ''}`}
      onMouseDownCapture={() => focusPanel(index)}
    >
      <span className={styles.slotnum}>{index + 1}</span>
      {dispatch ? (
        <PanelFor dispatch={dispatch} />
      ) : index === 0 ? (
        <Top /> /* slot 1 defaults to the TOP screen */
      ) : (
        <div className={styles.empty}>
          <div className={styles.emptynum}>{index + 1}</div>
          <div className={styles.emptymsg}>Empty panel — ALT+{index + 1} to focus, then type a command ‹GO›</div>
        </div>
      )}
    </div>
  );
}

export function Shell() {
  const layout = useArgusStore((s) => s.layout);
  const focusPanel = useArgusStore((s) => s.focusPanel);

  useEffect(() => {
    connectSse();
  }, []);

  /* ALT+1..4 focuses panel N. (F-keys stay with the browser: F1 help, F5
     reload etc. — Alt+digit is unclaimed on Windows Chrome.) */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 4) {
        e.preventDefault();
        focusPanel(n - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusPanel]);

  const gridClass = layout === 1 ? styles.grid1 : layout === 2 ? styles.grid2 : styles.grid4;

  return (
    <>
      <div className={styles.shell}>
        <CommandLine />
        <main className={`${styles.panelarea} ${gridClass}`}>
          {Array.from({ length: layout }, (_, i) => (
            <PanelSlot key={i} index={i} />
          ))}
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