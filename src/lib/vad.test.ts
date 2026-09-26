/**
 * Unit tests for the VAD state machine (no DOM / AudioContext required —
 * we drive the pure processLevel() method with synthetic RMS samples).
 *
 * Timestamps start at 0, matching a freshly constructed detector (the
 * first VAD_CONFIG.startupAdaptMs use a fast noise-floor adaptation).
 *
 * Run with: npm run test:vad  (Node's built-in test runner + type stripping)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { VoiceActivityDetector, VAD_CONFIG } from "./vad.ts";

interface Event {
  type: "start" | "end";
  reason?: string;
}

/** Feed a constant RMS level every 50 ms over [fromMs, toMs]. */
function feed(
  vad: VoiceActivityDetector,
  rms: number,
  fromMs: number,
  toMs: number
): void {
  for (let t = fromMs; t <= toMs; t += VAD_CONFIG.frameMs) {
    vad.processLevel(rms, t);
  }
}

function makeVad(): { vad: VoiceActivityDetector; events: Event[] } {
  const events: Event[] = [];
  const vad = new VoiceActivityDetector({
    onSpeechStart: () => events.push({ type: "start" }),
    onSpeechEnd: (reason) => events.push({ type: "end", reason }),
  });
  return { vad, events };
}

test("silence → tone → silence emits start then silence-end", () => {
  const { vad, events } = makeVad();

  feed(vad, 0.001, 0, 1000); // quiet room baseline
  feed(vad, 0.1, 1000, 1600); // ~600ms of speech
  feed(vad, 0.001, 1600, 2400); // trailing pause

  const starts = events.filter((e) => e.type === "start");
  const ends = events.filter((e) => e.type === "end");
  assert.equal(starts.length, 1, "exactly one speech start");
  assert.equal(ends.length, 1, "exactly one speech end");
  assert.equal(ends[0].reason, "silence");
});

test("sub-startConfirm click (100ms) fires no callbacks at all", () => {
  const { vad, events } = makeVad();

  feed(vad, 0.001, 0, 950);
  // Three loud frames = 100ms span, below the 120ms confirmation window.
  feed(vad, 0.1, 1000, 1100);
  feed(vad, 0.001, 1150, 2200);

  assert.equal(events.length, 0);
});

test("150ms blip starts but is discarded with reason 'cancel'", () => {
  const { vad, events } = makeVad();

  feed(vad, 0.001, 0, 950);
  // Loud long enough to confirm (>=120ms) but under the 200ms minimum.
  feed(vad, 0.1, 1000, 1150);
  feed(vad, 0.001, 1200, 2200);

  assert.equal(events.length, 2);
  assert.equal(events[0].type, "start");
  assert.equal(events[1].type, "end");
  assert.equal(events[1].reason, "cancel");
});

test("continuous noise above threshold hits the maxUtteranceMs cap", () => {
  const { vad, events } = makeVad();

  feed(vad, 0.001, 0, 950);
  // Loud forever: maxUtteranceMs (30s) measured from speech start.
  feed(vad, 0.1, 1000, 32000);

  const maxEnds = events.filter(
    (e) => e.type === "end" && e.reason === "max"
  );
  assert.equal(maxEnds.length, 1, "one force-end from the max cap");

  // Every end within the window must be the safety cap, never a normal end.
  const ends = events.filter((e) => e.type === "end");
  assert.ok(ends.every((e) => e.reason === "max"));
});

test("cooldown window suppresses speech detection", () => {
  const { vad, events } = makeVad();
  const t0 = 2000;

  feed(vad, 0.001, t0 - 1000, t0 - 50);

  // Ignore everything for 1 second (simulates post-AI tail guard).
  vad.beginCooldown(1000, t0);
  feed(vad, 0.1, t0, t0 + 900); // loud during cooldown
  assert.equal(events.length, 0, "no callbacks during cooldown");

  // After the cooldown, normal speech works again.
  feed(vad, 0.1, t0 + 1050, t0 + 1700);
  feed(vad, 0.001, t0 + 1750, t0 + 2700);
  const starts = events.filter((e) => e.type === "start");
  assert.equal(starts.length, 1, "speech detected only after cooldown ends");
});

test("soft voice just above the absolute floor still triggers", () => {
  const { vad, events } = makeVad();

  // Let the noise floor settle to a very quiet room (floored at 0.001).
  feed(vad, 0.001, 0, 1200);
  // Soft speaker: 0.012 RMS — above the 0.008 absolute floor.
  feed(vad, 0.012, 1200, 1800);
  feed(vad, 0.001, 1800, 2800);

  assert.equal(
    events.some((e) => e.type === "start"),
    true,
    "soft-spoken user is detected"
  );
});

test("raised startConfirmMs ignores short noise bursts (Buddy speaking)", () => {
  const { vad, events } = makeVad();

  feed(vad, 0.001, 0, 2000); // quiet room baseline
  vad.setStartConfirmMs(500); // Buddy's reply starts playing

  // A 300ms "hmm" never emits any event.
  feed(vad, 0.1, 2000, 2300);
  feed(vad, 0.001, 2350, 3000);
  assert.equal(events.length, 0, "short noise is fully ignored");

  // A genuine 600ms interruption still confirms and ends normally.
  feed(vad, 0.1, 3000, 3600);
  feed(vad, 0.001, 3650, 4600);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "start");
  assert.equal(events[1].type, "end");

  // Restoring the default re-enables the snappy 120ms confirmation.
  vad.setStartConfirmMs(VAD_CONFIG.startConfirmMs);
  feed(vad, 0.1, 5000, 5250); // 250ms burst
  feed(vad, 0.001, 5300, 6300);
  assert.equal(events.length, 4, "default window detects short speech again");
});
