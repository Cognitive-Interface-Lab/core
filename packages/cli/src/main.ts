#!/usr/bin/env node
import { createNodeIo } from "./io.js";
import { run } from "./run.js";

process.exitCode = await run(process.argv.slice(2), createNodeIo());
