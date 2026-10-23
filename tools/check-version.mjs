// Fails when any workspace crate, package.json or tauri.conf.json disagrees on the app version.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const json = (p) => JSON.parse(readFileSync(p, "utf8")).version;

export function findMismatches(found, want) {
  return Object.entries(found).filter(([, version]) => version !== want);
}

export function exitCodeForVersions(found, want) {
  return findMismatches(found, want).length > 0 ? 1 : 0;
}

function main() {
  const meta = JSON.parse(
    execSync("cargo metadata --locked --no-deps --format-version 1", {
      maxBuffer: 1 << 26,
    }).toString(),
  );

  const want = json("apps/desktop/package.json");
  const found = {
    "tauri.conf.json": json("apps/desktop/src-tauri/tauri.conf.json"),
    ...Object.fromEntries(meta.packages.map((p) => [`crate:${p.name}`, p.version])),
  };

  const bad = findMismatches(found, want);
  if (bad.length > 0) {
    console.error(`Version mismatch. package.json says ${want}, but:`);
    for (const [name, version] of bad) console.error(`  ${name} = ${version}`);
    process.exitCode = 1;
    return;
  }
  console.log(`All versions = ${want}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
