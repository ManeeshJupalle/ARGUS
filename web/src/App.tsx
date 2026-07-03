import { useEffect, useState } from 'react';

// PHASE-5: the terminal shell (command line, panel grid, status bar) replaces
// this placeholder. The single fetch below exists only to prove the Vite
// dev proxy (/api → server) end-to-end.
export default function App() {
  const [health, setHealth] = useState('checking…');

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json() as Promise<{ ok: boolean; ts: string }>)
      .then((body) => setHealth(body.ok ? `ok @ ${body.ts}` : 'unhealthy'))
      .catch(() => setHealth('unreachable'));
  }, []);

  return (
    <main style={{ fontFamily: 'monospace', padding: 24 }}>
      <h1>ARGUS</h1>
      <p>Phase 1 scaffold — terminal UI arrives in Phase 5.</p>
      <p>server /api/health (via Vite proxy): {health}</p>
    </main>
  );
}
