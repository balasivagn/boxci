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
test("consumer discovery reads only workflow files and finds local helper calls", async () => {
  const github = new GitHub();
  const calls = [];
  github.api = async (path) => {
    calls.push(path);
    return [
      { type: "file", path: ".github/workflows/ci.yml" },
      { type: "file", path: ".github/workflows/unrelated.yml" },
      { type: "file", path: ".github/workflows/boxci-wake.yml" },
      { type: "symlink", path: ".github/workflows/link.yml" },
      { type: "file", path: "outside.yml" },
    ];
  };
  github.content = async (_, path, ref) => {
    assert.equal(ref, "feature/test");
    calls.push(path);
    return path.endsWith("/ci.yml")
      ? "jobs:\n  wake:\n    uses: './.github/workflows/boxci-wake.yml' # helper\n"
      : "jobs:\n  test:\n    runs-on: ubuntu-latest\n";
  };
  assert.deepEqual(
    await github.consumerWorkflows("acme/project", "feature/test"),
    [".github/workflows/ci.yml"],
  );
  assert.ok(calls[0].endsWith("ref=feature%2Ftest"));
  assert.equal(calls.includes(".github/workflows/boxci-wake.yml"), false);
});
test("consumer discovery handles a missing directory and surfaces permission failures", async () => {
  const github = new GitHub();
  github.api = async () => {
    throw new Error("HTTP 404");
  };
  assert.deepEqual(await github.consumerWorkflows("acme/project", "main"), []);
  github.api = async () => {
    throw new Error("HTTP 403");
  };
  await assert.rejects(github.consumerWorkflows("acme/project", "main"), /403/);
});
