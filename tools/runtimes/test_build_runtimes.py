from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
import requests

from build_runtimes import (
    RuntimeBuildError,
    asset_metadata,
    build_manifest,
    cuda_driver_version,
    select_assets,
)


FIXTURES = Path(__file__).parent / "fixtures"


class FakeResponse:
    def __init__(self, content: bytes):
        self.content = content

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def raise_for_status(self) -> None:
        return None

    def iter_content(self, chunk_size: int):
        yield self.content[:chunk_size]


class FakeSession:
    def __init__(self, content: bytes):
        self.content = content

    def get(self, *_: object, **__: object) -> FakeResponse:
        return FakeResponse(self.content)


def recorded_release() -> dict:
    return json.loads((FIXTURES / "release.json").read_text(encoding="utf-8"))


def test_select_assets_includes_cpu_vulkan_and_multiple_cuda_versions() -> None:
    selected = select_assets(recorded_release())

    assert selected["tag"] == "b1234"
    assert list(selected["cuda"]) == ["12.4", "13.1"]
    assert selected["cuda"]["12.4"][1]["name"] == "cudart-llama-bin-win-cuda-12.4-x64.zip"


@pytest.mark.parametrize(("version", "expected"), [("12.4", 12040), ("13.1", 13010)])
def test_cuda_version_maps_to_minimum_driver(version: str, expected: int) -> None:
    assert cuda_driver_version(version) == expected


def test_asset_metadata_uses_downloaded_digest_and_size() -> None:
    contents = b"recorded asset bytes"
    asset = {
        "name": "cpu.zip",
        "browser_download_url": "https://github.com/ggml-org/llama.cpp/releases/download/b1234/cpu.zip",
        "digest": f"sha256:{hashlib.sha256(contents).hexdigest()}",
    }

    metadata = asset_metadata(asset, FakeSession(contents))  # type: ignore[arg-type]

    assert metadata["sha256"] == hashlib.sha256(contents).hexdigest()
    assert metadata["size_bytes"] == len(contents)


def test_digest_disagreement_fails() -> None:
    asset = {
        "name": "cpu.zip",
        "browser_download_url": "https://github.com/ggml-org/llama.cpp/releases/download/b1234/cpu.zip",
        "digest": f"sha256:{'0' * 64}",
    }

    with pytest.raises(RuntimeBuildError, match="does not match"):
        asset_metadata(asset, FakeSession(b"asset bytes"))  # type: ignore[arg-type]


def test_manifest_contains_all_release_files_and_launch_hints() -> None:
    contents = b"fixture"
    manifest, summary = build_manifest(
        recorded_release(),
        "2026-11-18T00:00:00Z",
        FakeSession(contents),  # type: ignore[arg-type]
    )

    runtime = manifest["runtimes"][0]
    assert runtime["version"] == "b1234"
    assert {variant["variant"] for variant in runtime["variants"]} == {
        "cpu",
        "vulkan",
        "cuda-12.4",
        "cuda-13.1",
    }
    assert all(variant["server_exe"] == "llama-server.exe" for variant in runtime["variants"])
    assert len(summary) == 6


def test_release_missing_cuda_runtime_is_rejected() -> None:
    release = recorded_release()
    release["assets"] = [
        asset
        for asset in release["assets"]
        if asset["name"] != "cudart-llama-bin-win-cuda-13.1-x64.zip"
    ]

    with pytest.raises(RuntimeBuildError, match="missing the CUDA 13.1"):
        select_assets(release)
