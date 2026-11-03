import { createContext, useContext, useSyncExternalStore } from "react";
import type { ChatRunner } from "../core/ai/chatRunner";
import type { DataController, DataSnapshot } from "../core/dataController";
import type { CanvasConnectionSnapshot, CanvasService } from "../core/mcp/canvasService";
import type { Platform } from "../core/platform";

export interface AppServices {
  platform: Platform;
  controller: DataController;
  runner: ChatRunner;
  canvas: CanvasService;
}

export const ServicesContext = createContext<AppServices | null>(null);

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("ServicesContext ontbreekt");
  return services;
}

export function useSnapshot(): DataSnapshot {
  const { controller } = useServices();
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot);
}

/** Conversation ids with a reply in progress. */
export function useRunning(): ReadonlySet<string> {
  const { runner } = useServices();
  return useSyncExternalStore(runner.subscribe, runner.getSnapshot);
}

export function useCanvasSnapshot(): CanvasConnectionSnapshot {
  const { canvas } = useServices();
  return useSyncExternalStore(canvas.subscribe, canvas.getSnapshot);
}
