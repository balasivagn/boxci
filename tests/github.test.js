import test from "node:test";
import assert from "node:assert/strict";
import { GitHub } from "../src/github.js";
test("missing workflow OAuth scope returns through native GitHub consent once and retries the same upload", async () => {
  const calls = [];
  let upload = 0;
  const github = new GitHub({
    interactive: true,
    exec: async (_, args, options) => {
      calls.push({ args, options });
      if (args[0] === "api") {
        upload++;
        if (upload === 1)
          throw new Error("refusing workflow upload without workflow scope");
        return "{}";
      }
      return "";
    },
  });
  await github.api("repos/acme/project/contents/.github/workflows/boxci.yml", {
    method: "PUT",
    body: { content: "fixture" },
  });
  assert.equal(upload, 2);
  assert.ok(calls[1].args.includes("refresh"));
  assert.equal(calls[1].options.interactive, true);
  assert.equal(calls[0].options.input, calls[2].options.input);
});
test("noninteractive workflow scope errors do not open browser authentication", async () => {
  let calls = 0;
  const github = new GitHub({
    interactive: false,
    exec: async () => {
      calls++;
      throw new Error("workflow scope missing");
    },
  });
  await assert.rejects(
    github.api("repos/acme/project/contents/.github/workflows/boxci.yml", {
      method: "PUT",
      body: {},
    }),
    /scope/,
  );
  assert.equal(calls, 1);
});
