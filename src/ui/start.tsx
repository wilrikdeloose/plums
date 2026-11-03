import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChatRunner } from "../core/ai/chatRunner";
import { DataController } from "../core/dataController";
import { CanvasService } from "../core/mcp/canvasService";
import type { Platform } from "../core/platform";
import { App } from "./App";
import { ConfirmProvider } from "./Confirm";
import { ServicesContext } from "./context";
import "./styles.css";

export function start(platform: Platform): void {
  const controller = new DataController(platform);
  const canvas = new CanvasService(
    controller,
    platform.mcp,
    platform.secrets,
    platform.capabilities.builtInMcp,
    platform.capabilities.canvasTestStudent === true,
  );
  const runner = new ChatRunner(platform, controller, () => new Date(), 120, canvas);
  const flush = () => void controller.flush().catch(() => undefined);
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ServicesContext.Provider value={{ platform, controller, runner, canvas }}>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </ServicesContext.Provider>
    </StrictMode>,
  );
  void controller.load();
}
