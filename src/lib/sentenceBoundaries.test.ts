/**
 * Unit tests for estimateSentenceBoundaries (pure function — no DOM).
 *
 * Run with: npm run test:boundaries  (Node's built-in test runner + type stripping)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateSentenceBoundaries,
  splitSentences,
} from "./sentenceBoundaries.ts";

test("single sentence yields one boundary at the clip end", () => {
  assert.deepEqual(estimateSentenceBoundaries("Hello there.", 3000), [3000]);
  // No terminal punctuation still counts as one sentence.
  assert.deepEqual(estimateSentenceBoundaries("Hello there", 2500), [2500]);
});

test("multiple sentences: ascending boundaries, last equals duration", () => {
  const b = estimateSentenceBoundaries("Hi! How are you? Great.", 3000);
  assert.equal(b.length, 3);
  assert.ok(b[0] < b[1], "strictly ascending");
  assert.ok(b[1] < b[2], "strictly ascending");
  assert.equal(b[2], 3000, "last boundary is the clip end");
  // Proportional weighting: the long middle sentence gets the biggest slice.
  assert.ok(b[1] - b[0] > b[0], "longer sentence spans more time");
});

test("ellipsis is one terminator, not three splits", () => {
  assert.deepEqual(splitSentences("Wait... what?"), ["Wait...", "what?"]);
  const b = estimateSentenceBoundaries("Wait... what?", 2000);
  assert.equal(b.length, 2);
  assert.equal(b[1], 2000);
});

test("abbreviations Mr./Dr. do not split", () => {
  assert.deepEqual(splitSentences("Mr. Bear is nice. Dr. Duck agrees!"), [
    "Mr. Bear is nice.",
    "Dr. Duck agrees!",
  ]);
});

test("decimals do not split", () => {
  assert.deepEqual(splitSentences("I got 3.5 points. Yay!"), [
    "I got 3.5 points.",
    "Yay!",
  ]);
});

test("empty and punctuation-only text never throw", () => {
  assert.deepEqual(estimateSentenceBoundaries("", 3000), [3000]);
  assert.deepEqual(estimateSentenceBoundaries("   ", 3000), [3000]);
  assert.deepEqual(estimateSentenceBoundaries("...", 3000), [3000]);
});

test("zero or negative duration is guarded", () => {
  assert.deepEqual(estimateSentenceBoundaries("Hi! There.", 0), [0]);
  assert.deepEqual(estimateSentenceBoundaries("Hi! There.", -5), [0]);
});
