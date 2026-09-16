import axios, { type AxiosError } from "axios";

const DASHSCOPE_ASR_URL =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

// Generous timeout: the request body is a base64 audio blob, so a slow
// uplink alone can eat tens of seconds before the service even answers.
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_500;

function formatAxiosError(error: AxiosError): Error {
  const detail =
    typeof error.response?.data === "object" && error.response?.data !== null
      ? JSON.stringify(error.response.data).slice(0, 500)
      : (error.response?.data ?? error.message);
  return new Error(
    `DashScope ASR failed (${error.response?.status ?? "no status"}): ${detail}`
  );
}

export async function transcribeAudio(audioFile: File): Promise<string> {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing DASHSCOPE_API_KEY environment variable");
  }

  const buffer = Buffer.from(await audioFile.arrayBuffer());
  const mimeType = audioFile.type || "audio/webm";
  const audioDataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
  console.log(
    `🎙️ [asr] Transcribing ${(buffer.length / 1024).toFixed(0)} KB of ${mimeType}`
  );

  const postOnce = () =>
    axios.post(
      DASHSCOPE_ASR_URL,
      {
        model: "qwen3-asr-flash",
        input: {
          messages: [
            {
              role: "user",
              content: [{ audio: audioDataUrl }],
            },
          ],
        },
        // English tutor: hint the language to improve recognition accuracy
        parameters: {
          asr_options: {
            language: "en",
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );

  // Transcription is idempotent, so network-level failures (timeout, dropped
  // connection) and DashScope 5xx bursts are safe to retry once. API errors
  // (4xx) and empty results are not — they fail immediately.
  let lastAxiosError: AxiosError | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await postOnce();

      const content = response.data?.output?.choices?.[0]?.message?.content;
      let transcript = "";

      if (typeof content === "string") {
        transcript = content;
      } else if (Array.isArray(content)) {
        transcript = content
          .map((part: { text?: string }) => part?.text ?? "")
          .join(" ");
      } else if (content?.text) {
        transcript = String(content.text);
      }

      transcript = transcript.trim();
      if (!transcript) {
        throw new Error("Empty transcript returned by ASR service");
      }
      return transcript;
    } catch (error) {
      if (!axios.isAxiosError(error)) throw error;
      lastAxiosError = error;
      const retryable = !error.response || error.response.status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      console.warn(
        `⚠️ [asr] Attempt ${attempt} failed (${error.code ?? error.message}); retrying…`
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  throw lastAxiosError ? formatAxiosError(lastAxiosError) : new Error("ASR failed");
}
