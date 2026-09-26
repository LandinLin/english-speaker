/**
 * Estimate sentence end-times inside a TTS audio clip.
 *
 * The /api/conversation response carries no word-level timing, so the Voice
 * Call feature splits the reply TEXT into sentences and distributes the
 * known audio duration across them proportionally to character count. A few
 * hundred milliseconds of error is fine — the estimate only decides where
 * Buddy may pause for an interruption without being cut off mid-sentence.
 *
 * Pure function: no DOM, unit-tested via Node type stripping
 * (see src/lib/sentenceBoundaries.test.ts).
 */

/** Placeholders used to protect non-terminal periods while splitting. */
const ABBREV_DOT = "";
const DECIMAL_DOT = "";

/**
 * Periods that must NOT end a sentence:
 *  - titles/abbreviations: Mr. Mrs. Ms. Dr. St. Jr. Sr. Prof.
 *  - latin/time abbreviations with internal dots: e.g. i.e. a.m. p.m.
 *  - decimals: 3.5 (the dot sits between two digits)
 */
function protectNonTerminalPeriods(text: string): string {
  return text
    .replace(
      /\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|Prof)\./gi,
      (m) => m.slice(0, -1) + ABBREV_DOT
    )
    .replace(/\b(e)\.g\./gi, `$1${ABBREV_DOT}g${ABBREV_DOT}`)
    .replace(/\b(i)\.e\./gi, `$1${ABBREV_DOT}e${ABBREV_DOT}`)
    .replace(/\b([ap])\.m\./gi, `$1${ABBREV_DOT}m${ABBREV_DOT}`)
    .replace(/(\d)\.(\d)/g, `$1${DECIMAL_DOT}$2`);
}

function restorePeriods(text: string): string {
  return text
    .replaceAll(ABBREV_DOT, ".")
    .replaceAll(DECIMAL_DOT, ".");
}

/**
 * Split into sentences. Runs of ., !, ? (including "...") terminate one
 * sentence each; trailing text without final punctuation is its own
 * sentence. Returns [] when nothing but punctuation/whitespace is present.
 */
export function splitSentences(text: string): string[] {
  const prepared = protectNonTerminalPeriods(text);
  const parts = prepared.match(/[^.!?]+(?:[.!?]+|$)/g);
  if (!parts) return [];
  return parts
    .map((p) => restorePeriods(p).trim())
    .filter((p) => p.length > 0);
}

/**
 * Cumulative sentence end-times in milliseconds, one per sentence, the last
 * always exactly `audioDurationMs`. Boundaries are strictly ascending.
 *
 * Guards: empty/whitespace text, no sentence punctuation, or a non-positive
 * duration all yield a single end boundary (no splitting possible).
 */
export function estimateSentenceBoundaries(
  text: string,
  audioDurationMs: number
): number[] {
  if (!Number.isFinite(audioDurationMs) || audioDurationMs <= 0) return [0];
  const sentences = splitSentences(text);
  if (sentences.length <= 1) return [audioDurationMs];

  const weights = sentences.map((s) => Math.max(1, s.length));
  const total = weights.reduce((a, b) => a + b, 0);

  const boundaries: number[] = [];
  let acc = 0;
  for (let i = 0; i < sentences.length; i++) {
    acc += weights[i];
    if (i === sentences.length - 1) {
      boundaries.push(audioDurationMs);
    } else {
      const raw = Math.round((audioDurationMs * acc) / total);
      // Rounding a tiny sentence could duplicate a boundary — keep ascending
      // and never let an inner boundary exceed the clip's end.
      boundaries.push(
        Math.min(audioDurationMs, Math.max((boundaries[i - 1] ?? 0) + 1, raw))
      );
    }
  }
  return boundaries;
}
