// Builds the @core/* consumer packages, packs them into packs/ with a manifest,
// and with --check proves the tarballs install in a clean directory and load three ways:
// import() from ES modules, require() from CommonJS, and a TypeScript 5.9 type check
// under module commonjs + moduleResolution node (how Trilix's tools and tests load them).
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
// One named export per package root, imported by the type check (TS2305 if it goes missing).
const TYPE_PROBES = {
  "@core/contracts": "CoreError",
  "@core/models": "MockProvider",
  "@core/tools": "defineTool",
  "@core/graph": "ProcessGraph",
  "@core/graph-postgres": "graphEvents",
  "@core/runtime": "replayBranch",
  "@core/server": "httpStatus",
  "@core/client": "createCoreClient",
};
const TYPESCRIPT = "~5.9.3";
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

// check.mjs and check.cjs differ only in how they load a name.
function loaderScript(load) {
  return `const names = ${JSON.stringify(IMPORTS)};
let failed = 0;
for (const name of names) {
  try {
    ${load};
    console.log(\`ok \${name}\`);
  } catch (err) {
    failed++;
    console.log(\`failed \${name}: \${String(err?.message ?? err).split("\\n").join(" ")}\`);
  }
}
process.exitCode = failed ? 1 : 0;
`;
}

function typeProbeScript() {
  const entries = Object.entries(TYPE_PROBES);
  const imports = entries.map(([name, ident], i) => `import { ${ident} as probe${i} } from "${name}";`);
  const uses = entries.map((_, i) => `probe${i}`).join(", ");
  return `${imports.join("\n")}\nexport const probes: unknown[] = [${uses}];\n`;
}

const TSCONFIG = {
  compilerOptions: {
    module: "commonjs",
    moduleResolution: "node",
    target: "ES2022",
    strict: true,
    skipLibCheck: true,
  },
  files: ["check.ts"],
};

// Runs a loader script in the temp project and returns a failure summary, or null.
function runLoader(tmp, label, file) {
  console.log(`${label}:`);
  const r = spawnSync("node", [file], { cwd: tmp, encoding: "utf8", maxBuffer: MAX_BUFFER });
  if (r.error) throw new StepError(`${label} failed to start: ${r.error.message}`);
  process.stdout.write(r.stdout);
  if (r.status === 0) return null;
  const failedNames = r.stdout
    .split("\n")
    .map((line) => /^failed (\S+):/.exec(line)?.[1])
    .filter(Boolean);
  return `${label} failed: ${failedNames.join(", ") || `exit ${r.status}`}`;
}

function runTypeCheck(tmp) {
  const label = "type check";
  console.log(`${label}:`);
  const tsc = path.join(tmp, "node_modules", "typescript", "bin", "tsc");
  const r = spawnSync("node", [tsc, "--noEmit", "--pretty", "false", "-p", "tsconfig.json"], {
    cwd: tmp,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  if (r.error) throw new StepError(`${label} failed to start: ${r.error.message}`);
  if (r.status === 0) {
    console.log(`ok ${Object.keys(TYPE_PROBES).join(" ")}`);
    return null;
  }
  const errors = r.stdout.split("\n").filter((line) => /error TS\d+:/.test(line));
  for (const line of errors) console.log(line);
  return `${label} failed: ${errors.length || `exit ${r.status}`} error(s)`;
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
      devDependencies: { typescript: TYPESCRIPT },
      overrides,
    };
    fs.writeFileSync(path.join(tmp, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

    run("npm install", "npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], tmp);

    fs.writeFileSync(path.join(tmp, "check.mjs"), loaderScript("await import(name)"));
    fs.writeFileSync(path.join(tmp, "check.cjs"), loaderScript("require(name)"));
    fs.writeFileSync(path.join(tmp, "check.ts"), typeProbeScript());
    fs.writeFileSync(path.join(tmp, "tsconfig.json"), `${JSON.stringify(TSCONFIG, null, 2)}\n`);

    const failures = [
      runLoader(tmp, "import check", "check.mjs"),
      runLoader(tmp, "require check", "check.cjs"),
      runTypeCheck(tmp),
    ].filter(Boolean);
    if (failures.length) throw new StepError(failures.join("; "));
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
