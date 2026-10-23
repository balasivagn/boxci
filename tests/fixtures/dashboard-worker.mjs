import { dashboardWorker } from "../../src/dashboard-runtime.js";

dashboardWorker(() => ({
  status: async ({ repo }) => ({
    repo,
    members: [],
    account: { login: "fixture" },
    quota: { used: 0, max: 5 },
    jobs: [],
    label: "dedicated-fixture",
    checked_at: new Date().toISOString(),
  }),
}));
