#!/usr/bin/env node
// Starts Tauri dev/build with an explicit, validated test-mode build option.
// Usage: node scripts/desktop.mjs <dev|build> [--testmode=true|--testmode=false]
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const TEST_FEATURE = "canvas-test-mode";

/** Returns true/false for a valid `--testmode` option (omitted means false); throws on anything else. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "dev" && command !== "build") {
    throw new Error(`Onbekend commando "${command ?? ""}". Gebruik "dev" of "build".`);
  }
  let testMode = false;
  let seen = false;
  for (const arg of rest) {
    const match = /^--testmode=(.*)$/.exec(arg);
    if (!match) {
      throw new Error(`Onbekende optie "${arg}". Alleen --testmode=true of --testmode=false is toegestaan.`);
    }
    if (seen) throw new Error("--testmode mag maar één keer worden opgegeven.");
    seen = true;
    if (match[1] === "true") testMode = true;
    else if (match[1] === "false") testMode = false;
    else throw new Error(`Ongeldige waarde "--testmode=${match[1]}". Gebruik exact true of false.`);
  }
  return { command, testMode };
}

export function tauriArgs(command, testMode) {
  const args = command === "build" ? ["build", "--no-bundle"] : ["dev"];
  if (testMode) args.push("--features", TEST_FEATURE);
  return args;
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`PLuMS: ${error.message}`);
    process.exit(2);
  }
  const { command, testMode } = parsed;
  const tauriCli = createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js");
  const args = tauriArgs(command, testMode);
  // Always set explicitly so an inherited shell or .env value can never switch the frontend on by accident.
  const env = { ...process.env, VITE_PLUMS_TESTMODE: testMode ? "true" : "false" };

  console.log(
    `PLuMS ${command === "dev" ? "desktop-dev" : "desktop-build"} · testmodus: ${testMode ? "AAN (Canvas Test Student)" : "uit"} · tauri ${args.join(" ")}`,
  );
  const child = spawn(process.execPath, [tauriCli, ...args], { stdio: "inherit", env });
  const forward = (signal) => child.kill(signal);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
