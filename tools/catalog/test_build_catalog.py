from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import call, patch

import requests

from build_catalog import (
    CatalogBuildError,
    HuggingFaceApi,
    build_catalog,
    discover_new_repos,
    main,
    parse_config,
    parse_sources,
    select_quants,
    validate_catalog,
    write_catalog,
)


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tools" / "catalog" / "fixtures"
SOURCE_MANIFEST = """
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


def json_response(data, headers=None):
    response = requests.Response()
    response.status_code = 200
    response._content = json.dumps(data).encode("utf-8")
    response.headers.update(headers or {})
    return response


class SourceManifestTests(unittest.TestCase):
    def test_parses_yaml_subset_and_rejects_gated_sources(self):
        manifest = SOURCE_MANIFEST
        parsed = parse_sources(manifest)
        self.assertEqual(parsed[0]["tags"], ["chat", "small"])
        self.assertFalse(parsed[0]["gated"])

        with self.assertRaisesRegex(CatalogBuildError, "gated: false"):
            parse_sources(manifest.replace("gated: false", "gated: true"))

    def test_rejects_unquoted_hash_values_and_preserves_quoted_values(self):
        parse_sources(SOURCE_MANIFEST)
        for raw in ("Fixture # comment", "Fixture#1B", "false # comment"):
            with self.subTest(raw=raw):
                manifest = SOURCE_MANIFEST.replace('"Fixture 1B"', raw)
                with self.assertRaisesRegex(CatalogBuildError, "use JSON quoting"):
                    parse_sources(manifest)
        manifest = SOURCE_MANIFEST.replace('"Fixture 1B"', '"Fixture #1B"')
        self.assertEqual(parse_sources(manifest)[0]["name"], "Fixture #1B")
        manifest = SOURCE_MANIFEST.replace('["chat", "small"]', '["chat#1", "small"]')
        self.assertEqual(parse_sources(manifest)[0]["tags"], ["chat#1", "small"])

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
    def test_repo_tree_follows_next_link_and_combines_pages(self):
        first_page = [{"path": "first.gguf"}]
        second_page = [{"path": "second.gguf"}]
        next_url = "https://huggingface.co/api/models/owner/model/tree/revision?cursor=next"
        responses = [
            json_response(first_page, {"Link": f'<{next_url}>; rel="next"'}),
            json_response(second_page),
        ]
        with requests.Session() as session:
            api = HuggingFaceApi(session)
            with patch.object(session, "get", side_effect=responses) as get:
                self.assertEqual(api.repo_tree("owner/model", "revision"), first_page + second_page)
        self.assertEqual(
            get.call_args_list,
            [
                call(
                    "https://huggingface.co/api/models/owner/model/tree/revision?recursive=true&expand=false",
                    timeout=30,
                ),
                call(next_url, timeout=30),
            ],
        )

    def test_api_wraps_request_errors(self):
        for method in ("get_json", "repo_tree"):
            for failure in ("connection", "http"):
                with self.subTest(method=method, failure=failure), requests.Session() as session:
                    api = HuggingFaceApi(session)
                    response = json_response({})
                    response.status_code = 503
                    kwargs = (
                        {"side_effect": requests.ConnectionError("offline")}
                        if failure == "connection"
                        else {"return_value": response}
                    )
                    args = (
                        ("https://huggingface.co/api/models/owner/model",)
                        if method == "get_json"
                        else ("owner/model", "revision")
                    )
                    with patch.object(session, "get", **kwargs):
                        with self.assertRaisesRegex(CatalogBuildError, "request failed"):
                            getattr(api, method)(*args)

    def test_api_wraps_invalid_json(self):
        for method in ("get_json", "repo_tree"):
            with self.subTest(method=method), requests.Session() as session:
                api = HuggingFaceApi(session)
                response = json_response({})
                response._content = b"not JSON"
                args = (
                    ("https://huggingface.co/api/models/owner/model",)
                    if method == "get_json"
                    else ("owner/model", "revision")
                )
                with patch.object(session, "get", return_value=response):
                    with self.assertRaises(CatalogBuildError) as caught:
                        getattr(api, method)(*args)
                self.assertIsInstance(caught.exception.__cause__, requests.exceptions.JSONDecodeError)

    def test_main_check_validates_schema_and_duplicate_ids_without_network(self):
        valid = json.loads((ROOT / "catalog" / "models.v1.json").read_text(encoding="utf-8"))
        invalid = deepcopy(valid)
        invalid["models"][0]["arch"]["layers"] = 0
        duplicate = deepcopy(valid)
        duplicate["models"].append(deepcopy(duplicate["models"][0]))
        schema = json.loads((ROOT / "catalog" / "schema.v1.json").read_text(encoding="utf-8"))
        schema["properties"]["schema"]["const"] = 2
        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory) / "models.json"
            schema_path = Path(directory) / "schema.json"
            schema_path.write_text(json.dumps(schema), encoding="utf-8")
            argv = ["build_catalog.py", "--check", "--output", str(output_path)]
            for label, catalog, extra_args, expected, message in (
                ("valid", valid, [], 0, "Catalog schema is valid"),
                ("schema", invalid, [], 1, "minimum"),
                ("duplicates", duplicate, [], 1, "duplicate model ids"),
                ("custom schema", valid, ["--schema", str(schema_path)], 1, "expected 2"),
            ):
                with self.subTest(label=label):
                    output_path.write_text(json.dumps(catalog), encoding="utf-8")
                    before = output_path.read_bytes()
                    stdout, stderr = io.StringIO(), io.StringIO()
                    with patch("sys.argv", argv + extra_args), patch("requests.Session.get") as get:
                        with redirect_stdout(stdout), redirect_stderr(stderr):
                            self.assertEqual(main(), expected)
                    self.assertIn(message, stdout.getvalue() + stderr.getvalue())
                    get.assert_not_called()
                    self.assertEqual(output_path.read_bytes(), before)

    def test_main_summary_reports_added_changed_removed_and_no_changes(self):
        previous = json.loads((ROOT / "catalog" / "models.v1.json").read_text(encoding="utf-8"))
        previous["models"] = previous["models"][:2]
        previous["models"][0].update(id="fixture-1b", name="Old name")
        previous["models"][1]["id"] = "removed-model"
        validate_catalog(previous)
        config = json.loads((FIXTURES / "config.json").read_text(encoding="utf-8"))
        tree = json.loads((FIXTURES / "tree.json").read_text(encoding="utf-8"))
        info = {"sha": "fixture-revision", "private": False, "gated": False}
        responses = [json_response(data) for data in (info, info, config, tree)]
        with tempfile.TemporaryDirectory() as directory:
            sources_path = Path(directory) / "sources.yml"
            output_path = Path(directory) / "models.json"
            summary_path = Path(directory) / "summary.md"
            sources_path.write_text(
                SOURCE_MANIFEST + SOURCE_MANIFEST.replace("models:\n", "").replace("fixture-1b", "fixture-2b"),
                encoding="utf-8",
            )
            output_path.write_text(json.dumps(previous), encoding="utf-8")
            argv = [
                "build_catalog.py", "--sources", str(sources_path),
                "--output", str(output_path), "--summary-file", str(summary_path),
            ]
            with patch("sys.argv", argv), patch("requests.Session.get", side_effect=responses * 4) as get:
                with redirect_stdout(io.StringIO()):
                    self.assertEqual(main(), 0)
                summary = summary_path.read_text(encoding="utf-8")
                self.assertIn("Added models:\n- `fixture-2b`", summary)
                self.assertIn("Changed models:\n- `fixture-1b`", summary)
                self.assertIn("Removed models:\n- `removed-model`", summary)
                self.assertIn("tools/catalog/sign.ps1", summary)
                generated = json.loads(output_path.read_text(encoding="utf-8"))
                validate_catalog(generated)
                self.assertEqual([model["id"] for model in generated["models"]], ["fixture-1b", "fixture-2b"])
                before = output_path.read_bytes()
                with redirect_stdout(io.StringIO()):
                    self.assertEqual(main(), 0)
                summary = summary_path.read_text(encoding="utf-8")
                self.assertIn("No model metadata changes detected.", summary)
                for label in ("Added", "Changed", "Removed"):
                    self.assertNotIn(f"{label} models:", summary)
                self.assertEqual(output_path.read_bytes(), before)
                self.assertEqual(get.call_count, 16)

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
