import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * The sanctioned data motion: wraps a value and replays the 400ms --flash
 * fade whenever `watch` changes (never on first render). Layout-neutral.
 */
export function FlashValue({ watch, children }: { watch: string | number | null; children: ReactNode }) {
  const prev = useRef(watch);
  const [flashKey, setFlashKey] = useState(0);

  useEffect(() => {
    if (prev.current !== watch) {
      prev.current = watch;
      setFlashKey((k) => k + 1);
    }
  }, [watch]);

  return (
    <span key={flashKey} className={flashKey > 0 ? 'flash' : undefined}>
      {children}
    </span>
  );
}