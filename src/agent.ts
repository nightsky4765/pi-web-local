import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type ChatRequest, type HistoryMessage, type StreamEvent, type ThinkingLevelName } from "./protocol.js";
import { workspace } from "./paths.js";

type Emit = (event: StreamEvent) => void;

export class PiAgentService {
  private readonly modelRuntime: ModelRuntime;
  private session!: AgentSession;

  private constructor(modelRuntime: ModelRuntime) {
    this.modelRuntime = modelRuntime;
  }

  static async create(): Promise<PiAgentService> {
    const runtime = await ModelRuntime.create();
    const service = new PiAgentService(runtime);
    await service.openRecentSession();
    return service;
  }

  private async openRecentSession(): Promise<void> {
    const result = await createAgentSession({
      cwd: workspace,
      modelRuntime: this.modelRuntime,
      tools: ["read", "grep", "find", "ls"],
      sessionManager: SessionManager.continueRecent(workspace),
    });
    this.session = result.session;
  }

  async newSession(): Promise<void> {
    if (this.session.isStreaming) throw new Error("模型仍在回覆中");
    this.session.dispose();
    const result = await createAgentSession({
      cwd: workspace,
      modelRuntime: this.modelRuntime,
      tools: ["read", "grep", "find", "ls"],
      sessionManager: SessionManager.create(workspace),
    });
    this.session = result.session;
  }

  getStatus() {
    const model = this.session.model;
    return {
      model: model
        ? { provider: model.provider, id: model.id, name: model.name, supportsImages: model.input.includes("image") }
        : null,
      thinkingLevel: this.session.thinkingLevel,
      streaming: this.session.isStreaming,
      sessionId: this.session.sessionId,
      workspace,
      tools: this.session.agent.state.tools.map((tool) => tool.name),
    };
  }

  getHistory(): HistoryMessage[] {
    const output: HistoryMessage[] = [];
    for (const raw of this.session.messages as unknown[]) {
      const message = raw as { role?: string; content?: unknown };
      if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") continue;
      const { text, images } = extractContent(message.content);
      if (!text && !images) continue;
      output.push({ role: message.role === "toolResult" ? "tool" : message.role, text, ...(images ? { images } : {}) });
    }
    return output;
  }

  async getModels() {
    const models = await this.modelRuntime.getAvailable();
    return models
      .map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        supportsImages: model.input.includes("image"),
        reasoning: model.reasoning,
        contextWindow: model.contextWindow,
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
  }

  async setModel(provider: string, id: string): Promise<void> {
    if (this.session.isStreaming) throw new Error("模型仍在回覆中");
    const models = await this.modelRuntime.getAvailable(provider);
    const model = models.find((candidate) => candidate.id === id);
    if (!model) throw new Error("找不到可用的模型");
    await this.session.setModel(model);
  }

  setThinking(level: string): void {
    if (!THINKING_LEVELS.includes(level as ThinkingLevelName)) throw new Error("不支援的思考等級");
    this.session.setThinkingLevel(level as ThinkingLevelName);
  }

  async abort(): Promise<void> {
    if (this.session.isStreaming) await this.session.abort();
  }

  async chat(request: ChatRequest, emit: Emit): Promise<void> {
    if (this.session.isStreaming) throw new Error("已有一個回覆正在進行");
    const images = request.images ?? [];
    if (images.length > 5) throw new Error("一次最多附加 5 張圖片");
    if (!request.text.trim() && images.length === 0) throw new Error("請輸入訊息或附加圖片");
    if (images.length && !this.session.model?.input.includes("image")) throw new Error("目前模型不支援圖片");

    for (const image of images) {
      if (Buffer.byteLength(image.data, "base64") > 8 * 1024 * 1024) throw new Error(`${image.name ?? "圖片"} 超過 8 MB`);
    }

    const unsubscribe = this.session.subscribe((event) => {
      if (event.type === "message_update") {
        if (event.assistantMessageEvent.type === "text_delta") emit({ type: "text", delta: event.assistantMessageEvent.delta });
        if (event.assistantMessageEvent.type === "thinking_delta") emit({ type: "thinking", delta: event.assistantMessageEvent.delta });
      } else if (event.type === "tool_execution_start") {
        emit({ type: "tool-start", id: event.toolCallId, name: event.toolName, args: event.args });
      } else if (event.type === "tool_execution_end") {
        emit({ type: "tool-end", id: event.toolCallId, name: event.toolName, error: event.isError });
      }
    });

    emit({ type: "start" });
    try {
      await this.session.prompt(request.text.trim() || "請分析附加的圖片。", {
        images: images.map((image) => ({
          type: "image" as const,
          data: image.data,
          mimeType: image.mediaType,
        })),
      });
      emit({ type: "done" });
    } catch (error) {
      if (isAbortError(error)) emit({ type: "aborted" });
      else throw error;
    } finally {
      unsubscribe();
    }
  }

  dispose(): void {
    this.session.dispose();
  }
}

function extractContent(content: unknown): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: "", images: 0 };
  const texts: string[] = [];
  let images = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const item = part as { type?: string; text?: string; name?: string };
    if ((item.type === "text" || item.type === "thinking") && item.text) texts.push(item.text);
    if (item.type === "image") images += 1;
  }
  return { text: texts.join("\n"), images };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
}
