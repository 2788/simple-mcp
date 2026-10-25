import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * Server side of the MCP WebSocket transport used by
 * `@modelcontextprotocol/sdk/client/websocket.js`.
 * Each text frame is one JSON-RPC message. The subprotocol is `mcp`.
 */
export class WebSocketServerTransport {
  constructor(socket, request) {
    this.socket = socket;
    this.request = request;
    this.sessionId = randomUUID();
  }

  async start() {
    this.socket.on("message", (data) => {
      let message;
      try {
        message = JSONRPCMessageSchema.parse(JSON.parse(data.toString()));
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.onmessage?.(message, {
        requestInfo: {
          headers: this.request.headers,
          url: this.request.url,
        },
      });
    });

    this.socket.on("close", () => {
      this.onclose?.();
    });
    this.socket.on("error", (error) => {
      this.onerror?.(error);
    });
  }

  async send(message) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }
    this.socket.send(JSON.stringify(message));
  }

  async close() {
    this.socket.close();
  }
}
