import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastmcp import FastMCP
from fastmcp.server.dependencies import get_http_headers
from fastmcp.server.http import create_sse_app, create_streamable_http_app
from fastmcp.tools import ToolResult
from starlette.applications import Starlette
from starlette.routing import Mount
from starlette.staticfiles import StaticFiles
from starlette.types import Receive, Scope, Send

TRACK_TITLE = "夜上海"
TRACK_URL = "http://music-storage.xrobo-io.qiniuapi.com/夜上海.mp3"
SSE_PATH = "/mcp"
MESSAGE_PATH = "/mcp/message/"

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("simple-mcp")

mcp = FastMCP("simple-mcp", version="1.0.0")

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "code": {"type": "integer", "description": "0 表示成功"},
        "message": {"type": "string"},
        "funcs": {
            "type": "array",
            "description": "设备按顺序执行的系统调用",
            "items": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "系统函数名，播放时为 linx_play",
                    },
                    "arguments": {
                        "type": "object",
                        "properties": {
                            "audio_url": {"type": "string"},
                            "title": {"type": "string"},
                        },
                        "required": ["audio_url", "title"],
                    },
                },
                "required": ["name", "arguments"],
            },
        },
    },
    "required": ["code", "message", "funcs"],
}


@mcp.tool(
    name="play_music",
    title="播放音乐",
    description=(
        "播放固定歌曲「夜上海」。"
        f"音频地址固定为 {TRACK_URL}。"
        "结果会驱动设备执行系统调用 linx_play。"
    ),
    output_schema=OUTPUT_SCHEMA,
)
def play_music() -> ToolResult:
    """播放固定歌曲「夜上海」。"""
    headers = get_http_headers(include_all=True)
    logger.info(
        "play_music device=%s agent=%s session=%s",
        headers.get("x-linx-device-id", ""),
        headers.get("x-linx-agent-id", ""),
        headers.get("x-linx-session-id", ""),
    )
    payload = {
        "code": 0,
        "funcs": [
            {
                "name": "linx_play",
                "arguments": {
                    "audio_url": TRACK_URL,
                    "title": TRACK_TITLE,
                },
            }
        ],
        "message": "",
    }
    return ToolResult(
        content=json.dumps(payload, ensure_ascii=False, indent=2),
        structured_content=payload,
    )


def _session_id(scope: Scope) -> str:
    for name, value in scope.get("headers", []):
        if name.lower() == b"mcp-session-id" and value:
            return value.decode()
    return ""


class CombinedMCPApp:
    """SSE 和 Streamable HTTP 共用 /mcp。

    不带 Mcp-Session-Id 的 GET /mcp 是灵矽使用的旧版 SSE。
    POST /mcp、DELETE /mcp，以及带会话头的 GET /mcp 走 Streamable HTTP。
    """

    def __init__(self, sse_app: Starlette, http_app: Starlette) -> None:
        self.sse_app = sse_app
        self.http_app = http_app

        @asynccontextmanager
        async def lifespan(_app: Starlette):
            async with sse_app.router.lifespan_context(sse_app):
                async with http_app.router.lifespan_context(http_app):
                    yield

        self._lifespan_app = Starlette(lifespan=lifespan)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            await self._lifespan_app(scope, receive, send)
            return
        await self._target(scope)(scope, receive, send)

    def _target(self, scope: Scope):
        if scope["type"] != "http":
            return self.sse_app
        path = scope.get("path", "")
        if path == MESSAGE_PATH.rstrip("/") or path.startswith(MESSAGE_PATH):
            return self.sse_app
        if path.rstrip("/") == SSE_PATH:
            method = scope.get("method", "GET")
            if method == "GET" and not _session_id(scope):
                return self.sse_app
            return self.http_app
        return self.sse_app


def create_app() -> CombinedMCPApp:
    public_dir = Path(__file__).resolve().parent / "public"
    sse_app = create_sse_app(
        server=mcp,
        message_path=MESSAGE_PATH,
        sse_path=SSE_PATH,
        routes=[Mount("/", app=StaticFiles(directory=public_dir, html=True))],
    )
    http_app = create_streamable_http_app(
        server=mcp,
        streamable_http_path=SSE_PATH,
    )
    return CombinedMCPApp(sse_app, http_app)


app = create_app()


def main() -> None:
    port = int(os.environ.get("PORT", "3000"))
    logger.info("simple-mcp listening on http://127.0.0.1:%s", port)
    logger.info("UI: GET /")
    logger.info("SSE: GET %s", SSE_PATH)
    logger.info("SSE messages: POST %s", MESSAGE_PATH)
    logger.info("Streamable HTTP: POST/GET/DELETE %s", SSE_PATH)
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")


if __name__ == "__main__":
    main()
