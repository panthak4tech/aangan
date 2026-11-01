# Catalog generation

`catalog/sources.yml` is the hand-curated allow-list for the desktop catalog.
It is YAML using the JSON-compatible scalar subset so the Python 3.12 builder
can read it without adding a YAML dependency. Entries identify public,
ungated GGUF mirrors and their model configuration repositories. Add new
entries only after reviewing the model and its license. `verified: false`
means the metadata has not yet received that maintainer review.
The seven existing Qwen2.5 entries are retained as-is in the source list, even
though they exceed the 3–5 seed size used for each newly added family.

## Build and check

Install the sole runtime dependency and build from the repository root:

```powershell
python -m pip install -r tools/catalog/requirements.txt
python tools/catalog/build_catalog.py
python tools/catalog/build_catalog.py --check
python -m pip install -r tools/catalog/requirements-dev.txt
python -m pytest tools/catalog/test_build_catalog.py
```

The builder reads repository trees and `config.json` files from Hugging Face,
selects available Q4_K_M, Q5_K_M, and Q8_0 GGUF files, validates its output
against `catalog/schema.v1.json`, and writes deterministic UTF-8 JSON with LF
line endings. `generated_at` changes only when catalog data changes. It never
writes or updates the `.minisig` signature.

To explore public GGUF repositories not already in the allow-list:

```powershell
python tools/catalog/build_catalog.py --discover
```

Discovery prints suggestions only. It never edits `sources.yml`; verify each
repository, its access requirements, config, and license before curating an
entry.

## Weekly refresh pull requests

The weekly GitHub Actions workflow can also be run manually from the Actions
tab. It only proposes catalog changes; it does not sign or merge them. The
default `GITHUB_TOKEN` creates approval-required `pull_request` workflow runs
when it opens or updates a pull request (`opened`, `synchronize`, or `reopened`
events). A maintainer with write access can select **Approve workflows to run**
in the pull request's merge box to start CI. See GitHub's
[workflow triggering documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow).

Before merging, a maintainer must also run `tools/catalog/sign.ps1` on that
branch, commit the refreshed catalog signature with `git commit -s`, and push
the signed commit.
