import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { WebSocketServerTransport } from "./websocket-transport.js";

const DEMO_TRACK = {
  title: "夜上海",
  audio_url: "http://music-storage.xrobo-io.qiniuapi.com/夜上海.mp3",
};

const sseSessions = new Map();
const streamableSessions = new Map();
const webSockets = new Set();

function header(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function createServer() {
  const server = new McpServer({
    name: "simple-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "play_music",
    {
      title: "播放音乐",
      description:
        "播放一首音乐。结果会驱动设备执行系统调用 linx_play。未传歌曲名或音频地址时，播放示例歌曲「夜上海」。",
      inputSchema: {
        title: z.string().trim().min(1).describe("歌曲名称").optional(),
        audio_url: z
          .string()
          .trim()
          .describe("可访问的音频地址，例如 mp3 URL")
          .optional(),
      },
      outputSchema: {
        code: z.number().describe("0 表示成功"),
        message: z.string(),
        funcs: z
          .array(
            z.object({
              name: z.string().describe("系统函数名，播放时为 linx_play"),
              arguments: z.object({
                audio_url: z.string(),
                title: z.string(),
              }),
            }),
          )
          .describe("设备按顺序执行的系统调用"),
      },
    },
    async ({ title, audio_url } = {}, extra) => {
      const headers = extra?.requestInfo?.headers ?? {};
      const track = {
        audio_url: audio_url || DEMO_TRACK.audio_url,
        title: title || DEMO_TRACK.title,
      };

      console.log(
        "play_music device=%s agent=%s session=%s title=%s",
        headers["x-linx-device-id"] ?? "",
        headers["x-linx-agent-id"] ?? "",
        headers["x-linx-session-id"] ?? "",
        track.title,
      );

      const payload = {
        code: 0,
        funcs: [
          {
            name: "linx_play",
            arguments: track,
          },
        ],
        message: "",
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
        structuredContent: payload,
        isError: false,
      };
    },
  );

  return server;
}

const publicDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../public",
);

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.static(publicDir));

function isInitializeRequest(body) {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((message) => message?.method === "initialize");
}

function sessionHeader(req) {
  const value = header(req, "mcp-session-id");
  return typeof value === "string" && value ? value : "";
}

async function openLegacySse(req, res) {
  try {
    const transport = new SSEServerTransport("/mcp/message", res);
    const sessionId = transport.sessionId;
    sseSessions.set(sessionId, transport);
    transport.onclose = () => {
      sseSessions.delete(sessionId);
    };

    console.log(
      "sse connected session=%s device=%s agent=%s linxSession=%s",
      sessionId,
      header(req, "x-linx-device-id") ?? "",
      header(req, "x-linx-agent-id") ?? "",
      header(req, "x-linx-session-id") ?? "",
    );

    const server = createServer();
    await server.connect(transport);
  } catch (error) {
    console.error("failed to open sse", error);
    if (!res.headersSent) {
      res.status(500).send("Error establishing SSE stream");
    }
  }
}

async function handleStreamable(req, res) {
  const sessionId = sessionHeader(req);
  try {
    if (sessionId) {
      const transport = streamableSessions.get(sessionId);
      if (!transport) {
        res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null,
        });
        return;
      }
      await transport.handleRequest(req, res, req.method === "POST" ? req.body : undefined);
      return;
    }

    if (req.method === "POST" && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized(id) {
          streamableSessions.set(id, transport);
          console.log(
            "streamable session=%s device=%s agent=%s linxSession=%s",
            id,
            header(req, "x-linx-device-id") ?? "",
            header(req, "x-linx-agent-id") ?? "",
            header(req, "x-linx-session-id") ?? "",
          );
        },
        onsessionclosed(id) {
          streamableSessions.delete(id);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) streamableSessions.delete(transport.sessionId);
      };
      const server = createServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: Mcp-Session-Id header is required" },
      id: null,
    });
  } catch (error) {
    console.error("failed to handle streamable http", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error" },
        id: null,
      });
    }
  }
}

app.get("/mcp", async (req, res) => {
  if (sessionHeader(req)) {
    await handleStreamable(req, res);
    return;
  }
  await openLegacySse(req, res);
});

app.post("/mcp", handleStreamable);
app.delete("/mcp", handleStreamable);

app.post("/mcp/message", async (req, res) => {
  const querySessionId = req.query.sessionId;
  const sessionId = Array.isArray(querySessionId)
    ? querySessionId[0]
    : querySessionId;

  let transport;
  if (typeof sessionId === "string" && sessionId) {
    transport = sseSessions.get(sessionId);
  } else if (sseSessions.size === 1) {
    transport = sseSessions.values().next().value;
  }

  if (!transport) {
    res.status(sessionId ? 404 : 400).send(
      sessionId ? "Session not found" : "Missing sessionId parameter",
    );
    return;
  }

  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    console.error("failed to handle message", error);
    if (!res.headersSent) {
      res.status(500).send("Error handling request");
    }
  }
});

const port = Number(process.env.PORT) || 3000;
const httpServer = app.listen(port, "0.0.0.0", () => {
  console.log(`simple-mcp listening on http://127.0.0.1:${port}`);
  console.log("UI: GET /");
  console.log("SSE: GET /mcp");
  console.log("SSE messages: POST /mcp/message");
  console.log("Streamable HTTP: POST/GET/DELETE /mcp");
  console.log("WebSocket: /mcp/ws");
});

const webSocketServer = new WebSocketServer({
  noServer: true,
  handleProtocols(protocols) {
    return protocols.has("mcp") ? "mcp" : false;
  },
});

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/mcp/ws") {
    socket.destroy();
    return;
  }
  // Browsers cannot set custom headers on a WebSocket. The test page sends
  // the same Linx ids as query parameters; a native client can still use headers.
  const forwarded = {
    "x-linx-device-id": "deviceId",
    "x-linx-agent-id": "agentId",
    "x-linx-session-id": "sessionId",
  };
  for (const [name, query] of Object.entries(forwarded)) {
    const value = url.searchParams.get(query);
    if (!req.headers[name] && value) req.headers[name] = value;
  }
  webSocketServer.handleUpgrade(req, socket, head, (ws) => {
    webSocketServer.emit("connection", ws, req);
  });
});

webSocketServer.on("connection", async (socket, req) => {
  const transport = new WebSocketServerTransport(socket, req);
  webSockets.add(socket);
  socket.on("close", () => {
    webSockets.delete(socket);
  });
  try {
    console.log(
      "websocket connected session=%s device=%s agent=%s linxSession=%s",
      transport.sessionId,
      header(req, "x-linx-device-id") ?? "",
      header(req, "x-linx-agent-id") ?? "",
      header(req, "x-linx-session-id") ?? "",
    );
    const server = createServer();
    await server.connect(transport);
  } catch (error) {
    console.error("failed to open websocket", error);
    socket.close();
  }
});

async function shutdown() {
  for (const transport of sseSessions.values()) {
    await transport.close().catch(() => {});
  }
  sseSessions.clear();
  for (const transport of streamableSessions.values()) {
    await transport.close().catch(() => {});
  }
  streamableSessions.clear();
  for (const socket of webSockets) socket.close();
  webSockets.clear();
  webSocketServer.close();
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
