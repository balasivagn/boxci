import test from "node:test";
import assert from "node:assert/strict";
import { serveDashboard } from "../src/dashboard.js";
test("dashboard enforces local host, browser authorization, same origin and read-only routes", async () => {
  let reads = 0;
  const live = await serveDashboard(
    {
      status: async () => {
        reads++;
        return { repo: "acme/project", members: [] };
      },
    },
    { repo: "acme/project" },
  );
  try {
    assert.equal((await fetch(live.origin + "/api/status")).status, 401);
    const session = await fetch(live.origin + "/api/session", {
      method: "POST",
      headers: { Origin: live.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ token: live.token }),
    });
    assert.equal(session.status, 200);
    assert.match(
      session.headers.get("set-cookie"),
      /HttpOnly; SameSite=Strict/,
    );
    const cookie = session.headers.get("set-cookie").split(";")[0];
    const response = await fetch(live.origin + "/api/status", {
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).repo, "acme/project");
    assert.equal(reads, 1);
    assert.equal(
      (
        await fetch(live.origin + "/api/status", {
          headers: { Cookie: cookie, Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(live.origin + "/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: live.token }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(live.origin + "/api/wake", {
          method: "POST",
          headers: { Cookie: cookie, Origin: live.origin },
        })
      ).status,
      405,
    );
    assert.equal((await fetch(live.origin + "/unknown")).status, 404);
    const html = await fetch(live.origin);
    assert.match(
      html.headers.get("content-security-policy"),
      /frame-ancestors 'none'/,
    );
    assert.equal(html.headers.get("cache-control"), "no-store");
    assert.ok((await html.text()).includes("Recent jobs"));
  } finally {
    await live.close();
  }
});
