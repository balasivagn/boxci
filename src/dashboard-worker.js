import { App } from "./engine.js";
import { dashboardWorker } from "./dashboard-runtime.js";

dashboardWorker(() => new App());
