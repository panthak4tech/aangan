import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  javascriptNotices,
  mergeNotices,
  normalizeLicenseText,
  sortNotices,
} from "./notices-data.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const desktopDirectory = path.join(repositoryRoot, "apps", "desktop");
const outputDirectory = path.join(desktopDirectory, "src", "assets");
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

function rustNotices(cargoData) {
  const licenseTexts = new Map(
    cargoData.licenses.map(({ id, text }) => [id, normalizeLicenseText(text)]),
  );

  return cargoData.crates.map(({ package: crate, license }) => {
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

function renderMarkdown(notices) {
  const sections = notices.map(
    ({ name, version, license, repository, text }) =>
      `## ${name} ${version}\n\nLicense: ${license}\n\nRepository: ${repository}\n\n\`\`\`text\n${text}\n\`\`\``,
  );
  return [
    "# Third-party notices",
    "",
    "Aangan is licensed under MIT. The complete license texts for Aangan and its dependencies follow.",
    "",
    ...sections,
    "",
  ].join("\n");
}

try {
  runCargoAbout();
  const cargoData = JSON.parse(readFileSync(rustOutputPath, "utf8"));
  const licenseData = runLicenseChecker();
  const aanganPackage = JSON.parse(
    readFileSync(path.join(desktopDirectory, "package.json"), "utf8"),
  );
  const ownLicense = {
    name: "Aangan",
    version: aanganPackage.version,
    license: "MIT",
    repository: "https://github.com/panthak4tech/aangan",
    text: normalizeLicenseText(readFileSync(path.join(repositoryRoot, "LICENSE"), "utf8")),
  };
  const notices = sortNotices(
    mergeNotices(
      rustNotices(cargoData),
      javascriptNotices(
        licenseData,
        aanganPackage.name,
        fontNames,
        (licenseFile) => readFileSync(licenseFile, "utf8"),
      ),
      [ownLicense],
    ),
  );

  writeFileSync(
    path.join(outputDirectory, "third-party-notices.json"),
    `${JSON.stringify(notices, null, 2)}\n`,
  );
  writeFileSync(path.join(repositoryRoot, "THIRD_PARTY_NOTICES.md"), renderMarkdown(notices));
  console.log(`Generated notices for ${notices.length} components.`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
