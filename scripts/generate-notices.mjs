import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  excludeWorkspacePackages,
  javascriptNotices,
  mergeNotices,
  normalizeLineEndings,
  normalizeLicenseText,
  renderMarkdown,
  sortNotices,
} from "./notices-data.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const desktopDirectory = path.join(repositoryRoot, "apps", "desktop");
const noticesPath = path.join(repositoryRoot, "THIRD_PARTY_NOTICES.md");
const checkMode = process.argv.includes("--check");
const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "aangan-notices-"));
const rustOutputPath = path.join(temporaryDirectory, "rust-notices.json");
const licenseCheckerPath = path.join(
  desktopDirectory,
  "node_modules",
  "license-checker-rseidelsohn",
  "bin",
  "license-checker-rseidelsohn.js",
);
const fontNames = new Map([
  ["@fontsource-variable/manrope", "Manrope"],
  ["@fontsource-variable/inter", "Inter"],
  ["@fontsource-variable/jetbrains-mono", "JetBrains Mono"],
  ["@fontsource-variable/noto-sans-devanagari", "Noto Sans Devanagari"],
]);

function runCargoAbout() {
  const result = spawnSync(
    "cargo",
    [
      "about",
      "generate",
      "--workspace",
      "--format",
      "json",
      "--locked",
      "--config",
      "about.toml",
      "--output-file",
      rustOutputPath,
    ],
    { cwd: repositoryRoot, encoding: "utf8", stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`cargo about failed with exit code ${result.status}`);
}

function getWorkspacePackages() {
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--locked", "--no-deps", "--format-version", "1"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 1 << 26,
    }),
  );
  return new Set(metadata.packages.map(({ name }) => name));
}

function runLicenseChecker() {
  try {
    return JSON.parse(
      execFileSync(process.execPath, [licenseCheckerPath, "--production", "--json"], {
        cwd: desktopDirectory,
        encoding: "utf8",
      }),
    );
  } catch (error) {
    throw new Error(`license-checker-rseidelsohn failed: ${error.message}`, { cause: error });
  }
}

function rustNotices(cargoData, workspacePackages) {
  const licenseTexts = new Map(
    cargoData.licenses.map(({ id, text }) => [id, normalizeLicenseText(text)]),
  );

  return excludeWorkspacePackages(cargoData.crates, workspacePackages).map(({ package: crate, license }) => {
    const expression = license ?? "";
    const identifiers = [...licenseTexts.keys()]
      .sort((left, right) => right.length - left.length)
      .filter((id) => new RegExp(`(^|[^A-Za-z0-9.-])${escapeRegExp(id)}($|[^A-Za-z0-9.-])`).test(expression));
    if (identifiers.length === 0) {
      throw new Error(`No license text found for Rust dependency ${crate.name} (${expression})`);
    }
    return {
      name: crate.name,
      version: crate.version,
      license: expression,
      repository: crate.repository ?? `https://crates.io/crates/${crate.name}`,
      text: identifiers.map((id) => licenseTexts.get(id)).join("\n\n"),
    };
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

try {
  runCargoAbout();
  const cargoData = JSON.parse(readFileSync(rustOutputPath, "utf8"));
  const licenseData = runLicenseChecker();
  const aanganPackage = JSON.parse(
    readFileSync(path.join(desktopDirectory, "package.json"), "utf8"),
  );
  const workspacePackages = getWorkspacePackages();
  const notices = sortNotices(
    mergeNotices(
      rustNotices(cargoData, workspacePackages),
      javascriptNotices(
        licenseData,
        aanganPackage.name,
        fontNames,
        (licenseFile) => readFileSync(licenseFile, "utf8"),
      ),
    ),
  );
  const generated = renderMarkdown(notices);

  if (checkMode) {
    const committed = readFileSync(noticesPath, "utf8");
    if (normalizeLineEndings(generated) !== normalizeLineEndings(committed)) {
      console.error(
        "THIRD_PARTY_NOTICES.md is out of date. Run `npm run notices` in apps/desktop and commit.",
      );
      process.exitCode = 1;
    } else {
      console.log("THIRD_PARTY_NOTICES.md is up to date.");
    }
  } else {
    writeFileSync(noticesPath, generated);
    console.log(`Generated notices for ${notices.length} third-party components.`);
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
