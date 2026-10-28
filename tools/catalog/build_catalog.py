#!/usr/bin/env python3
"""Build the curated model catalog from the JSON-compatible sources.yml manifest."""

from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
import json
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode, urlparse

import requests


ROOT = Path(__file__).resolve().parents[2]
SOURCE_PATH = ROOT / "catalog" / "sources.yml"
CATALOG_PATH = ROOT / "catalog" / "models.v1.json"
SCHEMA_PATH = ROOT / "catalog" / "schema.v1.json"
HF_ROOT = "https://huggingface.co"
QUANT_NAMES = ("Q4_K_M", "Q5_K_M", "Q8_0")
SOURCE_FIELDS = {
    "id",
    "family",
    "name",
    "gguf_repo",
    "config_repo",
    "params_b",
    "license_spdx",
    "license_kind",
    "license_url",
    "gated",
    "tags",
    "verified",
    "added_at",
}
FAMILY_SEARCH = {
    "qwen2.5": "Qwen",
    "llama3": "Llama",
    "gemma3": "Gemma",
    "mistral": "Mistral",
    "phi": "Phi",
    "deepseek": "DeepSeek",
}


class CatalogBuildError(ValueError):
    """Raised when the curated inputs cannot produce a valid catalog."""


def _parse_yaml_scalar(raw: str, line_number: int) -> Any:
    if not raw:
        raise CatalogBuildError(f"source line {line_number}: value is empty")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        if raw in {"true", "false", "null"}:
            return {"true": True, "false": False, "null": None}[raw]
        try:
            return float(raw) if "." in raw else int(raw)
        except ValueError:
            if any(character in raw for character in "[]{}\"'#"):
                raise CatalogBuildError(
                    f"source line {line_number}: use JSON quoting for strings and arrays"
                )
            return raw


def parse_sources(contents: str) -> list[dict[str, Any]]:
    """Parse the manifest's small YAML subset without a YAML package dependency."""
    models: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    saw_models = False

    for line_number, line in enumerate(contents.splitlines(), start=1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line == "models:":
            if saw_models:
                raise CatalogBuildError("sources manifest has more than one models key")
            saw_models = True
            continue
        if line.startswith("  - "):
            if not saw_models:
                raise CatalogBuildError(f"source line {line_number}: expected models: first")
            current = {}
            models.append(current)
            field_text = line[4:]
        elif line.startswith("    ") and current is not None:
            field_text = line[4:]
        else:
            raise CatalogBuildError(
                f"source line {line_number}: expected a model entry or its indented fields"
            )

        if ":" not in field_text:
            raise CatalogBuildError(f"source line {line_number}: expected key: value")
        key, raw_value = field_text.split(":", 1)
        key = key.strip()
        if not key or key in current:
            raise CatalogBuildError(f"source line {line_number}: empty or duplicate key")
        current[key] = _parse_yaml_scalar(raw_value.strip(), line_number)

    if not saw_models or not models:
        raise CatalogBuildError("sources manifest must contain a non-empty models list")
    for index, model in enumerate(models, start=1):
        missing = SOURCE_FIELDS - model.keys()
        extra = model.keys() - SOURCE_FIELDS
        if missing or extra:
            raise CatalogBuildError(
                f"source model {index} has missing fields {sorted(missing)} "
                f"or unknown fields {sorted(extra)}"
            )
        if not isinstance(model["id"], str) or not re.fullmatch(
            r"[a-z0-9][a-z0-9._-]*", model["id"]
        ):
            raise CatalogBuildError(f"source model {index} has an invalid id")
        if not isinstance(model["gated"], bool) or model["gated"]:
            raise CatalogBuildError(
                f"source model {model['id']} must explicitly set gated: false"
            )
        for field in ("family", "name", "gguf_repo", "config_repo", "license_spdx", "license_url"):
            if not isinstance(model[field], str) or not model[field]:
                raise CatalogBuildError(f"source model {model['id']} requires {field}")
        if "/" not in model["gguf_repo"] or "/" not in model["config_repo"]:
            raise CatalogBuildError(f"source model {model['id']} repositories must be owner/name")
        if model["license_kind"] not in {"open_source", "open_weight"}:
            raise CatalogBuildError(f"source model {model['id']} has an invalid license_kind")
        if urlparse(model["license_url"]).scheme != "https":
            raise CatalogBuildError(f"source model {model['id']} license_url must use HTTPS")
        if model["params_b"] is not None and (
            not isinstance(model["params_b"], (int, float))
            or isinstance(model["params_b"], bool)
            or not 0 < model["params_b"] <= 1000
        ):
            raise CatalogBuildError(f"source model {model['id']} has invalid params_b")
        if not isinstance(model["tags"], list) or not all(
            isinstance(tag, str) and 0 < len(tag) <= 64 for tag in model["tags"]
        ):
            raise CatalogBuildError(f"source model {model['id']} tags must be strings")
        if not isinstance(model["verified"], bool):
            raise CatalogBuildError(f"source model {model['id']} verified must be a boolean")
        if not isinstance(model["added_at"], str):
            raise CatalogBuildError(f"source model {model['id']} added_at must be a date")
        try:
            date.fromisoformat(model["added_at"])
        except ValueError as error:
            raise CatalogBuildError(
                f"source model {model['id']} added_at must be an ISO date"
            ) from error
    ids = [model["id"] for model in models]
    if len(ids) != len(set(ids)):
        raise CatalogBuildError("sources manifest contains duplicate model ids")
    return models


def parse_config(config: dict[str, Any]) -> dict[str, int]:
    text_config = config.get("text_config")
    if isinstance(text_config, dict):
        config = {**config, **text_config}

    layers = config.get("num_hidden_layers")
    attention_heads = config.get("num_attention_heads")
    kv_heads = config.get("num_key_value_heads", attention_heads)
    head_dim = config.get("head_dim")
    if head_dim is None and isinstance(config.get("hidden_size"), int) and isinstance(
        attention_heads, int
    ):
        if attention_heads <= 0 or config["hidden_size"] % attention_heads:
            raise CatalogBuildError("config hidden_size is not divisible by num_attention_heads")
        head_dim = config["hidden_size"] // attention_heads
    context_max = config.get("max_position_embeddings")
    if context_max is None:
        context_max = config.get("max_seq_len")

    values = {
        "layers": layers,
        "kv_heads": kv_heads,
        "head_dim": head_dim,
        "context_max": context_max,
    }
    if not all(isinstance(value, int) and not isinstance(value, bool) for value in values.values()):
        raise CatalogBuildError("config is missing integer architecture metadata")
    return values


def select_quants(files: list[dict[str, Any]], repo: str, revision: str) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    for quant_name in QUANT_NAMES:
        matches = []
        for entry in files:
            filename = entry.get("path", "")
            if (
                not isinstance(filename, str)
                or not filename.lower().endswith(".gguf")
                or re.search(r"-\d{5}-of-\d{5}\.gguf$", filename, re.IGNORECASE)
                or not re.search(
                    rf"(?i)(?:^|[-_./]){re.escape(quant_name)}(?:[-_.]|$)", filename
                )
            ):
                continue
            lfs = entry.get("lfs")
            if not isinstance(lfs, dict):
                continue
            sha256 = str(lfs.get("oid", "")).removeprefix("sha256:")
            size_bytes = lfs.get("size", entry.get("size"))
            if not re.fullmatch(r"[a-fA-F0-9]{64}", sha256):
                continue
            if not isinstance(size_bytes, int) or size_bytes <= 0:
                continue
            matches.append(
                {
                    "name": quant_name,
                    "file": filename.rsplit("/", 1)[-1],
                    "size_bytes": size_bytes,
                    "sha256": sha256.lower(),
                    "url": f"{HF_ROOT}/{repo}/resolve/{revision}/{quote(filename, safe='/')}",
                }
            )
        if matches:
            selected.append(sorted(matches, key=lambda item: item["file"])[0])
    return selected


class HuggingFaceApi:
    def __init__(self, session: requests.Session | None = None) -> None:
        self.session = session or requests.Session()
        self.session.headers.update({"User-Agent": "Aangan-Catalog-Builder/1"})

    def get_json(self, url: str) -> Any:
        try:
            response = self.session.get(url, timeout=30)
            response.raise_for_status()
            return response.json()
        except requests.RequestException as error:
            raise CatalogBuildError(f"Hugging Face request failed for {url}: {error}") from error
        except ValueError as error:
            raise CatalogBuildError(f"Hugging Face returned invalid JSON for {url}") from error

    def model_info(self, repo: str) -> dict[str, Any]:
        data = self.get_json(f"{HF_ROOT}/api/models/{quote(repo, safe='/')}")
        if not isinstance(data, dict) or not isinstance(data.get("sha"), str):
            raise CatalogBuildError(f"model repository has no revision: {repo}")
        if data.get("private") or data.get("gated") is not False:
            raise CatalogBuildError(f"model repository must be public and ungated: {repo}")
        return data

    def repo_tree(self, repo: str, revision: str) -> list[dict[str, Any]]:
        next_url: str | None = (
            f"{HF_ROOT}/api/models/{quote(repo, safe='/')}/tree/"
            f"{quote(revision, safe='')}?{urlencode({'recursive': 'true', 'expand': 'false'})}"
        )
        entries: list[dict[str, Any]] = []
        while next_url:
            try:
                response = self.session.get(next_url, timeout=30)
                response.raise_for_status()
                data = response.json()
            except requests.RequestException as error:
                raise CatalogBuildError(
                    f"Hugging Face request failed for {repo} tree: {error}"
                ) from error
            except ValueError as error:
                raise CatalogBuildError(f"Hugging Face returned invalid tree JSON for {repo}") from error
            if not isinstance(data, list) or not all(isinstance(item, dict) for item in data):
                raise CatalogBuildError(f"Hugging Face returned an invalid file tree for {repo}")
            entries.extend(data)
            next_url = response.links.get("next", {}).get("url")
        return entries

    def config(self, repo: str) -> dict[str, Any]:
        info = self.model_info(repo)
        url = f"{HF_ROOT}/{repo}/resolve/{info['sha']}/config.json"
        data = self.get_json(url)
        if not isinstance(data, dict):
            raise CatalogBuildError(f"config.json must contain an object: {repo}")
        return data

    def discover(self, search: str) -> list[dict[str, Any]]:
        query = urlencode({"search": search, "filter": "gguf", "sort": "downloads", "direction": "-1", "limit": 20})
        data = self.get_json(f"{HF_ROOT}/api/models?{query}")
        if not isinstance(data, list):
            raise CatalogBuildError(f"Hugging Face returned an invalid discovery list for {search}")
        return [item for item in data if isinstance(item, dict)]


def build_model(source: dict[str, Any], api: HuggingFaceApi) -> dict[str, Any]:
    gguf_info = api.model_info(source["gguf_repo"])
    config = api.config(source["config_repo"])
    architecture = parse_config(config)
    files = api.repo_tree(source["gguf_repo"], gguf_info["sha"])
    quants = select_quants(files, source["gguf_repo"], gguf_info["sha"])
    if not quants:
        raise CatalogBuildError(
            f"no supported Q4_K_M, Q5_K_M, or Q8_0 GGUF files found: {source['gguf_repo']}"
        )
    return {
        "id": source["id"],
        "family": source["family"],
        "name": source["name"],
        "params_b": source["params_b"],
        "arch": architecture,
        "license": {
            "spdx": source["license_spdx"],
            "kind": source["license_kind"],
            "url": source["license_url"],
        },
        "gated": source["gated"],
        "tags": source["tags"],
        "quants": quants,
        "verified": source["verified"],
        "added_at": source["added_at"],
    }


def validate_catalog(catalog: dict[str, Any], schema_path: Path = SCHEMA_PATH) -> None:
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    _validate_schema_value(catalog, schema, schema, "$")
    model_ids = [model["id"] for model in catalog["models"]]
    if len(model_ids) != len(set(model_ids)):
        raise CatalogBuildError("catalog contains duplicate model ids")


def _validate_schema_value(
    value: Any, rule: dict[str, Any], root_schema: dict[str, Any], path: str
) -> None:
    reference = rule.get("$ref")
    if reference:
        resolved: Any = root_schema
        for part in reference.removeprefix("#/").split("/"):
            resolved = resolved[part.replace("~1", "/").replace("~0", "~")]
        _validate_schema_value(value, resolved, root_schema, path)
        return

    if "oneOf" in rule:
        matches = 0
        for alternative in rule["oneOf"]:
            try:
                _validate_schema_value(value, alternative, root_schema, path)
                matches += 1
            except CatalogBuildError:
                pass
        if matches != 1:
            raise CatalogBuildError(f"{path}: value must match exactly one schema alternative")

    expected_type = rule.get("type")
    if expected_type is not None:
        type_matches = {
            "object": isinstance(value, dict),
            "array": isinstance(value, list),
            "string": isinstance(value, str),
            "integer": isinstance(value, int) and not isinstance(value, bool),
            "number": isinstance(value, (int, float)) and not isinstance(value, bool),
            "boolean": isinstance(value, bool),
            "null": value is None,
        }.get(expected_type, False)
        if not type_matches:
            raise CatalogBuildError(f"{path}: expected {expected_type}")

    if "const" in rule and value != rule["const"]:
        raise CatalogBuildError(f"{path}: expected {rule['const']!r}")
    if "enum" in rule and value not in rule["enum"]:
        raise CatalogBuildError(f"{path}: value is not in the allowed set")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "exclusiveMinimum" in rule and value <= rule["exclusiveMinimum"]:
            raise CatalogBuildError(f"{path}: value must be greater than {rule['exclusiveMinimum']}")
        if "minimum" in rule and value < rule["minimum"]:
            raise CatalogBuildError(f"{path}: value is below minimum {rule['minimum']}")
        if "maximum" in rule and value > rule["maximum"]:
            raise CatalogBuildError(f"{path}: value exceeds maximum {rule['maximum']}")
    if isinstance(value, str):
        if len(value) < rule.get("minLength", 0) or len(value) > rule.get("maxLength", float("inf")):
            raise CatalogBuildError(f"{path}: string length is outside the allowed range")
        if "pattern" in rule and re.search(rule["pattern"], value) is None:
            raise CatalogBuildError(f"{path}: string does not match its required pattern")
        if rule.get("format") == "date-time":
            try:
                datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError as error:
                raise CatalogBuildError(f"{path}: invalid date-time") from error
        if rule.get("format") == "date":
            try:
                date.fromisoformat(value)
            except ValueError as error:
                raise CatalogBuildError(f"{path}: invalid date") from error
        if rule.get("format") == "uri":
            parsed = urlparse(value)
            if not parsed.scheme or not parsed.netloc:
                raise CatalogBuildError(f"{path}: invalid URI")
    if isinstance(value, list):
        if len(value) < rule.get("minItems", 0) or len(value) > rule.get("maxItems", float("inf")):
            raise CatalogBuildError(f"{path}: array length is outside the allowed range")
        if "items" in rule:
            for index, item in enumerate(value):
                _validate_schema_value(item, rule["items"], root_schema, f"{path}[{index}]")
    if isinstance(value, dict):
        if not set(rule.get("required", [])).issubset(value):
            raise CatalogBuildError(f"{path}: required fields are missing")
        properties = rule.get("properties", {})
        if rule.get("additionalProperties") is False and value.keys() - properties.keys():
            raise CatalogBuildError(f"{path}: unexpected fields: {sorted(value.keys() - properties.keys())}")
        for key, item in value.items():
            if key in properties:
                _validate_schema_value(item, properties[key], root_schema, f"{path}.{key}")


def _timestamp() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_catalog(
    sources: list[dict[str, Any]],
    api: HuggingFaceApi,
    previous: dict[str, Any] | None = None,
    schema_path: Path = SCHEMA_PATH,
) -> dict[str, Any]:
    models = sorted((build_model(source, api) for source in sources), key=lambda item: item["id"])
    unchanged = previous is not None and previous.get("models") == models
    catalog = {
        "schema": 1,
        "generated_at": previous["generated_at"] if unchanged else _timestamp(),
        "models": models,
    }
    validate_catalog(catalog, schema_path)
    return catalog


def write_catalog(path: Path, catalog: dict[str, Any], schema_path: Path = SCHEMA_PATH) -> None:
    if str(path).lower().endswith(".minisig"):
        raise CatalogBuildError("refusing to write a Minisign signature file")
    validate_catalog(catalog, schema_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as output:
        json.dump(catalog, output, ensure_ascii=False, indent=2, sort_keys=True)
        output.write("\n")


def discover_new_repos(sources: list[dict[str, Any]], api: HuggingFaceApi) -> list[dict[str, Any]]:
    existing_repos = {source["gguf_repo"].casefold() for source in sources}
    suggestions: list[dict[str, Any]] = []
    suggested_repos: set[str] = set()
    for family, search in FAMILY_SEARCH.items():
        for result in api.discover(search):
            repo = result.get("id")
            tags = result.get("tags", [])
            if (
                not isinstance(repo, str)
                or repo.casefold() in existing_repos
                or repo.casefold() in suggested_repos
                or result.get("private") is not False
                or not isinstance(tags, list)
                or "gguf" not in tags
            ):
                continue
            repo_detail = api.get_json(f"{HF_ROOT}/api/models/{quote(repo, safe='/')}")
            if (
                not isinstance(repo_detail, dict)
                or repo_detail.get("private") is not False
                or repo_detail.get("gated") is not False
            ):
                continue
            slug = re.sub(r"[^a-z0-9]+", "-", repo.casefold()).strip("-")
            license_tags = [tag.split(":", 1)[1] for tag in tags if tag.startswith("license:")]
            suggestions.append(
                {
                    "id": slug,
                    "family": family,
                    "name": repo.rsplit("/", 1)[-1],
                    "gguf_repo": repo,
                    "config_repo": "",
                    "params_b": None,
                    "license_spdx": license_tags[0] if license_tags else "LicenseRef-Unknown",
                    "license_kind": "open_weight",
                    "license_url": f"{HF_ROOT}/{repo}",
                    "gated": False,
                    "tags": ["chat"],
                    "verified": False,
                    "added_at": date.today().isoformat(),
                }
            )
            suggested_repos.add(repo.casefold())
    return suggestions


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, default=SOURCE_PATH)
    parser.add_argument("--output", type=Path, default=CATALOG_PATH)
    parser.add_argument("--schema", type=Path, default=SCHEMA_PATH)
    parser.add_argument("--summary-file", type=Path)
    parser.add_argument("--discover", action="store_true", help="print new public GGUF repo suggestions")
    parser.add_argument("--check", action="store_true", help="validate the catalog without contacting Hugging Face")
    args = parser.parse_args()
    try:
        if args.check:
            catalog = json.loads(args.output.read_text(encoding="utf-8"))
            validate_catalog(catalog, args.schema)
            print(f"Catalog schema is valid: {args.output}")
            return 0
        sources = parse_sources(args.sources.read_text(encoding="utf-8"))
        api = HuggingFaceApi()
        if args.discover:
            for suggestion in discover_new_repos(sources, api):
                print(json.dumps(suggestion, ensure_ascii=False, sort_keys=True))
            return 0

        previous = None
        if args.output.is_file():
            previous = json.loads(args.output.read_text(encoding="utf-8"))
        catalog = build_catalog(sources, api, previous, args.schema)
        if args.summary_file:
            previous_models = {
                item["id"]: item for item in (previous or {}).get("models", [])
            }
            current_models = {item["id"]: item for item in catalog["models"]}
            added = sorted(current_models.keys() - previous_models.keys())
            changed = sorted(
                model_id
                for model_id in current_models.keys() & previous_models.keys()
                if current_models[model_id] != previous_models[model_id]
            )
            removed = sorted(previous_models.keys() - current_models.keys())
            summary = ["Automated metadata refresh from the curated Hugging Face source list."]
            for label, model_ids in (("Added", added), ("Changed", changed), ("Removed", removed)):
                if model_ids:
                    summary.append(f"\n{label} models:\n" + "\n".join(f"- `{model_id}`" for model_id in model_ids))
            if not added and not changed and not removed:
                summary.append("\nNo model metadata changes detected.")
            summary.append(
                "\nNot mergeable until signed: run tools/catalog/sign.ps1 on the PR branch "
                "and push models.v1.json.minisig (git commit -s)."
            )
            with args.summary_file.open("w", encoding="utf-8", newline="\n") as output:
                output.write("\n".join(summary) + "\n")
        write_catalog(args.output, catalog, args.schema)
        print(f"Wrote {len(catalog['models'])} models to {args.output}")
        return 0
    except (CatalogBuildError, OSError, json.JSONDecodeError) as error:
        print(f"Catalog build failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
