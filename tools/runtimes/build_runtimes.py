#!/usr/bin/env python3
"""Build a llama.cpp runtime manifest from a GitHub release."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

import requests


ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = ROOT / "catalog" / "runtimes.v1.json"
API_ROOT = "https://api.github.com/repos/ggml-org/llama.cpp/releases"
USER_AGENT = "Aangan-runtime-manifest-builder"


class RuntimeBuildError(ValueError):
    """Raised when a release cannot produce a complete runtime manifest."""


def cuda_driver_version(cuda_version: str) -> int:
    match = re.fullmatch(r"(\d+)\.(\d+)", cuda_version)
    if not match:
        raise RuntimeBuildError(f"invalid CUDA version: {cuda_version}")
    major, minor = (int(value) for value in match.groups())
    return major * 1000 + minor * 10


def select_assets(release: dict[str, Any]) -> dict[str, Any]:
    tag = release.get("tag_name")
    if not isinstance(tag, str) or not re.fullmatch(r"[A-Za-z0-9._-]+", tag):
        raise RuntimeBuildError("release has an invalid tag_name")
    assets = release.get("assets")
    if not isinstance(assets, list):
        raise RuntimeBuildError("release assets are missing")

    cpu_name = f"llama-{tag}-bin-win-cpu-x64.zip"
    vulkan_name = f"llama-{tag}-bin-win-vulkan-x64.zip"
    cuda_pattern = re.compile(
        rf"llama-{re.escape(tag)}-bin-win-cuda-(\d+\.\d+)-x64\.zip"
    )
    cudart_pattern = re.compile(r"cudart-llama-bin-win-cuda-(\d+\.\d+)-x64\.zip")
    by_name: dict[str, dict[str, Any]] = {}
    cuda_assets: dict[str, dict[str, Any]] = {}
    cudart_assets: dict[str, dict[str, Any]] = {}

    for asset in assets:
        if not isinstance(asset, dict) or not isinstance(asset.get("name"), str):
            continue
        name = asset["name"]
        if name in {cpu_name, vulkan_name}:
            by_name[name] = asset
            continue
        cuda_match = cuda_pattern.fullmatch(name)
        if cuda_match:
            cuda_assets[cuda_match.group(1)] = asset
            continue
        cudart_match = cudart_pattern.fullmatch(name)
        if cudart_match:
            cudart_assets[cudart_match.group(1)] = asset

    missing = [name for name in (cpu_name, vulkan_name) if name not in by_name]
    if missing:
        raise RuntimeBuildError(f"release is missing required assets: {', '.join(missing)}")
    if not cuda_assets:
        raise RuntimeBuildError("release has no Windows x64 CUDA builds")
    for version in cuda_assets:
        if version not in cudart_assets:
            raise RuntimeBuildError(f"release is missing the CUDA {version} runtime DLL archive")

    return {
        "tag": tag,
        "cpu": by_name[cpu_name],
        "vulkan": by_name[vulkan_name],
        "cuda": {
            version: (cuda_assets[version], cudart_assets[version])
            for version in sorted(cuda_assets, key=lambda value: tuple(map(int, value.split("."))))
        },
    }


def asset_metadata(
    asset: dict[str, Any], session: requests.Session
) -> dict[str, Any]:
    name = asset.get("name")
    url = asset.get("browser_download_url")
    if not isinstance(name, str) or not isinstance(url, str) or not url.startswith("https://"):
        raise RuntimeBuildError("release asset is missing a valid name or HTTPS URL")
    digest = hashlib.sha256()
    size = 0
    try:
        with session.get(
            url,
            headers={"User-Agent": USER_AGENT},
            stream=True,
            timeout=(15, 120),
        ) as response:
            response.raise_for_status()
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    digest.update(chunk)
                    size += len(chunk)
    except requests.RequestException as error:
        raise RuntimeBuildError(f"could not download {name}: {error}") from error
    if size == 0:
        raise RuntimeBuildError(f"release asset is empty: {name}")

    published_digest = asset.get("digest")
    if published_digest:
        if not isinstance(published_digest, str) or not published_digest.startswith("sha256:"):
            raise RuntimeBuildError(f"release asset has an unsupported digest: {name}")
        if published_digest.removeprefix("sha256:").lower() != digest.hexdigest():
            raise RuntimeBuildError(f"GitHub digest does not match downloaded bytes: {name}")

    return {"url": url, "sha256": digest.hexdigest(), "size_bytes": size}


def build_manifest(
    release: dict[str, Any],
    generated_at: str,
    session: requests.Session,
) -> tuple[dict[str, Any], list[tuple[str, int]]]:
    selected = select_assets(release)
    variants: list[dict[str, Any]] = []
    summary: list[tuple[str, int]] = []

    def file_entry(asset: dict[str, Any]) -> dict[str, Any]:
        metadata = asset_metadata(asset, session)
        summary.append((asset["name"], metadata["size_bytes"]))
        return metadata

    for label, asset, kind, requirement in (
        ("cpu", selected["cpu"], "cpu", None),
        ("vulkan", selected["vulkan"], "vulkan", None),
    ):
        variants.append(
            {
                "variant": label,
                "kind": kind,
                "requires_cuda_driver": requirement,
                "files": [file_entry(asset)],
                "server_exe": "llama-server.exe",
            }
        )

    for cuda_version, assets in selected["cuda"].items():
        variants.append(
            {
                "variant": f"cuda-{cuda_version}",
                "kind": "cuda",
                "requires_cuda_driver": cuda_driver_version(cuda_version),
                "files": [file_entry(asset) for asset in assets],
                "server_exe": "llama-server.exe",
            }
        )

    variants.sort(key=lambda item: (item["kind"], item["variant"]))
    manifest = {
        "schema": 1,
        "generated_at": generated_at,
        "runtimes": [
            {
                "id": "llama.cpp",
                "display_name": "llama.cpp",
                "version": selected["tag"],
                "license": "MIT",
                "homepage": "https://github.com/ggml-org/llama.cpp",
                "variants": variants,
            }
        ],
    }
    return manifest, summary


def fetch_release(tag: str | None, session: requests.Session) -> dict[str, Any]:
    endpoint = f"{API_ROOT}/tags/{tag}" if tag else f"{API_ROOT}/latest"
    try:
        response = session.get(
            endpoint,
            headers={"Accept": "application/vnd.github+json", "User-Agent": USER_AGENT},
            timeout=(15, 60),
        )
        response.raise_for_status()
        release = response.json()
    except (requests.RequestException, ValueError) as error:
        raise RuntimeBuildError(f"could not query the llama.cpp release API: {error}") from error
    if not isinstance(release, dict):
        raise RuntimeBuildError("release API returned an invalid response")
    if tag:
        return release
    try:
        select_assets(release)
        return release
    except RuntimeBuildError:
        pass

    try:
        response = session.get(
            f"{API_ROOT}?per_page=100",
            headers={"Accept": "application/vnd.github+json", "User-Agent": USER_AGENT},
            timeout=(15, 60),
        )
        response.raise_for_status()
        releases = response.json()
    except (requests.RequestException, ValueError) as error:
        raise RuntimeBuildError(f"could not list llama.cpp releases: {error}") from error
    if not isinstance(releases, list):
        raise RuntimeBuildError("release API returned an invalid release list")
    for candidate in releases:
        if not isinstance(candidate, dict):
            continue
        try:
            select_assets(candidate)
        except RuntimeBuildError:
            continue
        return candidate
    raise RuntimeBuildError("no release in the latest 100 releases has the required Windows x64 assets")


def write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    contents = json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    path.write_bytes(contents.encode("utf-8"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", help="build a specific llama.cpp release tag")
    parser.add_argument("--output", type=Path, default=MANIFEST_PATH)
    args = parser.parse_args(argv)
    try:
        with requests.Session() as session:
            release = fetch_release(args.tag, session)
            generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
            generated_at = generated_at.replace("+00:00", "Z")
            manifest, summary = build_manifest(release, generated_at, session)
        write_manifest(args.output, manifest)
    except RuntimeBuildError as error:
        print(f"runtime manifest build failed: {error}", file=sys.stderr)
        return 1

    print(f"Built llama.cpp {manifest['runtimes'][0]['version']} manifest:")
    for name, size in summary:
        print(f"  {name}: {size:,} bytes")
    print(f"  total: {sum(size for _, size in summary):,} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
