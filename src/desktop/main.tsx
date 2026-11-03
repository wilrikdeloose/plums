import { invoke } from "@tauri-apps/api/core";
import { start } from "../ui/start";
import { TEST_BUILD } from "../ui/testBuild";
import { NativeMcpClient } from "./nativeMcp";
import { NativeHttpTransport, OsSecretStore } from "./nativeNet";
import { TauriFileStore, tauriFiles } from "./tauriAdapters";

/** The Test Student exception is active only when the frontend flag and the native feature agree. */
async function detectTestStudent(): Promise<{ canvasTestStudent?: boolean; testBuildWarning?: string }> {
  if (!TEST_BUILD) return {};
  try {
    const status = await invoke<{ featureCompiled?: boolean; frontendAgrees?: boolean }>("canvas_test_mode_status");
    if (status.featureCompiled === true && status.frontendAgrees === true) return { canvasTestStudent: true };
    return {
      canvasTestStudent: false,
      testBuildWarning: "de native code is niet met --testmode=true gebouwd; Canvas Test Student blijft uitgeschakeld.",
    };
  } catch {
    return {
      canvasTestStudent: false,
      testBuildWarning: "de native code bevat de testmodus niet (frontend en native build komen niet overeen); Canvas Test Student blijft uitgeschakeld.",
    };
  }
}

void detectTestStudent().then((testCapabilities) =>
  start({
    id: "desktop",
    dataStore: new TauriFileStore(),
    files: tauriFiles,
    secrets: new OsSecretStore(),
    http: new NativeHttpTransport(),
    mcp: new NativeMcpClient(),
    capabilities: { builtInMcp: true, ...testCapabilities },
  }),
);
