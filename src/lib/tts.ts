import axios from "axios";

const TTS_URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const appId = process.env.VOLCENGINE_TTS_APP_ID;
  const accessKey = process.env.VOLCENGINE_TTS_ACCESS_TOKEN;
  if (!appId || !accessKey) {
    throw new Error(
      "Missing VOLCENGINE_TTS_APP_ID or VOLCENGINE_TTS_ACCESS_TOKEN environment variable"
    );
  }

  try {
    const response = await axios.post(
      TTS_URL,
      {
        user: { uid: "english-buddy" },
        req_params: {
          text,
          speaker: "en_female_anna_uranus_bigtts",
          audio_params: {
            format: "mp3",
            sample_rate: 24000,
          },
        },
      },
      {
        responseType: "arraybuffer",
        headers: {
          "Content-Type": "application/json",
          "X-Api-App-Id": appId,
          "X-Api-Access-Key": accessKey,
          "X-Api-Resource-Id": "volc.service_type.10029",
        },
        timeout: 30_000,
      }
    );

    return Buffer.from(response.data as ArrayBuffer);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const raw = error.response?.data;
      const detail = raw
        ? Buffer.from(raw as ArrayBuffer).toString("utf-8").slice(0, 500)
        : error.message;
      throw new Error(
        `Volcengine TTS failed (${error.response?.status ?? "no status"}): ${detail}`
      );
    }
    throw error;
  }
}
