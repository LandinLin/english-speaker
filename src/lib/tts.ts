import axios from "axios";

const TTS_URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
const DEFAULT_VOICE = "en_female_sarah_mars_bigtts";
const DONE_CODE = 20000000;

interface TtsEvent {
  code?: number;
  message?: string;
  data?: string;
}

/**
 * The endpoint streams multiple JSON objects back-to-back (newline separated
 * in practice). Parse them without relying on the newline delimiter.
 */
function parseJsonStream(text: string): TtsEvent[] {
  const events: TtsEvent[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length || text[i] !== "{") break;

    let depth = 0;
    let inString = false;
    let escaped = false;
    const start = i;

    for (; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }

    try {
      events.push(JSON.parse(text.slice(start, i)) as TtsEvent);
    } catch {
      // Skip a malformed frame and keep scanning the rest.
      break;
    }
  }
  return events;
}

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const appId = process.env.VOLCENGINE_TTS_APP_ID;
  const accessKey = process.env.VOLCENGINE_TTS_ACCESS_TOKEN;
  if (!appId || !accessKey) {
    throw new Error(
      "Missing VOLCENGINE_TTS_APP_ID or VOLCENGINE_TTS_ACCESS_TOKEN environment variable"
    );
  }

  const voice = process.env.VOLCENGINE_TTS_VOICE || DEFAULT_VOICE;

  try {
    const response = await axios.post(
      TTS_URL,
      {
        user: { uid: "english-buddy" },
        req_params: {
          text,
          speaker: voice,
          audio_params: {
            format: "mp3",
            sample_rate: 24000,
          },
        },
      },
      {
        responseType: "text",
        headers: {
          "Content-Type": "application/json",
          "X-Api-App-Id": appId,
          "X-Api-Access-Key": accessKey,
          "X-Api-Resource-Id": "volc.service_type.10029",
        },
        timeout: 30_000,
      }
    );

    const rawText =
      typeof response.data === "string"
        ? response.data
        : Buffer.from(response.data as ArrayBuffer).toString("utf-8");
    const events = parseJsonStream(rawText);

    if (events.length === 0) {
      throw new Error("TTS returned an empty response");
    }

    const chunks: Buffer[] = [];
    for (const event of events) {
      if (typeof event.code === "number" && event.code !== 0 && event.code !== DONE_CODE) {
        throw new Error(
          `TTS stream error (${event.code}): ${event.message ?? "unknown"}`
        );
      }
      if (event.code === 0 && typeof event.data === "string" && event.data) {
        chunks.push(Buffer.from(event.data, "base64"));
      }
    }

    if (chunks.length === 0) {
      throw new Error("TTS returned no audio data");
    }

    return Buffer.concat(chunks);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const raw = error.response?.data;
      const detail = raw
        ? typeof raw === "string"
          ? raw.slice(0, 500)
          : Buffer.from(raw as ArrayBuffer).toString("utf-8").slice(0, 500)
        : error.message;
      throw new Error(
        `Volcengine TTS failed (${error.response?.status ?? "no status"}): ${detail}`
      );
    }
    throw error;
  }
}
