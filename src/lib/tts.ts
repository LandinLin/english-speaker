import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

// ---------------------------------------------------------------------------
// Edge TTS (free, no API key) — Microsoft Edge "Read Aloud" online service.
// Package: `msedge-tts` (Node.js port of rany2/edge-tts). Note: the npm
// package literally named `edge-tts` (v1.0.1) hardcodes an old auth token and
// gets HTTP 403 from Microsoft, so `msedge-tts` (actively maintained,
// generates the required Sec-MS-GEC token) is used instead.
// ---------------------------------------------------------------------------

const EDGE_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Teacher accents × genders. US/UK use child-like female Neural voices where
// available; AU/IN use warm adult female voices (Microsoft ships no child
// voices for those locales). Male voices are warm adult voices. The mapping
// lives server-side so only accent/gender ids cross the API.
// ---------------------------------------------------------------------------

export type AccentId = "us" | "uk" | "au" | "in";
export type GenderId = "female" | "male";

export const VOICE_MAP: Record<AccentId, Record<GenderId, string>> = {
  us: {
    female: "en-US-AnaNeural", // child, friendly
    male: "en-US-BrianNeural", // warm, younger-sounding male
  },
  uk: {
    female: "en-GB-MaisieNeural", // child, British
    male: "en-GB-RyanNeural", // warm British male
  },
  au: {
    female: "en-AU-NatashaNeural", // warm female, Australian
    male: "en-AU-WilliamNeural", // relaxed Aussie male
  },
  in: {
    female: "en-IN-NeerjaNeural", // warm female, Indian
    male: "en-IN-PrabhatNeural", // warm Indian male
  },
};

/** Default voice (US female) used when ids are missing or unknown. */
export const DEFAULT_VOICE = VOICE_MAP.us.female;

function isAccentId(value: unknown): value is AccentId {
  return value === "us" || value === "uk" || value === "au" || value === "in";
}

function isGenderId(value: unknown): value is GenderId {
  return value === "female" || value === "male";
}

/** Resolve client-supplied accent/gender ids to an Edge voice. */
export function getVoiceForAccent(
  accent?: string | null,
  gender?: string | null
): string {
  if (isAccentId(accent)) {
    return VOICE_MAP[accent][isGenderId(gender) ? gender : "female"];
  }
  return DEFAULT_VOICE;
}

/** Escape text for safe insertion into an SSML document. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Synthesize speech with Edge TTS.
 *
 * Accepts accent/gender ids (resolved through VOICE_MAP) or an explicit voice
 * name. Unknown values fall back to the default US female voice.
 *
 * @returns MP3 audio buffer, or `null` when synthesis fails. Failures are
 *          logged but never thrown so the conversation can continue with a
 *          text-only reply (the frontend already skips playback when no
 *          audio is returned).
 */
export async function synthesizeSpeechEdge(
  text: string,
  accent?: string | null,
  gender?: string | null
): Promise<Buffer | null> {
  const trimmed = text?.trim();
  if (!trimmed) return null;

  const voice = getVoiceForAccent(accent, gender);

  let tts: MsEdgeTTS | null = null;
  try {
    tts = new MsEdgeTTS();
    await tts.setMetadata(
      voice,
      OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
    );

    const { audioStream } = tts.toStream(escapeXml(trimmed));

    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        reject(new Error("Edge TTS timed out"));
      }, EDGE_TIMEOUT_MS);

      audioStream.on("data", (chunk: unknown) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      });
      audioStream.on("end", () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      });
      audioStream.on("error", (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    if (buffer.length === 0) {
      throw new Error("Edge TTS returned no audio data");
    }
    return buffer;
  } catch (error) {
    console.error(
      "🔊 [tts] Edge TTS failed:",
      error instanceof Error ? error.message : error
    );
    return null;
  } finally {
    tts?.close();
  }
}

// ---------------------------------------------------------------------------
// Volcengine TTS — kept for later use (switch back by swapping the call in
// src/app/api/conversation/route.ts). Requires:
//   VOLCENGINE_TTS_APP_ID, VOLCENGINE_TTS_ACCESS_TOKEN
// ---------------------------------------------------------------------------
//
// import axios from "axios";
//
// const TTS_URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
// const DEFAULT_VOICE = "en_female_sarah_mars_bigtts";
// const DONE_CODE = 20000000;
//
// interface TtsEvent {
//   code?: number;
//   message?: string;
//   data?: string;
// }
//
// /**
//  * The endpoint streams multiple JSON objects back-to-back (newline separated
//  * in practice). Parse them without relying on the newline delimiter.
//  */
// function parseJsonStream(text: string): TtsEvent[] {
//   const events: TtsEvent[] = [];
//   let i = 0;
//   while (i < text.length) {
//     while (i < text.length && /\s/.test(text[i])) i++;
//     if (i >= text.length || text[i] !== "{") break;
//
//     let depth = 0;
//     let inString = false;
//     let escaped = false;
//     const start = i;
//
//     for (; i < text.length; i++) {
//       const ch = text[i];
//       if (inString) {
//         if (escaped) {
//           escaped = false;
//         } else if (ch === "\\") {
//           escaped = true;
//         } else if (ch === '"') {
//           inString = false;
//         }
//         continue;
//       }
//       if (ch === '"') inString = true;
//       else if (ch === "{") depth++;
//       else if (ch === "}") {
//         depth--;
//         if (depth === 0) {
//           i++;
//           break;
//         }
//       }
//     }
//
//     try {
//       events.push(JSON.parse(text.slice(start, i)) as TtsEvent);
//     } catch {
//       // Skip a malformed frame and keep scanning the rest.
//       break;
//     }
//   }
//   return events;
// }
//
// export async function synthesizeSpeech(text: string): Promise<Buffer> {
//   const appId = process.env.VOLCENGINE_TTS_APP_ID;
//   const accessKey = process.env.VOLCENGINE_TTS_ACCESS_TOKEN;
//   if (!appId || !accessKey) {
//     throw new Error(
//       "Missing VOLCENGINE_TTS_APP_ID or VOLCENGINE_TTS_ACCESS_TOKEN environment variable"
//     );
//   }
//
//   const voice = process.env.VOLCENGINE_TTS_VOICE || DEFAULT_VOICE;
//
//   try {
//     const response = await axios.post(
//       TTS_URL,
//       {
//         user: { uid: "english-buddy" },
//         req_params: {
//           text,
//           speaker: voice,
//           audio_params: {
//             format: "mp3",
//             sample_rate: 24000,
//           },
//         },
//       },
//       {
//         responseType: "text",
//         headers: {
//           "Content-Type": "application/json",
//           "X-Api-App-Id": appId,
//           "X-Api-Access-Key": accessKey,
//           "X-Api-Resource-Id": "volc.service_type.10029",
//         },
//         timeout: 30_000,
//       }
//     );
//
//     const rawText =
//       typeof response.data === "string"
//         ? response.data
//         : Buffer.from(response.data as ArrayBuffer).toString("utf-8");
//     const events = parseJsonStream(rawText);
//
//     if (events.length === 0) {
//       throw new Error("TTS returned an empty response");
//     }
//
//     const chunks: Buffer[] = [];
//     for (const event of events) {
//       if (typeof event.code === "number" && event.code !== 0 && event.code !== DONE_CODE) {
//         throw new Error(
//           `TTS stream error (${event.code}): ${event.message ?? "unknown"}`
//         );
//       }
//       if (event.code === 0 && typeof event.data === "string" && event.data) {
//         chunks.push(Buffer.from(event.data, "base64"));
//       }
//     }
//
//     if (chunks.length === 0) {
//       throw new Error("TTS returned no audio data");
//     }
//
//     return Buffer.concat(chunks);
//   } catch (error) {
//     if (axios.isAxiosError(error)) {
//       const raw = error.response?.data;
//       const detail = raw
//         ? typeof raw === "string"
//           ? raw.slice(0, 500)
//           : Buffer.from(raw as ArrayBuffer).toString("utf-8").slice(0, 500)
//         : error.message;
//       throw new Error(
//         `Volcengine TTS failed (${error.response?.status ?? "no status"}): ${detail}`
//       );
//     }
//     throw error;
//   }
// }
