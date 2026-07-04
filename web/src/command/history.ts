/**
 * Command history: ↑/↓ navigation, consecutive-dup skip, bounded. Pure —
 * tested alongside the parser.
 */

const MAX_ENTRIES = 100;

export class CommandHistory {
  private entries: string[] = [];
  private cursor = -1; // -1 = live line (not navigating)

  push(command: string): void {
    const trimmed = command.trim();
    if (trimmed === '' || this.entries[this.entries.length - 1] === trimmed) {
      this.cursor = -1;
      return;
    }
    this.entries.push(trimmed);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    this.cursor = -1;
  }

  /** ArrowUp: older. Returns the entry to show, or null at the oldest end. */
  prev(): string | null {
    if (this.entries.length === 0) return null;
    if (this.cursor === -1) this.cursor = this.entries.length - 1;
    else if (this.cursor > 0) this.cursor--;
    return this.entries[this.cursor] ?? null;
  }

  /** ArrowDown: newer. Returns the entry, or null when back at the live line. */
  next(): string | null {
    if (this.cursor === -1) return null;
    if (this.cursor < this.entries.length - 1) {
      this.cursor++;
      return this.entries[this.cursor] ?? null;
    }
    this.cursor = -1;
    return null;
  }

  /** Typing resets navigation. */
  reset(): void {
    this.cursor = -1;
  }
}