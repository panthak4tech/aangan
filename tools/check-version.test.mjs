import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { exitCodeForVersions, findMismatches } from "./check-version.mjs";

describe("version checker", () => {
  it("accepts matching versions", () => {
    assert.deepEqual(
      findMismatches(
        { "tauri.conf.json": "0.3.1", "crate:aangan-cli": "0.3.1" },
        "0.3.1",
      ),
      [],
    );
    assert.equal(exitCodeForVersions({ "crate:aangan-cli": "0.3.1" }, "0.3.1"), 0);
  });

  it("reports a mismatched Tauri version", () => {
    assert.deepEqual(findMismatches({ "tauri.conf.json": "0.3.0" }, "0.3.1"), [
      ["tauri.conf.json", "0.3.0"],
    ]);
  });

  it("reports a mismatched Cargo package version", () => {
    assert.deepEqual(findMismatches({ "crate:aangan-cli": "0.1.0" }, "0.3.1"), [
      ["crate:aangan-cli", "0.1.0"],
    ]);
  });

  it("reports every version that differs from package.json", () => {
    assert.deepEqual(
      findMismatches(
        {
          "tauri.conf.json": "0.3.0",
          "crate:aangan-cli": "0.1.0",
          "crate:aangan-types": "0.1.0",
        },
        "0.3.1",
      ),
      [
        ["tauri.conf.json", "0.3.0"],
        ["crate:aangan-cli", "0.1.0"],
        ["crate:aangan-types", "0.1.0"],
      ],
    );
  });

  it("returns a failing process status for fixture mismatches", () => {
    const checkerUrl = new URL("./check-version.mjs", import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { exitCodeForVersions } from ${JSON.stringify(checkerUrl)}; process.exitCode = exitCodeForVersions({ "crate:aangan-cli": "0.1.0" }, "0.3.1");`,
      ],
      { encoding: "utf8" },
    );

    assert.equal(child.status, 1, child.stderr);
  });
});
