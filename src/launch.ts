#!/usr/bin/env node
// Launcher: opens a new terminal window running the wrapper at the current
// working directory. The wrapper spawns `claude` inside a ConPTY.
//
// All extra argv is forwarded to `claude`, so flags like
// `--dangerously-skip-permissions` work end-to-end.

import { spawn } from "child_process";
import * as path from "path";
import { makePipeName } from "./registry";
import { quoteCmdArg } from "./cmd-quote";

function launchWindow(
  title: string,
  commandLine: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): void {
  // `start "title" cmd /k <command>` opens a new console window.
  // The first quoted argument to `start` is the window title — it MUST be
  // present, otherwise start interprets a quoted command as the title.
  const args = ["/c", "start", `"${title}"`, "cmd", "/k", commandLine];
  spawn("cmd.exe", args, {
    cwd,
    env,
    detached: true,
    stdio: "ignore",
    windowsVerbatimArguments: true,
  }).unref();
}

function main(): void {
  // When invoked via `pnpm start` / `npm start`, process.cwd() is the package
  // root. The caller's original directory is exposed via INIT_CWD. When the
  // binary is invoked directly from PATH, INIT_CWD is unset and cwd is correct.
  const cwd = process.env["INIT_CWD"] ?? process.cwd();
  const wrapperJs = path.join(__dirname, "wrapper.js");
  const forwarded = process.argv.slice(2).map(quoteCmdArg).join(" ");

  // Use the current Node binary rather than "node" on PATH so version
  // managers (nvm/fnm/volta) don't hand the new console window a
  // different Node than the one running this launcher.
  const nodeBin = quoteCmdArg(process.execPath);
  const wrapCmd = `${nodeBin} ${quoteCmdArg(wrapperJs)}${forwarded ? " " + forwarded : ""}`;

  // Mint a unique pipe name per launch so multiple instances can coexist.
  // Both windows inherit CLAUDE_WRAP_PIPE via the env we pass to start,
  // so `inject` in the shell window talks to the matching wrapper by default.
  const pipeName = makePipeName();
  const label = path.basename(cwd) || "wrap";
  const env = {
    ...process.env,
    CLAUDE_WRAP_PIPE: pipeName,
    CLAUDE_WRAP_LABEL: label,
  };

  launchWindow("Claude (wrapped)", wrapCmd, cwd, env);

  // Nothing to keep the launcher alive for.
  process.exit(0);
}

main();
