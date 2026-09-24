"use client";

/**
 * Lightweight energy-based Voice Activity Detector (VAD).
 *
 * Uses the Web Audio API `AnalyserNode` to measure the RMS volume of a
 * microphone stream and fires `onSpeechStart` / `onSpeechEnd` callbacks.
 * An adaptive noise floor handles varying background environments so a
 * fixed threshold doesn't have to be tuned per device.
 *
 * This is intentionally simple (no ML model) — good enough for a
 * conversational call where each utterance is followed by a clear pause.
 */

export interface VadCallbacks {
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
}

interface VadOptions {
  /** How many consecutive loud frames before speech is declared. */
  speechFrames?: number;
  /** How many consecutive quiet frames (after speech) before end is declared. */
  silenceFrames?: number;
  /** RMS must exceed this absolute floor to count as speech. */
  absoluteFloor?: number;
  /** Speech threshold = max(absoluteFloor, noiseFloor * speechGain). */
  speechGain?: number;
  /** Once speaking, RMS below noiseFloor * silenceGain counts as quiet. */
  silenceGain?: number;
}

const DEFAULT_OPTIONS: Required<VadOptions> = {
  speechFrames: 4, // ~80ms at 50ms tick
  silenceFrames: 14, // ~700ms at 50ms tick
  absoluteFloor: 0.012,
  speechGain: 3,
  silenceGain: 1.8,
};

export class VoiceActivityDetector {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private timeData: Uint8Array<ArrayBuffer> | null = null;
  private rafId: number | null = null;
  private tickTimer: number | null = null;
  private running = false;
  private muted = false;

  private readonly opts: Required<VadOptions>;
  private readonly callbacks: VadCallbacks;

  private noiseFloor = 0.02;
  private loudCount = 0;
  private quietCount = 0;
  private speaking = false;
  private lastTick = 0;

  constructor(callbacks: VadCallbacks, options?: VadOptions) {
    this.callbacks = callbacks;
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  /** Attach to a microphone stream and begin monitoring. */
  async start(stream: MediaStream): Promise<void> {
    if (this.running) return;

    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) {
      throw new Error("Web Audio API is not supported in this browser");
    }

    this.audioContext = new Ctor();
    this.source = this.audioContext.createMediaStreamSource(stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.4;
    this.timeData = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
    this.source.connect(this.analyser);

    // Reset state for a fresh call.
    this.noiseFloor = 0.02;
    this.loudCount = 0;
    this.quietCount = 0;
    this.speaking = false;
    this.lastTick = performance.now();
    this.running = true;

    // 50ms tick via rAF (capped to the frame rate, fine for VAD).
    const loop = () => {
      if (!this.running) return;
      const now = performance.now();
      if (now - this.lastTick >= 50) {
        this.lastTick = now;
        this.tick();
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  /** Pause speech detection (e.g. while the AI is speaking or user muted). */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      // Reset transient counts so unmuting doesn't immediately fire events.
      this.loudCount = 0;
      this.quietCount = 0;
      this.speaking = false;
    }
  }

  /** Stop monitoring and release audio resources. */
  stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
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
  }

  private tick(): void {
    if (!this.analyser || !this.timeData || this.muted) return;

    this.analyser.getByteTimeDomainData(this.timeData);

    // RMS of the centered waveform (getByteTimeDomainData is 0..255, center 128).
    let sum = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const v = (this.timeData[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.timeData.length);

    // Slowly adapt the noise floor toward the quietest recent levels.
    this.noiseFloor = this.noiseFloor * 0.98 + Math.min(rms, this.noiseFloor) * 0.02;
    const threshold = Math.max(
      this.opts.absoluteFloor,
      this.noiseFloor * this.opts.speechGain
    );
    const loud = rms > threshold;

    if (loud) {
      this.loudCount += 1;
      this.quietCount = 0;
      if (!this.speaking && this.loudCount >= this.opts.speechFrames) {
        this.speaking = true;
        this.callbacks.onSpeechStart();
      }
    } else {
      this.quietCount += 1;
      this.loudCount = 0;
      if (this.speaking && this.quietCount >= this.opts.silenceFrames) {
        this.speaking = false;
        this.callbacks.onSpeechEnd();
      }
    }
  }
}
