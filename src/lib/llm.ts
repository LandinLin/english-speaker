import OpenAI from "openai";
import {
  buildTutorMessages,
  type HistoryMessage,
} from "./prompts";
import { parseTutorResponse, type TutorFeedback } from "./feedbackParser";

export type { TutorFeedback };

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
