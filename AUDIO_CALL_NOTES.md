# Audio Call — Known Limitations & Notes

The Call tab is a hands-free, WeChat-style voice call: automatic
voice-activity detection (VAD) starts/stops recording, replies play as
audio, and the user can talk over Buddy to interrupt (barge-in).

## How it works

1. `getUserMedia` opens the mic with `echoCancellation`,
   `noiseSuppression`, and `autoGainControl` enabled.
2. A Web Audio `AnalyserNode` measures RMS every 50 ms
   ([src/lib/vad.ts](src/lib/vad.ts)). Speech starts after ~120 ms of
   sustained sound above an adaptive threshold, ends after 700 ms of
   trailing silence, and is hard-capped at 30 s.
3. The segment is recorded with an explicitly chosen MediaRecorder
   codec and posted to the existing `/api/conversation` endpoint
   (DashScope ASR → DeepSeek LLM → Edge TTS). The API contract is
   unchanged.
4. Buddy's reply plays through an `<audio>` element; the mic stays
   armed, so speech during playback stops the reply (barge-in).

All tuning lives in the exported `VAD_CONFIG` object at the top of
`src/lib/vad.ts`. Unit tests: `npm run test:vad`.

## Mobile PWA: screen lock / backgrounding

- When the screen locks or the PWA is backgrounded, mobile browsers
  suspend JavaScript timers (`requestAnimationFrame`) and may release
  the microphone. VAD and in-flight recording pause/stop; the call does
  **not** continue reliably in the background. This is an OS-level
  restriction for non-calling web apps (only WebRTC/telephony apps get
  background audio), not something the page can opt out of.
- Returning to the foreground leaves the UI in its last phase; the user
  should tap End and Start again for a clean session.
- iOS Safari only grants mic access to a page served over HTTPS
  (localhost is exempt for development).

## Browser support

| Capability | Chrome/Edge | Safari 14.1+ | Firefox |
| --- | --- | --- | --- |
| `getUserMedia` + echo/noise/AGC | ✅ | ✅ (options may be partially ignored) | ✅ |
| VAD via `AnalyserNode` | ✅ | ✅ | ✅ |
| Recorder `audio/webm;codecs=opus` (preferred) | ✅ | ❌ (picks `audio/mp4`) | ✅ |
| Recorder `audio/mp4` fallback | ❌ (picks webm) | ✅ | ❌ |
| Recorder `audio/ogg;codecs=opus` | sometimes | ❌ | ✅ |

The first codec the browser reports as supported is selected and logged
(`🎙️ [call] MediaRecorder codec selected: …`). The server accepts the
produced container because DashScope decodes the payload, not the
extension; the uploaded file extension mirrors the selected MIME type
(`.webm` / `.m4a` / `.ogg`).

Bluetooth headsets generally work, but some platforms expose a higher
latency and a noisier capture; the 120 ms start confirmation and 700 ms
trailing silence tolerances account for this.

## Barge-in & echo

Barge-in relies on the browser's acoustic echo cancellation removing
Buddy's voice from the mic signal. With speakers at high volume (or a
browser that silently disables AEC), Buddy's own speech can
occasionally trigger a self-interruption. A 300 ms post-playback
cooldown (`VAD_CONFIG.cooldownMs`) suppresses the audio tail. For the
best experience, use a low speaker volume or headphones.

## Why interim (streaming) ASR is out of scope

The current STT provider (DashScope `qwen3asr-flash`) is called with a
complete audio file and returns a final transcript; it does not stream
partial results. Showing live words while the child is still speaking
would require either a streaming ASR provider or a persistent WebSocket
media pipeline, which is tracked as a separate future task. Until then,
captions appear after each utterance is sent.

## Cost / safety guardrails

- Each utterance costs 1 ASR + 1 LLM + 1 TTS request.
- Single utterance cap: 30 s (`VAD_CONFIG.maxUtteranceMs`) prevents a
  stuck-open recording from looping.
- Per-call cap: 15 minutes (`MAX_CALL_MS` in
  [src/components/AudioCall.tsx](src/components/AudioCall.tsx)), with a
  30-second "call ending soon" notice.
