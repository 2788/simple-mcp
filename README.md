# simple-mcp

灵矽云端 MCP 服务，只提供一个工具：播放音乐。用 Python 3 和 [FastMCP](https://gofastmcp.com) 实现。

协议为 JSON-RPC 2.0。两种传输共用同一个工具，也共用 `/mcp`：

- HTTP + SSE：不带 `Mcp-Session-Id` 的 `GET /mcp` 建立长连接，`POST /mcp/message/` 发送请求。消息地址以 SSE 的 `endpoint` 事件为准，里面带 `session_id`。这是灵矽当前使用的接法。
- Streamable HTTP：`POST /mcp` 发送请求，响应是 JSON 或 SSE；会话放在 `Mcp-Session-Id`。`GET /mcp` 带同一个请求头时打开服务端通知流，`DELETE /mcp` 结束会话。

`play_music` 没有参数，固定播放「夜上海」：

`http://music-storage.xrobo-io.qiniuapi.com/夜上海.mp3`

成功时同时返回：

- `content[0].text`：格式化后的 JSON 字符串
- `structuredContent`：设备执行的系统调用，函数名为 `linx_play`，参数为 `audio_url` 和 `title`

返回格式与[系统调用响应格式](https://linx.qiniu.com/docs/xrobot/mcp/software-mcp)一致。

## 运行

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

默认监听 `3000`，可用 `PORT` 修改。打开 [http://127.0.0.1:3000](http://127.0.0.1:3000) 可查看 `tools/list` 并调用工具。

在灵矽 AI 平台登记 SSE URL：`https://<你的域名>/mcp`。平台会自动带上 `X-Linx-Device-Id`、`X-Linx-Agent-Id`、`X-Linx-Session-Id`，这些值来自请求头，不会进入工具参数。
