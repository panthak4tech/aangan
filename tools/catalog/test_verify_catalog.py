import io
import json
import struct

import pytest

import gguf_probe
from verify_catalog import Mismatch, compare_architecture, print_report, verify_models


def _gguf_string(value):
    encoded = value.encode("utf-8")
    return struct.pack("<Q", len(encoded)) + encoded


def _gguf_entry(key, value_type, value):
    return _gguf_string(key) + struct.pack("<I", value_type) + value


def _gguf_header(entries, declared_count=None):
    count = len(entries) if declared_count is None else declared_count
    return b"GGUF" + struct.pack("<IQQ", 3, 0, count) + b"".join(entries)


def _model(model_id, url, **arch_overrides):
    arch = {
        "layers": 32,
        "kv_heads": 8,
        "head_dim": 128,
        "context_max": 8192,
    }
    arch.update(arch_overrides)
    return {
        "id": model_id,
        "arch": arch,
        "quants": [{"url": url}],
    }


def _facts(**overrides):
    result = {
        "arch": "llama",
        "layers": 32,
        "kv_heads": 8,
        "head_dim": 128,
        "context_length": 8192,
    }
    result.update(overrides)
    return result


def test_parse_reads_architecture_and_skips_an_array():
    entries = [
        _gguf_entry(
            "general.labels",
            9,
            struct.pack("<IQ", 8, 2) + _gguf_string("first") + _gguf_string("second"),
        ),
        _gguf_entry("general.architecture", 8, _gguf_string("llama")),
        _gguf_entry("llama.block_count", 4, struct.pack("<I", 32)),
        _gguf_entry("llama.embedding_length", 4, struct.pack("<I", 4096)),
        _gguf_entry("llama.attention.head_count", 4, struct.pack("<I", 32)),
        _gguf_entry("llama.attention.head_count_kv", 4, struct.pack("<I", 8)),
        _gguf_entry("llama.context_length", 4, struct.pack("<I", 8192)),
    ]

    parsed = gguf_probe.parse(_gguf_header(entries))

    assert parsed == {
        "version": 3,
        "arch": "llama",
        "block_count": 32,
        "embedding_length": 4096,
        "attention.head_count": 32,
        "attention.head_count_kv": 8,
        "context_length": 8192,
    }


def test_parse_rejects_truncated_array():
    array = struct.pack("<IQ", 8, 1) + struct.pack("<Q", 12) + b"short"
    entries = [_gguf_entry("general.labels", 9, array)]

    with pytest.raises(gguf_probe.Truncated):
        gguf_probe.parse(_gguf_header(entries))


def test_compare_architecture_returns_only_mismatches():
    model = _model("fixture-model", "https://example.test/model.gguf")

    mismatches = compare_architecture(
        model,
        _facts(layers=31, context_length=4096),
    )

    assert mismatches == [
        Mismatch("fixture-model", "layers", 32, 31),
        Mismatch("fixture-model", "context_length", 8192, 4096),
    ]


def test_verification_reports_matches_and_mismatches_without_network(tmp_path):
    models = [
        _model("matches", "https://example.test/matches.gguf"),
        _model("mismatches", "https://example.test/mismatches.gguf"),
    ]
    results = {
        models[0]["quants"][0]["url"]: _facts(),
        models[1]["quants"][0]["url"]: _facts(kv_heads=4),
    }
    calls = []

    report = verify_models(
        models,
        cache_dir=tmp_path,
        probe=lambda url: calls.append(url) or results[url],
        sleep=lambda delay: calls.append(f"sleep:{delay}"),
    )
    output = io.StringIO()
    print_report(report, output)

    assert report.verified == {"matches": True, "mismatches": False}
    assert [item.field for item in report.mismatches] == ["kv_heads"]
    assert calls == [
        models[0]["quants"][0]["url"],
        "sleep:1.0",
        models[1]["quants"][0]["url"],
    ]
    assert "matches | true" in output.getvalue()
    assert "mismatches | false" in output.getvalue()
    assert "kv_heads" in output.getvalue()


def test_verification_uses_cache_and_respects_limit_and_rate_delay(tmp_path):
    models = [
        _model(f"model-{index}", f"https://example.test/{index}.gguf")
        for index in range(3)
    ]
    calls = []
    delays = []
    probe = lambda url: calls.append(url) or _facts()

    first = verify_models(
        models,
        cache_dir=tmp_path,
        limit=2,
        probe=probe,
        sleep=delays.append,
    )
    second = verify_models(
        models,
        cache_dir=tmp_path,
        limit=2,
        probe=lambda _url: pytest.fail("cached result should be reused"),
    )

    assert len(first.verified) == 2
    assert first.verified == second.verified
    assert len(calls) == 2
    assert delays == [1.0]
    assert len(list(tmp_path.glob("*.json"))) == 2
    assert all(
        json.loads(path.read_text(encoding="utf-8"))["arch"] == "llama"
        for path in tmp_path.glob("*.json")
    )
