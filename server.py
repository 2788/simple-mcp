import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated
from urllib.parse import quote

import uvicorn
from fastmcp import FastMCP
from fastmcp.server.dependencies import get_http_headers
from fastmcp.server.http import create_sse_app, create_streamable_http_app
from fastmcp.tools import ToolResult
from pydantic import Field
from starlette.applications import Starlette
from starlette.routing import Mount
from starlette.staticfiles import StaticFiles
from starlette.types import Receive, Scope, Send

TRACK_TITLE = "夜上海"
TRACK_URL = "http://music-storage.xrobo-io.qiniuapi.com/夜上海.mp3"
# 音频根地址。换成真实地址时只改这一行，结尾不要加斜杠。
AUDIO_BASE_URL = "https://qmall-static.qnssl.com/tmp"
SSE_PATH = "/mcp"
MESSAGE_PATH = "/mcp/message/"

GAME_NAME = "二哈有福"
SPEAK_DELAY_SECONDS = 3
# 选择目前只被记录，不会改变后续音频。
ROUNDS = (
    {
        "title": "第一回合",
        "audios": ("1.mp3", "2.mp3", "3.mp3", "4.mp3", "5.mp3"),
        "options": ("沉默不语", "忽略她，直接路过", "怼回去", "先道歉"),
    },
    {
        "title": "第二回合",
        "audios": ("6.mp3", "7.mp3", "8.mp3", "waigua.mp3", "9.mp3"),
        "options": ("立界，硬挡这一击", "借势，把礼堂的钟声引过来", "先道歉，记住这次屈辱"),
    },
    {
        "title": "第三回合",
        "audios": ("10.mp3", "11.mp3", "nanzhu-1.mp3"),
        "options": (),
    },
)

# 按会话保存进度。进程内有效，重启后清空。
_games: dict[str, dict] = {}

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("simple-mcp")

mcp = FastMCP("simple-mcp", version="1.0.0")

PLAY_FUNC_SCHEMA = {
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
}

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "code": {"type": "integer", "description": "0 表示成功"},
        "message": {"type": "string"},
        "funcs": {
            "type": "array",
            "description": "设备按顺序执行的系统调用",
            "items": PLAY_FUNC_SCHEMA,
        },
    },
    "required": ["code", "message", "funcs"],
}

GAME_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "code": {"type": "integer", "description": "0 表示成功"},
        "message": {"type": "string", "description": "给智能体的下一步说明"},
        "funcs": {
            "type": "array",
            "description": "设备按顺序执行的系统调用",
            "items": PLAY_FUNC_SCHEMA,
        },
        "round": {"type": "integer", "description": "当前回合，从 1 开始；还没开始时为 0"},
        "options": {
            "type": "array",
            "description": "播放结束后要原文展示给用户的选项；空数组表示本回合没有选项",
            "items": {"type": "string"},
        },
        "choices": {
            "type": "array",
            "description": "用户已经做出的选择编号，按回合顺序",
            "items": {"type": "integer"},
        },
        "awaiting_choice": {
            "type": "boolean",
            "description": "为 true 时要朗读选项并等待用户选择",
        },
        "finished": {"type": "boolean", "description": "为 true 时游戏已经结束"},
        "speak": {
            "type": "string",
            "description": "录音结束并静默 3 秒后，智能体要原文朗读的唯一一句；空字符串表示不要朗读",
        },
        "speak_delay_seconds": {
            "type": "integer",
            "description": "录音全部播放完后，朗读 speak 之前要静默的秒数",
        },
    },
    "required": [
        "code",
        "message",
        "funcs",
        "round",
        "options",
        "choices",
        "awaiting_choice",
        "finished",
        "speak",
        "speak_delay_seconds",
    ],
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


def _audio_url(filename: str) -> str:
    return f"{AUDIO_BASE_URL.rstrip('/')}/{quote(filename)}"


def _play_funcs(spec: dict) -> list[dict]:
    total = len(spec["audios"])
    funcs = []
    for index, filename in enumerate(spec["audios"], start=1):
        stem = filename.removesuffix(".mp3")
        funcs.append(
            {
                "name": "linx_play",
                "arguments": {
                    "audio_url": _audio_url(filename),
                    "title": f"{GAME_NAME} {spec['title']} {index}/{total} {stem}",
                },
            }
        )
    return funcs


_SPOKEN_NUMBERS = ("第一", "第二", "第三", "第四", "第五", "第六")


def _option_lines(options: tuple[str, ...]) -> str:
    return "\n".join(f"{index}. {text}" for index, text in enumerate(options, start=1))


def _speak_text(options: tuple[str, ...]) -> str:
    if not options:
        return ""
    parts = [f"{_SPOKEN_NUMBERS[index]}，{text}" for index, text in enumerate(options)]
    return "你可以选择：" + "。".join(parts) + "。"


def _round_message(round_no: int, choices: list[int]) -> str:
    spec = ROUNDS[round_no - 1]
    lines = [
        f"设备正在按 funcs 播放《{GAME_NAME}》{spec['title']}的录音。",
        "播放过程中不要说话，不要答应，不要解释，也不要复述剧情。",
    ]
    if choices:
        previous = ROUNDS[round_no - 2]
        picked = choices[-1]
        lines.append(
            f"上一回合已记录的选择是 {picked}. {previous['options'][picked - 1]}。这句话不要说给用户。"
        )
    if spec["options"]:
        lines.append(
            f"录音全部播放完后，先安静 {SPEAK_DELAY_SECONDS} 秒，然后只朗读 speak 原文，不要改字，不要加开场白。"
        )
        lines.append("朗读结束后立刻停止说话，等待用户自己选择。用户选定后，再调用 submit_dialogue_choice。")
    else:
        lines.append(
            f"录音全部播放完后，再安静 {SPEAK_DELAY_SECONDS} 秒。这一回合没有选项，speak 为空，不要朗读，也不要总结。"
        )
        lines.append(f"《{GAME_NAME}》到此结束。用户想再玩时，调用 start_dialogue_game。")
    return "\n".join(lines)


def _game_payload(
    *,
    code: int,
    message: str,
    round_no: int,
    options: tuple[str, ...] | list[str],
    choices: list[int],
    awaiting_choice: bool,
    finished: bool,
    speak: str,
    funcs: list[dict] | None = None,
) -> dict:
    return {
        "code": code,
        "message": message,
        "funcs": funcs or [],
        "round": round_no,
        "options": list(options),
        "choices": list(choices),
        "awaiting_choice": awaiting_choice,
        "finished": finished,
        "speak": speak,
        "speak_delay_seconds": SPEAK_DELAY_SECONDS,
    }


def _game_result(payload: dict, *, is_error: bool = False) -> ToolResult:
    return ToolResult(
        content=json.dumps(payload, ensure_ascii=False, indent=2),
        structured_content=payload,
        is_error=is_error,
    )


def _caller() -> tuple[dict, str]:
    headers = get_http_headers(include_all=True)
    session = headers.get("x-linx-session-id", "").strip()
    device = headers.get("x-linx-device-id", "").strip()
    return headers, session or device or "local"


def begin_dialogue(session_key: str) -> dict:
    _games[session_key] = {"round": 1, "choices": [], "finished": False}
    spec = ROUNDS[0]
    return _game_payload(
        code=0,
        message=_round_message(1, []),
        round_no=1,
        options=spec["options"],
        choices=[],
        awaiting_choice=True,
        finished=False,
        speak=_speak_text(spec["options"]),
        funcs=_play_funcs(spec),
    )


def record_dialogue_choice(session_key: str, choice: int) -> tuple[dict, bool]:
    game = _games.get(session_key)
    if game is None:
        payload = _game_payload(
            code=1,
            message=f"《{GAME_NAME}》还没开始。请先调用 start_dialogue_game。现在不要朗读选项。",
            round_no=0,
            options=(),
            choices=[],
            awaiting_choice=False,
            finished=False,
            speak="",
        )
        return payload, True

    if game["finished"]:
        payload = _game_payload(
            code=1,
            message=f"《{GAME_NAME}》已经结束。不要再朗读选项，也不要提交。用户如果想再玩一次，调用 start_dialogue_game。",
            round_no=game["round"],
            options=(),
            choices=game["choices"],
            awaiting_choice=False,
            finished=True,
            speak="",
        )
        return payload, True

    spec = ROUNDS[game["round"] - 1]
    option_count = len(spec["options"])
    if option_count == 0:
        game["finished"] = True
        payload = _game_payload(
            code=1,
            message=f"这一回合没有选项，《{GAME_NAME}》已经结束。不要朗读。用户如果想再玩一次，调用 start_dialogue_game。",
            round_no=game["round"],
            options=(),
            choices=game["choices"],
            awaiting_choice=False,
            finished=True,
            speak="",
        )
        return payload, True
    if choice < 1 or choice > option_count:
        payload = _game_payload(
            code=1,
            message=(
                f"选项编号无效。现在没有录音在播放，请直接朗读 speak 原文，"
                f"然后等待用户从 1 到 {option_count} 里重新选择：\n"
                f"{_option_lines(spec['options'])}"
            ),
            round_no=game["round"],
            options=spec["options"],
            choices=game["choices"],
            awaiting_choice=True,
            finished=False,
            speak=_speak_text(spec["options"]),
        )
        return payload, True

    game["choices"].append(choice)
    game["round"] += 1
    next_spec = ROUNDS[game["round"] - 1]
    game["finished"] = not next_spec["options"]
    payload = _game_payload(
        code=0,
        message=_round_message(game["round"], game["choices"]),
        round_no=game["round"],
        options=next_spec["options"],
        choices=game["choices"],
        awaiting_choice=not game["finished"],
        finished=game["finished"],
        speak=_speak_text(next_spec["options"]),
        funcs=_play_funcs(next_spec),
    )
    return payload, False


@mcp.tool(
    name="start_dialogue_game",
    title="开始《二哈有福》",
    description=(
        "开始或重新开始游戏《二哈有福》。游戏共三个回合，内容是预先录制的音频。"
        "调用后设备按 funcs 播放第一回合录音。"
        "播放过程中你必须保持沉默，不要输出任何对用户说的话。"
        "录音全部播放完后，先安静 3 秒，然后只朗读结果里的 speak 原文。"
        "朗读完就停下，等待用户自己选择。用户选择后才调用 submit_dialogue_choice。"
        "再次调用会从第一回合重新开始。"
    ),
    output_schema=GAME_OUTPUT_SCHEMA,
)
def start_dialogue_game() -> ToolResult:
    """开始或重新开始《二哈有福》，并播放第一回合。"""
    headers, session_key = _caller()
    logger.info(
        "start_dialogue_game device=%s agent=%s session=%s",
        headers.get("x-linx-device-id", ""),
        headers.get("x-linx-agent-id", ""),
        headers.get("x-linx-session-id", ""),
    )
    return _game_result(begin_dialogue(session_key))


@mcp.tool(
    name="submit_dialogue_choice",
    title="提交《二哈有福》的选项",
    description=(
        "提交用户在《二哈有福》当前回合选择的编号，并播放下一回合录音。"
        "choice 从 1 开始，对应当前选项顺序，必须是用户自己做出的选择。"
        "第一回合编号是 1 到 4，第二回合编号是 1 到 3。"
        "调用后设备按 funcs 播放录音。播放过程中你必须保持沉默，不要说话。"
        "录音全部播放完后，先安静 3 秒。若 speak 不为空，只朗读 speak 原文，然后等待用户选择。"
        "若 speak 为空，第三回合已经结束，不要朗读，也不要再次调用本工具。"
        "游戏还没开始时，先调用 start_dialogue_game。"
    ),
    output_schema=GAME_OUTPUT_SCHEMA,
)
def submit_dialogue_choice(
    choice: Annotated[
        int,
        Field(
            ge=1,
            le=4,
            description="用户选择的编号。第一回合为 1 到 4，第二回合为 1 到 3",
        ),
    ],
) -> ToolResult:
    """记录用户选择并播放下一回合。"""
    headers, session_key = _caller()
    logger.info(
        "submit_dialogue_choice choice=%s device=%s agent=%s session=%s",
        choice,
        headers.get("x-linx-device-id", ""),
        headers.get("x-linx-agent-id", ""),
        headers.get("x-linx-session-id", ""),
    )
    payload, is_error = record_dialogue_choice(session_key, choice)
    return _game_result(payload, is_error=is_error)


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
