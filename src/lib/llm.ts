import OpenAI from "openai";
import {
  buildTutorMessages,
  type HistoryMessage,
} from "./prompts";

export interface TutorFeedback {
  reply: string;
  praise: string;
  correction: string;
  newWord: string;
}

function extractField(text: string, label: string): string {
  const match = text.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, "im"));
  return match ? match[1].trim() : "";
}

export function parseTutorResponse(text: string): TutorFeedback {
  const reply = extractField(text, "REPLY");

  if (reply) {
    return {
      reply,
      praise: extractField(text, "PRAISE") || "None",
      correction: extractField(text, "CORRECTION") || "None",
      newWord: extractField(text, "NEW_WORD") || "None",
    };
  }

  // Fallback: structured parsing failed — use the raw text as the reply.
  return {
    reply: text.trim(),
    praise: "None",
    correction: "None",
    newWord: "None",
  };
}

export async function getAIResponse(
  transcript: string,
  history: HistoryMessage[] = [],
  messages?: { role: "system" | "user" | "assistant"; content: string }[]
): Promise<TutorFeedback> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("Missing DEEPSEEK_API_KEY environment variable");
  }

  const client = new OpenAI({
    baseURL: "https://api.deepseek.com",
    apiKey,
  });

  const completion = await client.chat.completions.create({
    model: "deepseek-chat",
    messages: messages ?? buildTutorMessages(transcript, history),
    temperature: 0.7,
    max_tokens: 300,
  });

  const content = completion.choices[0]?.message?.content ?? "";
  return parseTutorResponse(content);
}
