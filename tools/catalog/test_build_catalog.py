import json
from pathlib import Path
import tempfile
import unittest

from build_catalog import (
    CatalogBuildError,
    build_catalog,
    discover_new_repos,
    parse_config,
    parse_sources,
    select_quants,
    validate_catalog,
    write_catalog,
)


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tools" / "catalog" / "fixtures"


class SourceManifestTests(unittest.TestCase):
    def test_parses_yaml_subset_and_rejects_gated_sources(self):
        manifest = """
models:
  - id: "fixture-1b"
    family: "fixture"
    name: "Fixture 1B"
    gguf_repo: "owner/model-gguf"
    config_repo: "owner/model"
    params_b: 1.0
    license_spdx: "Apache-2.0"
    license_kind: "open_source"
    license_url: "https://example.com/license"
    gated: false
    tags: ["chat", "small"]
    verified: false
    added_at: "2026-10-25"
"""
        parsed = parse_sources(manifest)
        self.assertEqual(parsed[0]["tags"], ["chat", "small"])
        self.assertFalse(parsed[0]["gated"])

        with self.assertRaisesRegex(CatalogBuildError, "gated: false"):
            parse_sources(manifest.replace("gated: false", "gated: true"))

    def test_seed_covers_each_family_and_preserves_existing_catalog_models(self):
        sources = parse_sources((ROOT / "catalog" / "sources.yml").read_text(encoding="utf-8"))
        counts = {}
        for source in sources:
            counts[source["family"]] = counts.get(source["family"], 0) + 1
        self.assertEqual(set(counts), {"qwen2.5", "llama3", "gemma3", "mistral", "phi", "deepseek"})
        self.assertTrue(all(3 <= counts[family] <= 5 for family in counts if family != "qwen2.5"))
        self.assertEqual(counts["qwen2.5"], 7)
        self.assertTrue(all(source["verified"] is False for source in sources))
        previous = json.loads((ROOT / "catalog" / "models.v1.json").read_text(encoding="utf-8"))
        self.assertTrue(
            {model["id"] for model in previous["models"]}.issubset(
                {source["id"] for source in sources}
            )
        )


class CatalogMetadataTests(unittest.TestCase):
    def test_parses_architecture_from_recorded_config(self):
        config = json.loads((FIXTURES / "config.json").read_text(encoding="utf-8"))
        self.assertEqual(
            parse_config(config),
            {"layers": 28, "kv_heads": 4, "head_dim": 128, "context_max": 32768},
        )

    def test_selects_supported_quants_in_preference_order(self):
        tree = json.loads((FIXTURES / "tree.json").read_text(encoding="utf-8"))
        quants = select_quants(tree, "owner/model-gguf", "abcdef123456")
        self.assertEqual([quant["name"] for quant in quants], ["Q4_K_M", "Q5_K_M", "Q8_0"])
        self.assertEqual(quants[0]["sha256"], "a" * 64)
        self.assertEqual(
            quants[0]["url"],
            "https://huggingface.co/owner/model-gguf/resolve/abcdef123456/model-Q4_K_M.gguf",
        )

    def test_schema_check_rejects_invalid_model_architecture(self):
        current = json.loads((ROOT / "catalog" / "models.v1.json").read_text(encoding="utf-8"))
        validate_catalog(current)
        current["models"][0]["arch"]["layers"] = 0
        with self.assertRaisesRegex(CatalogBuildError, "minimum"):
            validate_catalog(current)

    def test_discovery_returns_unverified_suggestions_without_mutating_sources(self):
        class FakeApi:
            def discover(self, search):
                if search == "Qwen":
                    return [
                        {
                            "id": "new-owner/new-model-gguf",
                            "private": False,
                            "tags": ["gguf", "license:apache-2.0"],
                        }
                    ]
                return []

            def get_json(self, url):
                return {"sha": "fixture-revision", "private": False, "gated": False}

        source_path = ROOT / "catalog" / "sources.yml"
        before = source_path.read_bytes()
        sources = parse_sources(before.decode("utf-8"))
        suggestions = discover_new_repos(sources, FakeApi())
        self.assertEqual(len(suggestions), 1)
        self.assertEqual(suggestions[0]["family"], "qwen2.5")
        self.assertFalse(suggestions[0]["verified"])
        self.assertEqual(source_path.read_bytes(), before)

    def test_writer_refuses_to_touch_a_signature_file(self):
        with tempfile.TemporaryDirectory() as directory:
            signature_path = Path(directory) / "models.v1.json.minisig"
            with self.assertRaisesRegex(CatalogBuildError, "Minisign"):
                write_catalog(signature_path, {})
            self.assertFalse(signature_path.exists())

    def test_rebuild_preserves_generated_at_when_model_data_is_unchanged(self):
        class FakeApi:
            def model_info(self, repo):
                return {"sha": "fixture-revision", "gated": False}

            def config(self, repo):
                return json.loads((FIXTURES / "config.json").read_text(encoding="utf-8"))

            def repo_tree(self, repo, revision):
                return json.loads((FIXTURES / "tree.json").read_text(encoding="utf-8"))

        sources = parse_sources((ROOT / "catalog" / "sources.yml").read_text(encoding="utf-8"))
        first = build_catalog(sources[:1], FakeApi())
        second = build_catalog(sources[:1], FakeApi(), first)
        self.assertEqual(second, first)

    def test_writer_outputs_utf8_without_bom_and_lf_only(self):
        catalog = json.loads((ROOT / "catalog" / "models.v1.json").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory) / "models.v1.json"
            write_catalog(output_path, catalog)
            contents = output_path.read_bytes()
            self.assertFalse(contents.startswith(b"\xef\xbb\xbf"))
            self.assertNotIn(b"\r", contents)


if __name__ == "__main__":
    unittest.main()
