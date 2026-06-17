#!/usr/bin/env node
// `claude-wrap` entry. A reserved verb as the first word runs an
// instance-management command (new/list/ask/status/stop/…); anything else
// opens a Claude window in the current directory, exactly as before. See
// ./cli/dispatch for the routing rules.

import * as path from "path";
import { main } from "./cli/dispatch";

// Resolve dist/wrapper.js from the dist root (this file compiles to
// dist/launch.js, so __dirname is dist/) and hand it to the dispatcher — the
// command module lives under dist/cli/ and must not resolve it relative to
// itself.
const wrapperJs = path.join(__dirname, "wrapper.js");

void main(process.argv.slice(2), { bin: "claude-wrap", wrapperJs });
