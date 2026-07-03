import type Database from 'better-sqlite3';

/**
 * HARD COMPONENT 1 (§5, tested): heterogeneous upstreams name the same model
 * differently ("claude-fable-5" vs "anthropic/claude-fable-5" vs "Claude
 * Fable 5"). The resolver canonicalizes via normalization rules + the
 * entity_alias table + a fuzzy last resort, and quarantines what it cannot
 * safely attach rather than corrupting the entity table.
 *
 * Reused unchanged by PHASE-3 pollers (Arena, HF Hub, news): they call
 * resolve() with their native names, registerAlias() on success, and
 * quarantine() on unmatched/ambiguous rows they cannot create entities for.
 */

export interface ResolveInput {
  /** Upstream source name, e.g. "openrouter", "lmarena". */
  source: string;
  /** The entity name/id exactly as the upstream gives it. */
  raw: string;
  /**
   * Fuzzy matching is a last resort for display-name-ish inputs. Sources
   * whose raw values are already precise slugs (OpenRouter) pass false:
   * fuzzy-matching precise slugs risks merging genuinely distinct models.
   */
  allowFuzzy?: boolean;
  /**
   * Suffix-chain/dotted-version rules exist for heterogeneous display names
   * (LMArena). Primary-slug sources (OpenRouter, HF Hub) pass false and get
   * exact + alias + date/colon canonicalization only — on those sources
   * "gpt-5.2-chat" and "gpt-5.2" are distinct listed products, and rule
   * stripping could merge them depending on processing order.
   */
  allowRules?: boolean;
}

export type ResolveVia = 'exact' | 'alias' | 'rule' | 'fuzzy';

export type Resolution =
  | { status: 'matched'; model_id: string; via: ResolveVia; confidence: number }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'unmatched'; canonical_id: string };

/** Accept a fuzzy match only at or above this similarity. */
const FUZZY_THRESHOLD = 0.85;
/** Two different models scoring within this margin → ambiguous, not a match. */
const FUZZY_AMBIGUITY_MARGIN = 0.03;

/**
 * Normalize any upstream spelling into slug form: lowercase, trimmed,
 * whitespace → "-", and a leading "Vendor: " display prefix dropped
 * (colon+space is a vendor prefix; colon+no-space is a variant suffix,
 * which normalization keeps and canonicalization strips).
 */
export function normalizeAlias(raw: string): string {
  return raw
    .trim()
    .replace(/^[^:/]+:\s+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-');
}

/**
 * Deterministic canonicalization rules, derived from observed OpenRouter ids:
 * strip serving-variant suffixes (":free", ":thinking", ...) and trailing
 * date stamps. Observed stamp forms: -YYYYMMDD ("-20260420"),
 * -YYYY-MM-DD ("-2025-07-28"), -MM-YYYY ("-09-2025"), -YYMM ("-2512"),
 * -MMDD ("-0905"). 4-digit tokens are validated as plausible dates so
 * names like "r1-1776" survive intact.
 */
export function canonicalizeModelId(raw: string): string {
  return stripDateStamps(normalizeAlias(raw).split(':')[0] ?? '');
}

function stripDateStamps(id: string): string {
  for (;;) {
    const m = id.match(/-(\d{8}|\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{2}|\d{2}-\d{4}|\d{4})$/);
    if (!m || m.index === undefined || !isDateStamp(m[1] ?? '')) return id;
    id = id.slice(0, m.index);
  }
}

function isDateStamp(token: string): boolean {
  const mm = (s: string): boolean => Number(s) >= 1 && Number(s) <= 12;
  const dd = (s: string): boolean => Number(s) >= 1 && Number(s) <= 31;
  if (/^\d{8}$/.test(token)) {
    // YYYYMMDD
    return token.startsWith('20') && mm(token.slice(4, 6)) && dd(token.slice(6, 8));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) {
    // YYYY-MM-DD
    return token.startsWith('20') && mm(token.slice(5, 7)) && dd(token.slice(8, 10));
  }
  if (/^\d{2}-\d{4}$/.test(token)) {
    // MM-YYYY
    return mm(token.slice(0, 2)) && token.slice(3).startsWith('20');
  }
  if (/^\d{2}-\d{2}-\d{2}$/.test(token)) {
    // YY-MM-DD (LMArena: "…-chat-26-02-10"), years 2020-2029
    const yy = Number(token.slice(0, 2));
    return yy >= 20 && yy <= 29 && mm(token.slice(3, 5)) && dd(token.slice(6, 8));
  }
  // 4 digits: MMDD ("0905") or YYMM ("2512", years 2020-2029)
  const asMmDd = mm(token.slice(0, 2)) && dd(token.slice(2, 4));
  const asYyMm = Number(token.slice(0, 2)) >= 20 && Number(token.slice(0, 2)) <= 29 && mm(token.slice(2, 4));
  return asMmDd || asYyMm;
}

/**
 * LMArena spells versions with dashes ("claude-opus-4-6") where OpenRouter
 * uses dots ("claude-opus-4.6"). Only single-digit-dash-single-digit followed
 * by end-or-dash converts, so size suffixes ("llama-3-8b") are untouched.
 */
function versionDotted(id: string): string {
  return id.replace(/-(\d)-(\d)(?=$|-)/g, '-$1.$2');
}

/**
 * Serving-tier suffixes observed on LMArena names that denote the SAME
 * underlying entity: reasoning modes (-thinking/-reasoning), effort tiers
 * (-high/-instant), rolling pointers (-latest), previews/betas, thinking
 * budgets (-32k/-16k), and trailing parentheticals ("glm-5.2 (max)" →
 * slugged "glm-5.2-(max)"). Stripped ONE tier at a time so less-stripped
 * forms are looked up first — an entity that genuinely exists under a
 * suffixed id (e.g. openai/gpt-5.2-chat) always wins before stripping.
 * "-turbo" is deliberately NOT here: gpt-4-turbo is a distinct product.
 */
const VARIANT_SUFFIX_RE =
  /-(?:thinking|reasoning|high|instant|latest|chat|preview|exp|experimental|beta\d*|\d+k)$|-\([^)]*\)$/;

/**
 * Progressive deterministic normalization chain: each step strips trailing
 * date stamps, then one variant-suffix tier. "claude-opus-4-5-20251101-
 * thinking-32k" → …-thinking → …-20251101 → claude-opus-4-5.
 */
function suffixChain(canon: string): string[] {
  const chain = [canon];
  let current = canon;
  for (let i = 0; i < 6; i++) {
    const next = stripDateStamps(current).replace(VARIANT_SUFFIX_RE, '');
    if (next === current || next === '') break;
    chain.push(next);
    current = next;
  }
  return chain;
}

/** Ordered, deduped lookup forms tried by the resolve ladder. */
function candidateForms(norm: string, canon: string): string[] {
  const forms = [norm];
  for (const link of suffixChain(canon)) {
    forms.push(link, versionDotted(link));
  }
  return [...new Set(forms)];
}

/** Digit runs must agree for a fuzzy match: "llama-3-8b" never equals "llama-3.1-8b". */
function digitSignature(s: string): string {
  return (s.match(/\d+/g) ?? []).join('.');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] ?? 0;
      prev[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length] ?? 0;
}

function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

interface ModelRow {
  id: string;
  name: string;
}

export class EntityResolver {
  private readonly stmtModelById;
  private readonly stmtAliasLookup;
  private readonly stmtModelsByNamePart;
  private readonly stmtAllModels;
  private readonly stmtAllAliases;
  private readonly stmtInsertAlias;
  private readonly stmtUpsertQuarantine;

  constructor(db: Database.Database) {
    this.stmtModelById = db.prepare(`SELECT id FROM model WHERE id = ?`);
    this.stmtAliasLookup = db.prepare(`SELECT model_id FROM entity_alias WHERE alias = ?`);
    this.stmtModelsByNamePart = db.prepare(
      `SELECT id FROM model WHERE substr(id, instr(id, '/') + 1) = ?`,
    );
    this.stmtAllModels = db.prepare(`SELECT id, name FROM model`);
    this.stmtAllAliases = db.prepare(`SELECT alias, model_id FROM entity_alias`);
    this.stmtInsertAlias = db.prepare(
      `INSERT INTO entity_alias (alias, model_id) VALUES (?, ?) ON CONFLICT (alias) DO NOTHING`,
    );
    this.stmtUpsertQuarantine = db.prepare(
      `INSERT INTO quarantine (source, raw, reason, payload, ts) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (source, raw) DO UPDATE SET reason = excluded.reason, payload = excluded.payload, ts = excluded.ts`,
    );
  }

  resolve(input: ResolveInput): Resolution {
    const norm = normalizeAlias(input.raw);
    const canon = canonicalizeModelId(input.raw);
    const forms = input.allowRules === false ? [...new Set([norm, canon])] : candidateForms(norm, canon);

    // 1+2+3. Exact id and alias-table lookups, for the raw form first, then
    // each deterministic-rule form (variant/date strip, dotted version,
    // reasoning-suffix strip).
    for (const form of forms) {
      if (this.modelExists(form)) {
        return { status: 'matched', model_id: form, via: form === norm ? 'exact' : 'rule', confidence: 1 };
      }
      const aliasHit = this.aliasLookup(form);
      if (aliasHit) {
        return { status: 'matched', model_id: aliasHit, via: form === norm ? 'alias' : 'rule', confidence: 1 };
      }
    }

    // 4. Org-less inputs ("gpt-5.5"): unique name-part match is deterministic.
    if (!norm.includes('/')) {
      for (const form of forms) {
        const hits = new Set<string>(
          (this.stmtModelsByNamePart.all(form) as Pick<ModelRow, 'id'>[]).map((r) => r.id),
        );
        if (hits.size === 1) {
          const [only] = hits;
          return { status: 'matched', model_id: only as string, via: 'rule', confidence: 0.95 };
        }
        if (hits.size > 1) {
          return { status: 'ambiguous', candidates: [...hits].sort() };
        }
      }
    }

    // 5. Fuzzy last resort on the most-normalized form, with a confidence
    // threshold and digit guard.
    if (input.allowFuzzy !== false) {
      const fuzzy = this.fuzzyMatch(forms[forms.length - 1] ?? canon);
      if (fuzzy) return fuzzy;
    }

    return { status: 'unmatched', canonical_id: canon };
  }

  /** Record that `alias` names `model_id`. First writer wins; never rebinds. */
  registerAlias(alias: string, model_id: string): void {
    const norm = normalizeAlias(alias);
    if (norm === '' || norm === model_id) return;
    this.stmtInsertAlias.run(norm, model_id);
  }

  /** Park an unresolvable/unparseable row instead of corrupting entities. */
  quarantine(input: { source: string; raw: string }, reason: string, payload?: unknown): void {
    const json = payload === undefined ? null : JSON.stringify(payload).slice(0, 2000);
    this.stmtUpsertQuarantine.run(input.source, input.raw, reason, json, new Date().toISOString());
  }

  private modelExists(id: string): boolean {
    return this.stmtModelById.get(id) !== undefined;
  }

  private aliasLookup(alias: string): string | null {
    const row = this.stmtAliasLookup.get(alias) as { model_id: string } | undefined;
    return row?.model_id ?? null;
  }

  private fuzzyMatch(canon: string): Resolution | null {
    const inputSig = digitSignature(canon);
    // Candidate strings per model: canonical id, its name part, its display
    // name, and every registered alias — all in canonical slug form.
    const scores = new Map<string, number>(); // model_id -> best similarity
    const consider = (candidate: string, model_id: string): void => {
      const c = canonicalizeModelId(candidate);
      if (digitSignature(c) !== inputSig) return;
      const s = Math.max(similarity(canon, c), similarity(canon, c.split('/').pop() ?? c));
      if (s > (scores.get(model_id) ?? 0)) scores.set(model_id, s);
    };
    for (const row of this.stmtAllModels.all() as ModelRow[]) {
      consider(row.id, row.id);
      consider(row.name, row.id);
    }
    for (const row of this.stmtAllAliases.all() as { alias: string; model_id: string }[]) {
      consider(row.alias, row.model_id);
    }

    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const best = ranked[0];
    if (!best || best[1] < FUZZY_THRESHOLD) return null;
    const second = ranked[1];
    if (second && second[1] >= FUZZY_THRESHOLD && best[1] - second[1] < FUZZY_AMBIGUITY_MARGIN) {
      return { status: 'ambiguous', candidates: [best[0], second[0]].sort() };
    }
    return { status: 'matched', model_id: best[0], via: 'fuzzy', confidence: best[1] };
  }
}
