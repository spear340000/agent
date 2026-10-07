"""Fetch project LFS assets and safely unpack the precedent corpus once."""

from __future__ import annotations

from pathlib import Path, PurePosixPath
import json
import os
import shutil
import subprocess
import uuid
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[2]
DATA = Path(__file__).resolve().parent / "data"
ARCHIVE = DATA / "legal-precedents.zip"
TARGET = DATA / "legal" / "precedent"
MARKER = TARGET / ".workfolio-bundle.json"
MAX_EXPANDED_BYTES = 3_000_000_000


def main() -> None:
    subprocess.run(
        ["git", "lfs", "pull", "--include=backend/legal/data/**"],
        cwd=ROOT,
        check=True,
    )
    if TARGET.exists() and not TARGET.is_dir():
        raise RuntimeError(f"Precedent data path is not a directory: {TARGET}")
    if not ARCHIVE.is_file():
        raise FileNotFoundError(f"Git LFS archive is missing: {ARCHIVE}")

    TARGET.mkdir(parents=True, exist_ok=True)
    extracted_files = 0
    extracted_bytes = 0
    if MARKER.is_file():
        try:
            manifest = json.loads(MARKER.read_text(encoding="utf-8"))
            if manifest.get("archive_bytes") == ARCHIVE.stat().st_size:
                print(f"Precedent bundle already provisioned at {TARGET}")
                return
        except (OSError, ValueError, TypeError):
            pass

    with ZipFile(ARCHIVE) as bundle:
        for item in bundle.infolist():
            relative = PurePosixPath(item.filename)
            if relative.is_absolute() or ".." in relative.parts or "\\" in item.filename:
                raise ValueError(f"Unsafe path in precedent archive: {item.filename!r}")
            if not relative.parts:
                continue
            if (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError(f"Symlinks are not allowed in precedent archive: {item.filename!r}")
            destination = TARGET.joinpath(*relative.parts).resolve()
            if not destination.is_relative_to(TARGET.resolve()):
                raise ValueError(f"Archive entry escapes extraction directory: {item.filename!r}")
            if item.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            extracted_bytes += item.file_size
            if extracted_bytes > MAX_EXPANDED_BYTES:
                raise ValueError("Precedent archive exceeds the 3 GB extraction limit")
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.is_file() and destination.stat().st_size == item.file_size:
                extracted_files += 1
                continue
            temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
            try:
                with bundle.open(item) as source, temporary.open("wb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                if temporary.stat().st_size != item.file_size:
                    raise IOError(f"Extracted file size mismatch: {item.filename!r}")
                os.replace(temporary, destination)
            finally:
                temporary.unlink(missing_ok=True)
            extracted_files += 1
    if extracted_files == 0:
        raise ValueError("Precedent archive contains no files")
    MARKER.write_text(
        json.dumps({"archive_bytes": ARCHIVE.stat().st_size, "files": extracted_files, "expanded_bytes": extracted_bytes}),
        encoding="utf-8",
    )

    print(f"Provisioned {extracted_files:,} precedent files ({extracted_bytes:,} bytes) at {TARGET}")


if __name__ == "__main__":
    main()
