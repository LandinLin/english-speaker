import axios from "axios";

const DASHSCOPE_ASR_URL =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

export async function transcribeAudio(audioFile: File): Promise<string> {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing DASHSCOPE_API_KEY environment variable");
  }

  const buffer = Buffer.from(await audioFile.arrayBuffer());
  const mimeType = audioFile.type || "audio/webm";
  const audioDataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;

  try {
    const response = await axios.post(
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
        timeout: 30_000,
      }
    );

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
    if (axios.isAxiosError(error)) {
      const detail =
        typeof error.response?.data === "object" && error.response?.data !== null
          ? JSON.stringify(error.response.data).slice(0, 500)
          : (error.response?.data ?? error.message);
      throw new Error(
        `DashScope ASR failed (${error.response?.status ?? "no status"}): ${detail}`
      );
    }
    throw error;
  }
}
