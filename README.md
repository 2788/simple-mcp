# simple-mcp

灵矽云端 MCP 服务。用 Python 3 和 [FastMCP](https://gofastmcp.com) 实现。提供播放音乐，以及一个三回合的对话选择游戏。

协议为 JSON-RPC 2.0。两种传输共用同一个工具，也共用 `/mcp`：

- HTTP + SSE：不带 `Mcp-Session-Id` 的 `GET /mcp` 建立长连接，`POST /mcp/message/` 发送请求。消息地址以 SSE 的 `endpoint` 事件为准，里面带 `session_id`。这是灵矽当前使用的接法。
- Streamable HTTP：`POST /mcp` 发送请求，响应是 JSON 或 SSE；会话放在 `Mcp-Session-Id`。`GET /mcp` 带同一个请求头时打开服务端通知流，`DELETE /mcp` 结束会话。

`play_music` 没有参数，固定播放「夜上海」：

`http://music-storage.xrobo-io.qiniuapi.com/夜上海.mp3`

成功时同时返回：

- `content[0].text`：格式化后的 JSON 字符串
- `structuredContent`：设备执行的系统调用，函数名为 `linx_play`，参数为 `audio_url` 和 `title`

返回格式与[系统调用响应格式](https://linx.qiniu.com/docs/xrobot/mcp/software-mcp)一致。

## 对话选择游戏

游戏共三个回合。每一回合由设备按顺序播放预先录制的音频。第一回合播放结束后展示四个选项，第二回合展示三个选项。第三回合只有音频，播放完即结束。

音频地址由 `AUDIO_BASE_URL` 拼接文件名，当前是 `https://static.sufy.com/tmp`。换成其他目录时只改 `server.py` 里的这一行。选择会被记录，但不会改变后续播放的音频。

工具：

- `start_dialogue_game`：开始或重新开始，播放第一回合的 `1.mp3` 到 `5.mp3`，并返回四个选项：沉默不语、忽略她，直接路过、怼回去、先道歉。
- `submit_dialogue_choice`：参数 `choice` 对应当前回合的选项编号。第一回合为 1 到 4；提交后进入第二回合，播放 `6.mp3`、`7.mp3`、`8.mp3`、`waigua.mp3`、`9.mp3`，选项为立界，硬挡这一击、借势，把礼堂的钟声引过来、先道歉，记住这次屈辱。第二回合为 1 到 3；提交后进入第三回合，播放 `10.mp3`、`11.mp3`、`nanzhu-1.mp3`。

进度按 `X-Linx-Session-Id` 保存在当前进程内存里。没有会话 ID 时改用设备 ID。重启服务会清空进度。

## 运行

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

默认监听 `3000`，可用 `PORT` 修改。打开 [http://127.0.0.1:3000](http://127.0.0.1:3000) 可查看 `tools/list` 并调用工具。

在灵矽 AI 平台登记 SSE URL：`https://<你的域名>/mcp`。平台会自动带上 `X-Linx-Device-Id`、`X-Linx-Agent-Id`、`X-Linx-Session-Id`，这些值来自请求头，不会进入工具参数。
