"use client";

/**
 * Energy-based Voice Activity Detector (VAD) built on the Web Audio API.
 *
 * Measures microphone RMS volume each frame and emits onSpeechStart /
 * onSpeechEnd callbacks. An asymmetric adaptive noise floor tracks the
 * ambient level so the same defaults work in a quiet room, with TV/music
 * in the background, and with soft-spoken kids.
 *
 * The decision logic lives in the pure `processLevel()` method so the
 * state machine can be unit-tested without any DOM/AudioContext mocks
 * (see src/lib/vad.test.ts).
 */

/**
 * All tunable VAD parameters in one place. Times are milliseconds and
 * levels are RMS amplitudes in 0..1 (PCM centered at 128/128).
 */
export const VAD_CONFIG = {
  /** How often a microphone level sample is evaluated. */
  frameMs: 50,

  /**
   * A burst of loud sound must persist at least this long before
   * onSpeechStart fires. Filters clicks, pops and keyboard clack.
   */
  startConfirmMs: 120,

  /**
   * Minimum utterance length. Speech ending sooner than this (after the
   * trailing-silence wait) is discarded as noise — no start/end events
   * are emitted for it.
   */
  minSpeechMs: 200,

  /**
   * Trailing silence that closes an utterance. Short enough for natural
   * conversation (kids pause briefly between sentences), long enough not
   * to chop a mid-thought pause.
   */
  silenceMs: 700,

  /**
   * Hard cap on a single recorded utterance. If the level stays above
   * threshold continuously (stuck VAD, sustained background noise), the
   * utterance is force-closed and submitted anyway so recording can't
   * run forever.
   */
  maxUtteranceMs: 30_000,

  /**
   * After Buddy finishes speaking, ignore the microphone for this long
   * so the TTS tail / room echo doesn't immediately trigger a fake
   * utterance.
   */
  cooldownMs: 300,

  /**
   * Absolute RMS floor for speech detection, regardless of the measured
   * noise floor. Kept LOW (0.008) because kids — especially quiet ones
   * and Bluetooth headset users — speak softly; relying on noiseFloor
   * alone would never trigger for them.
   */
  absoluteFloorRms: 0.008,

  /**
   * Speech threshold = max(absoluteFloorRms, noiseFloor × speechGain).
   * 2.6× the ambient level: comfortably above typical TV/music bed but
   * reachable by a soft voice a meter from the mic.
   */
  speechGain: 2.6,

  /**
   * Level below which frames count as silence once speech has started.
   * Lower than speechGain (hysteresis) so natural level dips mid-word
   * don't end the utterance prematurely.
   */
  silenceGain: 1.5,

  /** Starting guess for the ambient noise floor. */
  initialNoiseFloor: 0.02,

  /**
   * Speed at which the noise floor tracks the ambient level while the
   * user is silent (exponential moving average). Slow so one loud laugh
   * doesn't desensitize detection for the next sentence.
   */
  noiseAdaptAlpha: 0.02,

  /**
   * For this long after start() the floor adapts quickly, so a call
   * opened in a noisy room calibrates before the first word.
   */
  startupAdaptMs: 500,
  startupAdaptAlpha: 0.25,

  /** Only samples quieter than noiseFloor × this are treated as "ambient"
   * and allowed to pull the noise floor up/down. */
  ambientCeilingGain: 1.8,
} as const;

export type VadEndReason = "silence" | "max" | "cancel";

export interface VadCallbacks {
  onSpeechStart: () => void;
  onSpeechEnd: (reason: VadEndReason) => void;
}

type VadState = "silent" | "speaking";

function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ||
    null
  );
}

/** Gesture-primed context waiting for start() to consume it. */
let primedContext: AudioContext | null = null;

export class VoiceActivityDetector {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private timeData: Uint8Array<ArrayBuffer> | null = null;
  private rafId: number | null = null;
  private running = false;
  private enabled = true;

  private readonly callbacks: VadCallbacks;

  // ── Pure state-machine fields (exercised directly by unit tests) ──
  private state: VadState = "silent";
  private startedAt = 0;
  private noiseFloor: number = VAD_CONFIG.initialNoiseFloor;
  private loudSince = 0; // timestamp of the first consecutive loud frame
  private quietSince = 0; // timestamp of the first consecutive quiet frame
  private speechStartedAt = 0;
  private voicedMs = 0; // cumulative loud time inside the current utterance
  private lastNow = 0;
  private cooldownUntil = 0;
  private lastLevel = 0;

  constructor(callbacks: VadCallbacks) {
    this.callbacks = callbacks;
    this.reset(0);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Create/resume the AudioContext synchronously inside the click gesture.
   *
   * getUserMedia() is awaited before VAD starts; on real devices a slow
   * microphone-permission prompt can consume the click's transient
   * activation, so an AudioContext constructed afterwards is born
   * "suspended" — its analyser only yields zeros and the VAD stays deaf
   * ("Listening…" forever). Constructing it here, in the gesture task,
   * guarantees a running context for start() to attach the source to.
   */
  static prime(): void {
    if (primedContext && primedContext.state !== "closed") {
      if (primedContext.state === "suspended") {
        void primedContext.resume().catch(() => {});
      }
      return;
    }
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    try {
      primedContext = new Ctor();
      if (primedContext.state === "suspended") {
        void primedContext.resume().catch(() => {});
      }
    } catch {
      primedContext = null;
    }
  }

  /**
   * Close a primed context that start() never consumed (e.g. the mic
   * permission was denied), so no AudioContext is leaked.
   */
  static cancelPrime(): void {
    if (primedContext) {
      void primedContext.close().catch(() => {});
      primedContext = null;
    }
  }

  /** Attach to a microphone stream and begin monitoring. */
  async start(stream: MediaStream): Promise<void> {
    if (this.running) return;

    const Ctor = audioContextCtor();
    if (!Ctor) {
      throw new Error("Web Audio API is not supported in this browser");
    }

    // Reuse the gesture-primed context when it survived; otherwise create
    // one here and explicitly resume it (sticky activation is enough).
    this.audioContext =
      primedContext && primedContext.state !== "closed"
        ? primedContext
        : new Ctor();
    primedContext = null;
    if (this.audioContext.state === "suspended") {
      try {
        await this.audioContext.resume();
      } catch {
        // rAF sampling continues; if the context never resumes the UI at
        // least stays usable (the user can end and retry the call).
      }
    }

    this.source = this.audioContext.createMediaStreamSource(stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.4;
    this.timeData = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
    this.source.connect(this.analyser);

    this.reset(performance.now());
    this.running = true;

    const loop = () => {
      if (!this.running) return;
      this.sampleFrame();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  /**
   * Ignore the microphone for `ms` (TTS-tail guard after Buddy speaks).
   * Any in-progress speech state is reset. `now` defaults to the real
   * clock but can be injected for tests.
   */
  beginCooldown(
    ms: number = VAD_CONFIG.cooldownMs,
    now: number = performance.now()
  ): void {
    this.cooldownUntil = now + ms;
    this.state = "silent";
    this.loudSince = 0;
    this.quietSince = 0;
  }

  /** Mute/unmute speech detection (user mute button). */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.state = "silent";
      this.loudSince = 0;
      this.quietSince = 0;
    }
  }

  /** Stop monitoring and release audio resources. */
  stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.source = null;
    this.analyser = null;
    this.timeData = null;
    if (this.audioContext) {
      void this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.reset(0);
  }

  /** Most recent RMS level (0..1) for UI meters. */
  getLevel(): number {
    return this.lastLevel;
  }

  // ── Internals ──────────────────────────────────────────────────────

  private reset(now: number): void {
    this.state = "silent";
    this.startedAt = now;
    this.noiseFloor = VAD_CONFIG.initialNoiseFloor;
    this.loudSince = 0;
    this.quietSince = 0;
    this.speechStartedAt = 0;
    this.voicedMs = 0;
    this.lastNow = now;
    this.cooldownUntil = 0;
    this.lastLevel = 0;
  }

  private sampleFrame(): void {
    if (!this.analyser || !this.timeData || !this.enabled) return;

    this.analyser.getByteTimeDomainData(this.timeData);
    let sum = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const v = (this.timeData[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.timeData.length);
    this.lastLevel = rms;

    // processLevel also dispatches the callbacks (single code path, so
    // unit tests driving processLevel directly see identical behavior).
    this.processLevel(rms, performance.now());
  }

  private lastEndReason: VadEndReason | null = null;

  /**
   * Feed one RMS sample to the state machine and dispatch callbacks.
   * Returns "start" / "end" / null. Has no hard DOM dependency beyond
   * timestamps, so it can be unit-tested directly.
   */
  processLevel(rms: number, now: number): "start" | "end" | null {
    const event = this.evaluateLevel(rms, now);
    if (event === "start") this.callbacks.onSpeechStart();
    else if (event === "end") {
      this.callbacks.onSpeechEnd(this.lastEndReason ?? "silence");
    }
    return event;
  }

  private evaluateLevel(rms: number, now: number): "start" | "end" | null {
    this.lastEndReason = null;
    const dt = this.lastNow ? Math.min(now - this.lastNow, VAD_CONFIG.frameMs * 2) : 0;
    this.lastNow = now;

    // Startup calibration / post-AI cooldown: listen and adapt, don't fire.
    if (now < this.cooldownUntil) {
      this.state = "silent";
      this.loudSince = 0;
      this.quietSince = 0;
      return null;
    }

    const speechThreshold = Math.max(
      VAD_CONFIG.absoluteFloorRms,
      this.noiseFloor * VAD_CONFIG.speechGain
    );
    const silenceThreshold = Math.max(
      VAD_CONFIG.absoluteFloorRms,
      this.noiseFloor * VAD_CONFIG.silenceGain
    );

    if (this.state === "silent") {
      // Adapt the ambient floor only from genuinely quiet frames, with
      // fast adaptation during the first startupAdaptMs.
      const age = now - this.startedAt;
      const alpha =
        age < VAD_CONFIG.startupAdaptMs
          ? VAD_CONFIG.startupAdaptAlpha
          : VAD_CONFIG.noiseAdaptAlpha;
      if (rms < this.noiseFloor * VAD_CONFIG.ambientCeilingGain) {
        this.noiseFloor += (rms - this.noiseFloor) * alpha;
        if (this.noiseFloor < 0.001) this.noiseFloor = 0.001;
      }

      if (rms > speechThreshold) {
        if (this.loudSince === 0) this.loudSince = now;
        if (now - this.loudSince >= VAD_CONFIG.startConfirmMs) {
          this.state = "speaking";
          this.speechStartedAt = this.loudSince;
          // Include the confirmation burst itself as voiced time.
          this.voicedMs = now - this.loudSince;
          this.quietSince = 0;
          return "start";
        }
      } else {
        this.loudSince = 0;
      }
      return null;
    }

    // state === "speaking"
    const duration = now - this.speechStartedAt;

    // Hard cap: stuck-open VAD / continuous noise must still submit.
    if (duration >= VAD_CONFIG.maxUtteranceMs) {
      this.state = "silent";
      this.loudSince = 0;
      this.quietSince = 0;
      this.voicedMs = 0;
      this.lastEndReason = "max";
      return "end";
    }

    if (rms < silenceThreshold) {
      if (this.quietSince === 0) this.quietSince = now;
      if (now - this.quietSince >= VAD_CONFIG.silenceMs) {
        this.state = "silent";
        this.loudSince = 0;
        this.quietSince = 0;
        // Measure actual VOICED time (excludes the trailing silence):
        // a click under minSpeechMs ends with "cancel", never a submission.
        this.lastEndReason =
          this.voicedMs >= VAD_CONFIG.minSpeechMs ? "silence" : "cancel";
        this.voicedMs = 0;
        return "end";
      }
    } else {
      this.voicedMs += dt;
      this.quietSince = 0;
    }
    return null;
  }
}
