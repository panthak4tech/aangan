import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  checkNoticesFile,
  NOTICES_OUT_OF_DATE_MESSAGE,
} from "./generate-notices.mjs";
import { javascriptNotices } from "./notices-data.mjs";

function withNoticesFile(contents, run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "aangan-notices-test-"));
  const filePath = path.join(directory, "THIRD_PARTY_NOTICES.md");
  writeFileSync(filePath, contents);
  try {
    return run(filePath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("notices check accepts current content without modifying the file", () => {
  const generated = "# Current notices\n";
  const committed = "# Current notices\r\n";
  const messages = { errors: [], logs: [] };

  withNoticesFile(committed, (filePath) => {
    const status = checkNoticesFile(generated, filePath, {
      error: (message) => messages.errors.push(message),
      log: (message) => messages.logs.push(message),
    });

    assert.equal(status, 0);
    assert.deepEqual(messages.errors, []);
    assert.deepEqual(messages.logs, ["THIRD_PARTY_NOTICES.md is up to date."]);
    assert.equal(readFileSync(filePath, "utf8"), committed);
  });
});

test("notices check reports stale content and returns failure without modifying the file", () => {
  const generated = "# Current notices\n";
  const committed = "# Old notices\n";
  const errors = [];

  withNoticesFile(committed, (filePath) => {
    const status = checkNoticesFile(generated, filePath, {
      error: (message) => errors.push(message),
      log: () => assert.fail("stale notices must not be reported as current"),
    });

    assert.equal(status, 1);
    assert.deepEqual(errors, [NOTICES_OUT_OF_DATE_MESSAGE]);
    assert.equal(readFileSync(filePath, "utf8"), committed);
  });
});

test("javascript notices use a matching checked-in license override", () => {
  const licenseText = "MIT License\n\nCopyright (c) 2020-present LongYinan";
  const notices = javascriptNotices(
    {
      "@napi-rs/wasm-runtime@1.2.2": {
        licenses: "MIT",
        repository: "https://github.com/napi-rs/napi-rs",
      },
    },
    "desktop",
    new Map(),
    (filePath) => {
      assert.equal(filePath, "napi-rs-MIT.txt");
      return licenseText;
    },
    new Map([
      [
        "@napi-rs/wasm-runtime",
        { license: "MIT", file: "napi-rs-MIT.txt" },
      ],
    ]),
  );

  assert.deepEqual(notices, [
    {
      name: "@napi-rs/wasm-runtime",
      version: "1.2.2",
      license: "MIT",
      repository: "https://github.com/napi-rs/napi-rs",
      text: licenseText,
    },
  ]);
});

test("javascript notices reject an override when the declared license differs", () => {
  assert.throws(
    () => javascriptNotices(
      {
        "@napi-rs/wasm-runtime@1.2.2": {
          licenses: "Apache-2.0",
          repository: "https://github.com/napi-rs/napi-rs",
        },
      },
      "desktop",
      new Map(),
      () => assert.fail("mismatched license text must not be read"),
      new Map([
        ["@napi-rs/wasm-runtime", { license: "MIT", file: "napi-rs-MIT.txt" }],
      ]),
    ),
    /No license file found for JavaScript dependency @napi-rs\/wasm-runtime@1\.2\.2/,
  );
});
