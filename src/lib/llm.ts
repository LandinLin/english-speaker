import OpenAI from "openai";
import {
  accentSystemMessage,
  buildTutorMessages,
  type HistoryMessage,
} from "./prompts";
import { parseTutorResponse, type TutorFeedback } from "./feedbackParser";

export type { TutorFeedback };

type ChatMessageParam = {
  role: "system" | "user" | "assistant";
  content: string;
};

export async function getAIResponse(
  transcript: string,
  history: HistoryMessage[] = [],
  messages?: ChatMessageParam[],
  accent?: string | null
): Promise<TutorFeedback> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("Missing DEEPSEEK_API_KEY environment variable");
  }

  const client = new OpenAI({
    baseURL: "https://api.deepseek.com",
    apiKey,
  });

  const baseMessages = messages ?? buildTutorMessages(transcript, history);
  // Insert the accent style guide after the leading system prompt(s) so it
  // applies in both free chat and lesson mode.
  const accentMsg = accentSystemMessage(accent);
  const finalMessages: ChatMessageParam[] = accentMsg
    ? (() => {
        let i = 0;
        while (i < baseMessages.length && baseMessages[i].role === "system") {
          i += 1;
        }
        return [...baseMessages.slice(0, i), accentMsg, ...baseMessages.slice(i)];
      })()
    : baseMessages;

  const completion = await client.chat.completions.create({
    model: "deepseek-chat",
    messages: finalMessages,
    temperature: 0.7,
    max_tokens: 300,
  });

  const content = completion.choices[0]?.message?.content ?? "";
  return parseTutorResponse(content);
}
