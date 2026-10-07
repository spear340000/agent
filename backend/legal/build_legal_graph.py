"""Explicit command for building the embedded SQLite legal graph."""

from __future__ import annotations

import argparse
from dataclasses import asdict
import json
from pathlib import Path

from legal_graph import build_graph, graph_status


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the bounded SQLite legal graph")
    parser.add_argument("--laws", type=Path, default=Path("data/legal/full"))
    parser.add_argument("--precedents", type=Path, default=Path("data/legal/precedent"))
    parser.add_argument("--graph", type=Path, default=Path("data/legal_graph.sqlite3"))
    parser.add_argument("--batch-size", type=int, default=250)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args()
    if args.status:
        print(json.dumps(graph_status(args.graph), ensure_ascii=False, sort_keys=True))
        return 0
    result = build_graph(
        args.laws, args.precedents, args.graph, resume=args.resume, batch_size=args.batch_size
    )
    print(json.dumps(asdict(result), ensure_ascii=False, sort_keys=True))
    return 1 if result.errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
