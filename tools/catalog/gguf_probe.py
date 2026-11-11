#!/usr/bin/env python3
"""Read architecture facts from a GGUF file header via HTTP Range (no full download).

Usage: python tools/catalog/gguf_probe.py <https url to a .gguf file>
Prints JSON: arch, layers, kv_heads, head_dim, context_length.
"""

import json
import struct
import sys

import requests

MAGIC = b"GGUF"
T_U8, T_I8, T_U16, T_I16, T_U32, T_I32, T_F32, T_BOOL, T_STR, T_ARR, T_U64, T_I64, T_F64 = range(13)
_FMT = {
    T_U8: "<B",
    T_I8: "<b",
    T_U16: "<H",
    T_I16: "<h",
    T_U32: "<I",
    T_I32: "<i",
    T_F32: "<f",
    T_BOOL: "<?",
    T_U64: "<Q",
    T_I64: "<q",
    T_F64: "<d",
}
WANTED = (
    "block_count",
    "context_length",
    "embedding_length",
    "attention.head_count",
    "attention.head_count_kv",
    "attention.key_length",
)


class Truncated(Exception):
    """Raised when a requested field extends past the available bytes."""


class Reader:
    def __init__(self, buf: bytes):
        self.buf, self.pos = buf, 0

    def take(self, n: int) -> bytes:
        if self.pos + n > len(self.buf):
            raise Truncated()
        out = self.buf[self.pos : self.pos + n]
        self.pos += n
        return out

    def scalar(self, value_type: int):
        fmt = _FMT[value_type]
        return struct.unpack(fmt, self.take(struct.calcsize(fmt)))[0]

    def string(self) -> str:
        (length,) = struct.unpack("<Q", self.take(8))
        return self.take(length).decode("utf-8", "replace")

    def value(self, value_type: int):
        if value_type == T_STR:
            return self.string()
        if value_type == T_ARR:
            (element_type,) = struct.unpack("<I", self.take(4))
            (length,) = struct.unpack("<Q", self.take(8))
            for _ in range(length):
                self.value(element_type)
            return None
        return self.scalar(value_type)


def _core_present(meta: dict) -> bool:
    return all(
        key in meta
        for key in ("block_count", "embedding_length", "attention.head_count")
    )


def parse(buf: bytes) -> dict:
    reader = Reader(buf)
    if reader.take(4) != MAGIC:
        raise ValueError("not a GGUF file")
    (version,) = struct.unpack("<I", reader.take(4))
    _tensors, kv_count = struct.unpack("<QQ", reader.take(16))
    meta = {}
    arch = None
    try:
        for _ in range(kv_count):
            key = reader.string()
            (value_type,) = struct.unpack("<I", reader.take(4))
            value = reader.value(value_type)
            if key == "general.architecture":
                arch = value
            elif arch and key.startswith(arch + ".") and key[len(arch) + 1 :] in WANTED:
                meta[key[len(arch) + 1 :]] = value
            if (
                _core_present(meta)
                and "attention.head_count_kv" in meta
                and "context_length" in meta
            ):
                break
    except Truncated:
        if not (arch and _core_present(meta)):
            raise
    return {"version": version, "arch": arch, **meta}


def fetch_prefix(url: str, size: int) -> bytes:
    headers = {"Range": f"bytes=0-{size - 1}"}
    with requests.get(url, headers=headers, stream=True, timeout=30) as response:
        response.raise_for_status()
        buf = b""
        for chunk in response.iter_content(chunk_size=1 << 16):
            buf += chunk
            if len(buf) >= size:
                break
        return buf[:size]


def facts(url: str) -> dict:
    last = None
    for size in (1 << 20, 4 << 20, 16 << 20):
        try:
            meta = parse(fetch_prefix(url, size))
            break
        except Truncated as error:
            last = error
    else:
        raise RuntimeError("GGUF header larger than 16 MiB; giving up") from last
    heads = meta["attention.head_count"]
    if not isinstance(heads, int):
        raise RuntimeError("per-layer head counts are not supported by this probe")
    kv_heads = meta.get("attention.head_count_kv", heads)
    if not isinstance(kv_heads, int):
        raise RuntimeError("per-layer kv head counts are not supported by this probe")
    head_dim = meta.get("attention.key_length") or meta["embedding_length"] // heads
    return {
        "arch": meta["arch"],
        "layers": meta["block_count"],
        "kv_heads": kv_heads,
        "head_dim": head_dim,
        "context_length": meta.get("context_length"),
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    print(json.dumps(facts(sys.argv[1]), indent=2))
