# simple-mcp

灵矽云端 MCP 服务，只提供一个工具：播放音乐。

协议为 JSON-RPC 2.0 over SSE，端点与[系统调用响应格式](https://linx.qiniu.com/docs/xrobot/mcp/software-mcp)一致：

- `GET /mcp`：SSE 长连接
- `POST /mcp/message`：接收 MCP 请求（标准客户端会带上 `sessionId`）

`play_music` 成功时同时返回：

- `content[0].text`：格式化后的 JSON 字符串
- `structuredContent`：设备执行的系统调用，函数名为 `linx_play`，参数为 `audio_url` 和 `title`

未传歌曲名或音频地址时，播放示例歌曲「夜上海」。

## 运行

```bash
npm install
npm start
```

默认监听 `3000`，可用 `PORT` 修改。

在灵矽 AI 平台登记 SSE URL：`https://<你的域名>/mcp`。平台会自动带上 `X-Linx-Device-Id`、`X-Linx-Agent-Id`、`X-Linx-Session-Id`，这些值来自请求头，不会进入工具参数。
