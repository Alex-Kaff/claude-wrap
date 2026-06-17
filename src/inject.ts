#!/usr/bin/env node
// `claude-wrap-inject` entry. Strict verb dispatch (no window-launch
// fallthrough), preserving the contract the MCP server relies on
// (`--pipe … parse-status`, `key`, `approve`, `deny`). Shares all command
// implementations with the `claude-wrap` bin via ./cli/dispatch.

import * as path from "path";
import { main } from "./cli/dispatch";

const wrapperJs = path.join(__dirname, "wrapper.js");

void main(process.argv.slice(2), { bin: "inject", wrapperJs });
