// Builds the @core/* consumer packages, packs them into packs/ with a manifest,
// and with --check proves the tarballs install and import from a clean directory.
import { spawnSync } from "node:child_process";
import console from "node:console";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKS = path.join(ROOT, "packs");
const PACKAGES_DIR = path.join(ROOT, "packages");
const CONSUMERS = [
  "@core/contracts",
  "@core/models",
  "@core/tools",
  "@core/graph",
  "@core/graph-postgres",
  "@core/runtime",
  "@core/server",
  "@core/client",
];
const IMPORTS = [...CONSUMERS, "@core/server/node"];
const CHECK = process.argv.includes("--check");
const MAX_BUFFER = 64 * 1024 * 1024;

class StepError extends Error {}

function run(step, cmd, args, cwd = ROOT) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER });
  if (r.error || r.status !== 0) {
    const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd().split("\n").slice(-40).join("\n");
    if (tail) console.error(tail);
    throw new StepError(`${step} failed${r.error ? `: ${r.error.message}` : ` (exit ${r.status})`}`);
  }
  return r.stdout;
}

function findPackageDirs() {
  const byName = new Map();
  for (const entry of fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(PACKAGES_DIR, entry.name);
    const manifestPath = path.join(dir, "package.json");
    if (!fs.existsSync(manifestPath)) continue;
    const { name } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    byName.set(name, dir);
  }
  return byName;
}

function packAll() {
  const dirs = findPackageDirs();
  fs.rmSync(PACKS, { recursive: true, force: true });
  fs.mkdirSync(PACKS, { recursive: true });

  const packages = [];
  for (const name of CONSUMERS) {
    const dir = dirs.get(name);
    if (!dir) throw new StepError(`pack: no package named ${name} under packages/`);
    const { version } = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const file = `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
    const tarball = path.join(PACKS, file);

    run(`pack ${name}`, "pnpm", ["pack", "--silent", "--out", tarball], dir);
    if (!fs.existsSync(tarball)) throw new StepError(`pack ${name} produced no ${file}`);

    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
    packages.push({ name, version, file, sha256 });
  }

  packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  fs.writeFileSync(
    path.join(PACKS, "manifest.json"),
    `${JSON.stringify({ packages }, null, 2)}\n`,
  );
  console.log(`packed ${packages.length} packages into packs/ (manifest: packs/manifest.json)`);
  return packages;
}

function check(packages) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "core-pack-check-"));
  try {
    const specs = Object.fromEntries(
      packages.map((p) => [p.name, `file:${path.join(PACKS, p.file)}`]),
    );
    const overrides = Object.fromEntries(
      packages.filter((p) => p.name.startsWith("@core/")).map((p) => [p.name, specs[p.name]]),
    );
    const pkg = {
      name: "core-pack-check",
      private: true,
      type: "module",
      dependencies: specs,
      overrides,
    };
    fs.writeFileSync(path.join(tmp, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

    run("npm install", "npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], tmp);

    fs.writeFileSync(
      path.join(tmp, "check.mjs"),
      `const names = ${JSON.stringify(IMPORTS)};
let failed = 0;
for (const name of names) {
  try {
    await import(name);
    console.log(\`ok \${name}\`);
  } catch (err) {
    failed++;
    console.log(\`failed \${name}: \${String(err?.message ?? err).split("\\n").join(" ")}\`);
  }
}
process.exitCode = failed ? 1 : 0;
`,
    );

    const r = spawnSync("node", ["check.mjs"], { cwd: tmp, encoding: "utf8", maxBuffer: MAX_BUFFER });
    if (r.error) throw new StepError(`import check failed to start: ${r.error.message}`);
    process.stdout.write(r.stdout);
    if (r.status !== 0) {
      const failedNames = r.stdout
        .split("\n")
        .map((line) => /^failed (\S+):/.exec(line)?.[1])
        .filter(Boolean);
      throw new StepError(`import check failed: ${failedNames.join(", ") || `exit ${r.status}`}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  run("build", "pnpm", ["build"]);
  const packages = packAll();
  if (CHECK) check(packages);
}

main().catch((err) => {
  console.error(`pack-consumers: ${err.message}`);
  process.exitCode = 1;
});
