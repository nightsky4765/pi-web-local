import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { PiAgentService } from "./agent.js";
import { publicDir, safePublicPath, workspace } from "./paths.js";
import { THINKING_LEVELS, type ChatRequest, type StreamEvent } from "./protocol.js";

const host = process.env.HOST || "127.0.0.1";
const port = parsePort(process.env.PORT || "4321");
const maxBodyBytes = 45 * 1024 * 1024;
const agent = await PiAgentService.create();

const server = createServer(async (request, response) => {
  try {
    if (!isLocalRequest(request)) return json(response, 403, { error: "只接受本機請求" });
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (request.method === "GET" && url.pathname === "/api/health") return json(response, 200, { ok: true });
    if (request.method === "GET" && url.pathname === "/api/status") return json(response, 200, agent.getStatus());
    if (request.method === "GET" && url.pathname === "/api/history") return json(response, 200, agent.getHistory());
    if (request.method === "GET" && url.pathname === "/api/models") return json(response, 200, await agent.getModels());

    if (request.method === "POST" && url.pathname === "/api/model") {
      const body = await readJson<{ provider?: string; id?: string }>(request);
      if (!body.provider || !body.id) throw new RequestError(400, "缺少模型資訊");
      await agent.setModel(body.provider, body.id);
      return json(response, 200, agent.getStatus());
    }

    if (request.method === "POST" && url.pathname === "/api/thinking") {
      const body = await readJson<{ level?: string }>(request);
      if (!body.level || !THINKING_LEVELS.includes(body.level as (typeof THINKING_LEVELS)[number])) {
        throw new RequestError(400, "不支援的思考等級");
      }
      agent.setThinking(body.level);
      return json(response, 200, agent.getStatus());
    }

    if (request.method === "POST" && url.pathname === "/api/abort") {
      await agent.abort();
      return json(response, 200, { ok: true });
    }

    if (request.method === "POST" && url.pathname === "/api/session/new") {
      await agent.newSession();
      return json(response, 200, agent.getStatus());
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      const body = await readJson<ChatRequest>(request);
      validateChatRequest(body);
      response.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      });
      const emit = (event: StreamEvent) => response.write(`${JSON.stringify(event)}\n`);
      try {
        await agent.chat(body, emit);
      } catch (error) {
        emit({ type: "error", message: publicError(error) });
      } finally {
        response.end();
      }
      return;
    }

    if (request.method === "GET") return serveStatic(url.pathname, response);
    return json(response, 404, { error: "找不到此 API" });
  } catch (error) {
    if (!(error instanceof RequestError)) console.error(error);
    if (!response.headersSent) json(response, error instanceof RequestError ? error.status : 500, { error: publicError(error) });
    else response.end();
  }
});

server.listen(port, host, () => {
  console.log(`Pi Web: http://${host}:${port}`);
  console.log(`Workspace: ${workspace}`);
  console.log(`Static files: ${publicDir}`);
});

function isLocalRequest(request: IncomingMessage): boolean {
  const remote = request.socket.remoteAddress || "";
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const type = request.headers["content-type"] || "";
  if (!type.toLowerCase().startsWith("application/json")) throw new RequestError(415, "必須使用 application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new RequestError(413, "請求內容過大");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new RequestError(400, "JSON 格式錯誤");
  }
}

function validateChatRequest(value: ChatRequest): void {
  if (!value || typeof value !== "object" || typeof value.text !== "string") throw new RequestError(400, "訊息格式錯誤");
  if (value.text.length > 100_000) throw new RequestError(400, "文字訊息過長");
  if (value.images !== undefined && !Array.isArray(value.images)) throw new RequestError(400, "圖片格式錯誤");
  for (const image of value.images || []) {
    if (!image || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mediaType)) throw new RequestError(400, "不支援的圖片格式");
    if (typeof image.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new RequestError(400, "圖片資料錯誤");
  }
}

function serveStatic(urlPath: string, response: ServerResponse): void {
  const filePath = safePublicPath(urlPath);
  if (!filePath) return json(response, 403, { error: "禁止的路徑" });
  try {
    if (!statSync(filePath).isFile()) throw new Error();
  } catch {
    return json(response, 404, { error: "找不到檔案" });
  }
  response.writeHead(200, {
    "Content-Type": mimeType(path.extname(filePath)),
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  createReadStream(filePath).pipe(response);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(value));
}

function mimeType(extension: string): string {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" } as Record<string, string>)[extension] || "application/octet-stream";
}

function publicError(error: unknown): string {
  return error instanceof Error ? error.message : "發生未知錯誤";
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`無效的 PORT：${value}`);
  return parsed;
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    agent.dispose();
    server.close(() => process.exit(0));
  });
}
