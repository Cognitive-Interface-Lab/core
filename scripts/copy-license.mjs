// Copies the repository's LICENSE into the package being packed. npm and pnpm pack only
// files inside the package folder, so each package's `prepack` runs this from its own folder.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.copyFileSync(path.join(root, "LICENSE"), path.join(process.cwd(), "LICENSE"));
