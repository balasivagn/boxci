import { DashboardManager } from "../../src/dashboard-manager.js";
const manager = new DashboardManager({
  directory: process.env.BOXCI_HOME,
  worker: new URL("./dashboard-worker.mjs", import.meta.url),
  timeout: 10000,
});
const app = {
  github: { repo: async (repo) => repo || "acme/project" },
  status: () => {
    throw new Error("Controller must not query cloud state");
  },
};
const command = process.argv[2] || "start";
try {
  const result = await manager[command](app, {
    repo: "acme/project",
    "no-open": true,
  });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
