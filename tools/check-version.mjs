// Fails when any workspace crate, package.json or tauri.conf.json disagrees on the app version.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const json = (p) => JSON.parse(readFileSync(p, "utf8")).version;

const meta = JSON.parse(
  execSync("cargo metadata --no-deps --format-version 1", { maxBuffer: 1 << 26 }).toString(),
);

const want = json("apps/desktop/package.json");
const found = {
  "tauri.conf.json": json("apps/desktop/src-tauri/tauri.conf.json"),
  ...Object.fromEntries(meta.packages.map((p) => [`crate:${p.name}`, p.version])),
};

const bad = Object.entries(found).filter(([, v]) => v !== want);
if (bad.length > 0) {
  console.error(`Version mismatch. package.json says ${want}, but:`);
  for (const [name, v] of bad) console.error(`  ${name} = ${v}`);
  process.exit(1);
}
console.log(`All versions = ${want}`);
