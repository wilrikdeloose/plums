import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const targets = {
  web: { entry: "/src/web/main.tsx", port: 1420, outDir: "dist/web" },
  desktop: { entry: "/src/desktop/main.tsx", port: 1421, outDir: "dist/desktop" },
} as const;

type Target = keyof typeof targets;

function platformEntry(entry: string): Plugin {
  return {
    name: "plums-platform-entry",
    transformIndexHtml: {
      order: "pre",
      handler: (html) => html.replace("%PLUMS_ENTRY%", entry),
    },
  };
}

export default defineConfig(({ mode }) => {
  if (mode !== "web" && mode !== "desktop") {
    throw new Error(`Onbekende modus "${mode}". Gebruik --mode web of --mode desktop.`);
  }
  const target = targets[mode as Target];
  // Set by scripts/desktop.mjs; the web build never includes the test feature.
  // Read the process environment only (not .env files).
  const processEnv = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
  const testMode = mode === "desktop" && processEnv?.VITE_PLUMS_TESTMODE === "true" ? "true" : "false";
  return {
    plugins: [react(), platformEntry(target.entry)],
    define: { "import.meta.env.VITE_PLUMS_TESTMODE": JSON.stringify(testMode) },
    clearScreen: false,
    server: {
      port: target.port,
      strictPort: true,
      host: "localhost",
      watch: { ignored: ["**/src-tauri/**"] },
    },
    preview: { port: target.port + 10, strictPort: true, host: "localhost" },
    envPrefix: ["VITE_"],
    build: {
      outDir: target.outDir,
      emptyOutDir: true,
      target: "es2022",
    },
  };
});
