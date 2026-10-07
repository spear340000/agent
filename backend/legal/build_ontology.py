import argparse
from pathlib import Path

from legal_ontology import write_outputs


def main():
    parser = argparse.ArgumentParser(description="Build ontology from legal Wiki Markdown")
    parser.add_argument("--wiki", type=Path, default=Path("wiki"))
    parser.add_argument("--ttl", type=Path, default=Path("ontology/legal-wiki.ttl"))
    parser.add_argument("--json", type=Path, default=Path("ontology/legal-wiki.json"))
    args = parser.parse_args()
    stats = write_outputs(args.wiki, args.ttl, args.json)
    print(" ".join(f"{key}={value}" for key, value in sorted(stats.items())))


if __name__ == "__main__":
    main()
