export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export interface ImageInput {
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
  name?: string;
}

export interface ChatRequest {
  text: string;
  images?: ImageInput[];
}

export type StreamEvent =
  | { type: "start" }
  | { type: "assistant-start" }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool-start"; id: string; name: string; args: unknown }
  | { type: "tool-end"; id: string; name: string; error: boolean }
  | { type: "done" }
  | { type: "aborted" }
  | { type: "error"; message: string };

export interface HistoryMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  images?: number;
}
