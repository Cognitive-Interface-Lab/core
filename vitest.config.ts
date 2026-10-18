import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// A test run uses at most two cores (owner, 2026-10-17 and 2026-10-18). `maxWorkers` caps the test
// workers, but vitest's own process, its bundler and anything a test spawns run beside them. So on
// Linux the whole run is also pinned to two CPUs: workers and child processes inherit the pin.
const TEST_CORES = 2;
pinToCores(TEST_CORES);

/** Pins this process (every thread) to the first `count` CPUs it may use. Best effort. */
function pinToCores(count: number): void {
  if (process.platform !== "linux") return;
  try {
    const status = readFileSync("/proc/self/status", "utf8");
    const allowed = /^Cpus_allowed_list:\s*(\S+)/m.exec(status)?.[1];
    if (allowed === undefined) return;
    const cpus: number[] = [];
    for (const part of allowed.split(",")) {
      const [low, high] = part.split("-").map(Number);
      if (low === undefined) continue;
      for (let cpu = low; cpu <= (high ?? low); cpu++) cpus.push(cpu);
    }
    execFileSync("taskset", ["-a", "-p", "-c", cpus.slice(0, count).join(","), String(process.pid)], {
      stdio: "ignore",
    });
  } catch {
    // No taskset (util-linux) or no permission: the worker cap below still holds.
  }
}

export default defineConfig({
  resolve: {
    conditions: ["@core/source"],
  },
  ssr: {
    resolve: {
      conditions: ["@core/source"],
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
    passWithNoTests: true,
    maxWorkers: TEST_CORES,
  },
});
