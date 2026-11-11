#!/usr/bin/env python3
"""Verify catalog architecture metadata against GGUF headers."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import struct
import sys
import time
from typing import Any, Callable, TextIO

import requests

from build_catalog import CatalogBuildError, CATALOG_PATH, ROOT, validate_catalog
from gguf_probe import Truncated, facts

CACHE_PATH = ROOT / "tools" / "catalog" / ".cache"
FACT_FIELDS = ("arch", "layers", "kv_heads", "head_dim", "context_length")
ARCH_FIELDS = (
    ("layers", "layers"),
    ("kv_heads", "kv_heads"),
    ("head_dim", "head_dim"),
    ("context_length", "context_max"),
)


class CatalogVerificationError(ValueError):
    """Raised when a catalog cannot be verified."""


@dataclass(frozen=True)
class Mismatch:
    model_id: str
    field: str
    catalog_value: Any
    gguf_value: Any


@dataclass(frozen=True)
class VerificationReport:
    verified: dict[str, bool]
    mismatches: list[Mismatch]


def compare_architecture(model: dict[str, Any], observed: dict[str, Any]) -> list[Mismatch]:
    mismatches = []
    for gguf_field, catalog_field in ARCH_FIELDS:
        catalog_value = model["arch"][catalog_field]
        gguf_value = observed.get(gguf_field)
        if catalog_value != gguf_value:
            mismatches.append(
                Mismatch(
                    model_id=model["id"],
                    field=gguf_field,
                    catalog_value=catalog_value,
                    gguf_value=gguf_value,
                )
            )
    return mismatches


def _cache_file(cache_dir: Path, url: str) -> Path:
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
    return cache_dir / f"{digest}.json"


def _read_cache(cache_dir: Path, url: str) -> dict[str, Any] | None:
    path = _cache_file(cache_dir, url)
    if not path.exists():
        return None
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CatalogVerificationError(f"could not read probe cache {path}: {error}") from error
    if not isinstance(result, dict) or not all(field in result for field in FACT_FIELDS):
        raise CatalogVerificationError(f"invalid probe cache entry: {path}")
    return result


def _write_cache(cache_dir: Path, url: str, result: dict[str, Any]) -> None:
    path = _cache_file(cache_dir, url)
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    except OSError as error:
        raise CatalogVerificationError(f"could not write probe cache {path}: {error}") from error


def verify_models(
    models: list[dict[str, Any]],
    *,
    cache_dir: Path = CACHE_PATH,
    limit: int | None = None,
    probe: Callable[[str], dict[str, Any]] | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> VerificationReport:
    if limit is not None and limit < 1:
        raise CatalogVerificationError("--limit must be greater than zero")
    selected = models[:limit] if limit is not None else models
    get_facts = probe or facts
    verified: dict[str, bool] = {}
    mismatches: list[Mismatch] = []
    requests_made = 0

    for model in selected:
        url = model["quants"][0]["url"]
        observed = _read_cache(cache_dir, url)
        if observed is None:
            if requests_made:
                sleep(1.0)
            try:
                observed = get_facts(url)
            except (
                requests.RequestException,
                RuntimeError,
                ValueError,
                KeyError,
                TypeError,
                struct.error,
                Truncated,
                ZeroDivisionError,
            ) as error:
                raise CatalogVerificationError(
                    f"{model['id']}: GGUF probe failed: {error}"
                ) from error
            _write_cache(cache_dir, url, observed)
            requests_made += 1

        model_mismatches = compare_architecture(model, observed)
        verified[model["id"]] = not model_mismatches
        mismatches.extend(model_mismatches)

    return VerificationReport(verified=verified, mismatches=mismatches)


def print_report(report: VerificationReport, output: TextIO | None = None) -> None:
    if output is None:
        output = sys.stdout
    print("Model | Verified", file=output)
    print("------|---------", file=output)
    for model_id, verified in report.verified.items():
        print(f"{model_id} | {str(verified).lower()}", file=output)

    if not report.mismatches:
        print("\nNo metadata mismatches found.", file=output)
        return

    print("\nMismatches:", file=output)
    print("Model | Field | Catalog | GGUF", file=output)
    print("------|-------|---------|-----", file=output)
    for mismatch in report.mismatches:
        catalog_value = json.dumps(mismatch.catalog_value, ensure_ascii=False)
        gguf_value = json.dumps(mismatch.gguf_value, ensure_ascii=False)
        print(
            f"{mismatch.model_id} | {mismatch.field} | "
            f"{catalog_value} | {gguf_value}",
            file=output,
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--limit",
        type=int,
        help="verify only the first N catalog models (for a smoke test)",
    )
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be greater than zero")

    try:
        catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
        validate_catalog(catalog)
        report = verify_models(catalog["models"], limit=args.limit)
    except (CatalogBuildError, CatalogVerificationError, OSError, json.JSONDecodeError) as error:
        print(f"Catalog verification failed: {error}", file=sys.stderr)
        return 1

    print_report(report)
    return 1 if report.mismatches else 0


if __name__ == "__main__":
    raise SystemExit(main())
