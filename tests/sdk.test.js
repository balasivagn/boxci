import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Provider } from "../src/provider.js";
test("official SDK adapter uses native key authentication and passive GETs for paused VM discovery/validation", async () => {
  const calls = [];
  const mid = "m_" + "a".repeat(26);
  const machine = {
    id: mid,
    name: "ci-fixture",
    state: "suspended",
    runtime: { ready: false },
    createdAt: "2026-10-01T00:00:00Z",
    metadata: { purpose: "boxci" },
  };
  const server = http.createServer((req, res) => {
    calls.push({
      method: req.method,
      path: req.url,
      auth: req.headers["x-api-key"],
    });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url.startsWith("/v1/machines?")
          ? { machines: [machine] }
          : req.url === "/v1/usage"
            ? { machines: 1, limits: { maxMachines: 1 } }
            : machine,
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const provider = new Provider({
      environment: {
        INSTABOX_API_KEY: "ibk_fixture_only",
        INSTABOX_API_URL: `http://127.0.0.1:${server.address().port}`,
      },
      exec: async () => JSON.stringify({ userId: 7, login: "fixture" }),
    });
    const machines = await provider.list();
    assert.equal(machines[0].state, "suspended");
    assert.equal((await provider.usage()).limits.maxMachines, 1);
    await provider.validateKey("ibk_fixture_only", 7, mid);
    assert.ok(calls.length >= 4);
    assert.ok(calls.every((c) => c.method === "GET"));
    assert.ok(calls.every((c) => c.auth === "ibk_fixture_only"));
    assert.equal(
      calls.some((c) => c.path.includes("/resume")),
      false,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test("expired provider session enters native browser auth once and returns to the same operation", async () => {
  const calls = [];
  let who = 0;
  const provider = new Provider({
    interactive: true,
    exec: async (_, args, opts) => {
      calls.push({ args, opts });
      if (args[0] === "whoami") {
        who++;
        if (who === 1) throw new Error("not authenticated");
        return JSON.stringify({ userId: 7, login: "fixture" });
      }
      return "";
    },
  });
  const result = await provider.authenticate({ provider: "google" });
  assert.equal(result.userId, 7);
  assert.equal(calls.filter((c) => c.args[0] === "login").length, 1);
  assert.equal(calls[1].opts.interactive, true);
  assert.deepEqual(calls[1].args, ["login", "--provider", "google"]);
  assert.equal(who, 2);
});
test("cancelled native auth is surfaced without looping or reopening the browser", async () => {
  let logins = 0;
  const provider = new Provider({
    interactive: true,
    exec: async (_, args) => {
      if (args[0] === "whoami") throw new Error("not authenticated");
      logins++;
      throw new Error("user cancelled sign-in");
    },
  });
  await assert.rejects(provider.authenticate(), /cancelled/);
  assert.equal(logins, 1);
});
