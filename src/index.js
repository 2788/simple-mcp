import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const DEMO_TRACK = {
  title: "夜上海",
  audio_url: "http://music-storage.xrobo-io.qiniuapi.com/夜上海.mp3",
};

const transports = new Map();

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

const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/mcp", async (req, res) => {
  try {
    const transport = new SSEServerTransport("/mcp/message", res);
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);
    transport.onclose = () => {
      transports.delete(sessionId);
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
});

app.post("/mcp/message", async (req, res) => {
  const querySessionId = req.query.sessionId;
  const sessionId = Array.isArray(querySessionId)
    ? querySessionId[0]
    : querySessionId;

  let transport;
  if (typeof sessionId === "string" && sessionId) {
    transport = transports.get(sessionId);
  } else if (transports.size === 1) {
    transport = transports.values().next().value;
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
  console.log(`simple-mcp listening on http://0.0.0.0:${port}`);
  console.log("SSE: GET /mcp");
  console.log("Messages: POST /mcp/message");
});

async function shutdown() {
  for (const transport of transports.values()) {
    await transport.close().catch(() => {});
  }
  transports.clear();
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
