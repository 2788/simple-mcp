# simple-mcp

灵矽云端 MCP 服务，只提供一个工具：播放音乐。

协议为 JSON-RPC 2.0。播放音乐的返回格式与[系统调用响应格式](https://linx.qiniu.com/docs/xrobot/mcp/software-mcp)一致。三种传输共用同一个工具：

- HTTP + SSE：`GET /mcp` 建立长连接，`POST /mcp/message` 发送请求。这是灵矽当前使用的接法。
- Streamable HTTP：`POST /mcp` 发送请求，响应是 JSON 或 SSE；会话放在 `Mcp-Session-Id`。`GET /mcp` 带同一个请求头时打开服务端通知流，`DELETE /mcp` 结束会话。不带会话头的 `GET /mcp` 仍是上面的旧版 SSE。
- WebSocket：`/mcp/ws`，子协议 `mcp`，每个文本帧是一条 JSON-RPC 消息。

HTTP 层用 Express，SSE 和 Streamable HTTP 用 `@modelcontextprotocol/sdk` 的传输实现。SDK 没有 WebSocket 服务端，因此服务端按它的客户端协议补了一层。

`play_music` 成功时同时返回：

- `content[0].text`：格式化后的 JSON 字符串
- `structuredContent`：设备执行的系统调用，函数名为 `linx_play`，参数为 `audio_url` 和 `title`

未传歌曲名或音频地址时，播放示例歌曲「夜上海」。

## 运行

```bash
npm install
npm start
```

默认监听 `3000`，可用 `PORT` 修改。打开 [http://127.0.0.1:3000](http://127.0.0.1:3000) 可在页面里切换三种传输、查看 `tools/list` 并调用工具。

在灵矽 AI 平台登记 SSE URL：`https://<你的域名>/mcp`。平台会自动带上 `X-Linx-Device-Id`、`X-Linx-Agent-Id`、`X-Linx-Session-Id`，这些值来自请求头，不会进入工具参数。
