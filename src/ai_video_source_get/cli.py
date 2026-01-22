from __future__ import annotations

import argparse

from . import __version__


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ai-video-source-get",
        description="AI 视频源获取（占位骨架）。",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=__version__,
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="占位参数：当前不执行真实抓取，只打印提示。",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.dry_run:
        print("dry-run: 当前版本仅为项目骨架，尚未实现抓取逻辑。")
        return 0

    parser.print_help()
    return 0

