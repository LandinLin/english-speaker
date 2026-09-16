/**
 * Parsing for the tutor's labeled response format.
 *
 * The model is asked to emit:
 *   REPLY: ...
 *   PRAISE: ...
 *   CORRECTION: ... | None
 *   NEW_WORD: ... | None
 *
 * In practice the model sometimes puts every label on a single line,
 * omits the REPLY label, or writes "NEW WORD" — this parser locates
 * labels by POSITION (anywhere in the text, case-insensitive) and takes
 * each field's content up to the next label, so labels can never leak
 * into the visible bubble.
 */

export interface TutorFeedback {
  reply: string;
  praise: string;
  correction: string;
  newWord: string;
}

type FieldLabel = "REPLY" | "PRAISE" | "CORRECTION" | "NEW_WORD";

// Tolerates "NEW WORD", lowercase, and spacing before the colon.
const LABEL_PATTERN = /\b(?:REPLY|PRAISE|CORRECTION|NEW[ _]WORD)\s*:/gi;

const NONE = "None";

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

interface Segment {
  label: FieldLabel;
  value: string;
}

function toLabel(rawMatch: string): FieldLabel {
  const clean = rawMatch.toUpperCase().replace(/[\s:]/g, "");
  return clean === "NEWWORD" ? "NEW_WORD" : (clean as FieldLabel);
}

/**
 * If a trailing question sentence got glued onto the last field
 * (happens with inline one-line responses: "NEW_WORD: family - ...
 * What did you eat?"), move it back onto the reply.
 */
function peelTrailingQuestion(value: string): {
  field: string;
  tail?: string;
} {
  // Punctuation may be followed by a closing quote ("thank you.").
  const match = value.match(/^(.*?[.!?]["']?)\s+([^.!?]*\?\s*["']?\s*)$/);
  if (!match) return { field: value };
  return { field: match[1].trim(), tail: match[2].trim() };
}

export function parseTutorResponse(raw: string): TutorFeedback {
  const text = (raw ?? "").trim();
  if (!text) {
    return { reply: "", praise: NONE, correction: NONE, newWord: NONE };
  }

  const matches = [...text.matchAll(LABEL_PATTERN)];

  if (matches.length === 0) {
    // Unstructured reply — nothing to extract.
    return { reply: text, praise: NONE, correction: NONE, newWord: NONE };
  }

  const segments: Segment[] = matches.map((match, i) => {
    const contentStart = (match.index ?? 0) + match[0].length;
    const contentEnd =
      i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    return {
      label: toLabel(match[0]),
      value: collapse(text.slice(contentStart, contentEnd)),
    };
  });

  const valueOf = (label: FieldLabel): string =>
    segments.find((s) => s.label === label)?.value ?? "";

  // A field can be "None" with reply text accidentally glued after it
  // (e.g. inline "NEW_WORD: None How are you?") — drop the None and
  // recover the trailing text back onto the reply.
  const recovered: string[] = [];
  for (const segment of segments) {
    const noneMatch = segment.value.match(/^none\b[.:]?\s*(.*)$/i);
    if (noneMatch) {
      segment.value = NONE;
      const tail = collapse(noneMatch[1]);
      if (tail) recovered.push(tail);
    }
  }

  let reply = valueOf("REPLY");
  const praise = valueOf("PRAISE") || NONE;
  const correction = valueOf("CORRECTION") || NONE;
  let newWord = valueOf("NEW_WORD") || NONE;

  // Missing REPLY label: everything before the first label is the reply.
  if (!reply) {
    reply = collapse(text.slice(0, matches[0].index ?? 0));
  }

  // Recover a trailing question glued onto the final field.
  const lastSegment = segments[segments.length - 1];
  if (lastSegment && lastSegment.value && lastSegment.value !== NONE) {
    const { field, tail } = peelTrailingQuestion(lastSegment.value);
    if (tail) {
      if (lastSegment.label === "NEW_WORD") newWord = field || NONE;
      recovered.push(tail);
    }
  }

  if (recovered.length > 0) {
    reply = [reply, ...recovered].filter(Boolean).join(" ");
  }

  return { reply: reply || text, praise, correction, newWord };
}

// ---------------------------------------------------------------------------
// Display helpers — also repair legacy messages whose stored text contains
// labels inline (stored before the parser was made position-aware).
// ---------------------------------------------------------------------------

export interface DisplayFeedback {
  text: string;
  praise?: string;
  correction?: string;
  newWord?: string;
}

function meaningful(value?: string | null): string | undefined {
  const trimmed = (value ?? "").trim();
  if (!trimmed || trimmed.toLowerCase() === NONE.toLowerCase()) return undefined;
  return trimmed;
}

export function displayParts(input: {
  text: string;
  praise?: string | null;
  correction?: string | null;
  newWord?: string | null;
}): DisplayFeedback {
  const praise = meaningful(input.praise);
  const correction = meaningful(input.correction);
  const newWord = meaningful(input.newWord);

  // Structured fields exist (new messages, or old multiline-parsed ones).
  if (praise || correction || newWord) {
    return { text: input.text, praise, correction, newWord };
  }

  // Legacy message with labels embedded inside the bubble text.
  if (LABEL_PATTERN.test(input.text)) {
    LABEL_PATTERN.lastIndex = 0;
    const parsed = parseTutorResponse(input.text);
    return {
      text: parsed.reply,
      praise: meaningful(parsed.praise),
      correction: meaningful(parsed.correction),
      newWord: meaningful(parsed.newWord),
    };
  }

  return { text: input.text };
}
