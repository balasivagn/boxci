import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/process.js";
import { Provider } from "../src/provider.js";

// Mirrors `instabox whoami --json` when signed out: exit 1, the error as JSON
// on stdout and nothing on stderr.
const signedOut = JSON.stringify({
  error: { code: "cli_error", message: "not logged in; run `instabox login`" },
});
const node = (script, options) =>
  run(process.execPath, ["-e", script], options);
const exitWith = (stdout, stderr = "") =>
  `process.stdout.write(${JSON.stringify(stdout)});` +
  `process.stderr.write(${JSON.stringify(stderr)});` +
  "process.exitCode = 1;";

test("a JSON error on stdout becomes the error message when stderr is empty", async () => {
  await assert.rejects(node(exitWith(signedOut)), (error) => {
    assert.equal(error.message, "not logged in; run `instabox login`");
    assert.equal(error.code, 1);
    return true;
  });
});
test("stderr still wins over stdout, and plain stdout is never echoed", async () => {
  await assert.rejects(
    node(exitWith(signedOut, "instabox: quota exceeded\n")),
    /^Error: instabox: quota exceeded$/,
  );
  await assert.rejects(node(exitWith("private output\n")), (error) => {
    assert.match(error.message, / exited 1$/);
    assert.ok(!error.message.includes("private output"));
    return true;
  });
  await assert.rejects(
    node(exitWith(JSON.stringify({ error: { code: "x" } }))),
    / exited 1$/,
  );
});
test("credentials in a stdout JSON error are redacted", async () => {
  const token = "ghp_" + "F".repeat(36);
  await assert.rejects(
    node(exitWith(JSON.stringify({ error: { message: `bad ${token}` } }))),
    (error) => {
      assert.ok(!error.message.includes(token), "token was not redacted");
      assert.match(error.message, /\[redacted\]/);
      return true;
    },
  );
});
function signedOutProvider(interactive) {
  const calls = [];
  let loggedIn = false;
  const provider = new Provider({
    interactive,
    exec: async (command, args, options) => {
      calls.push({ args, options });
      if (args[0] === "login") {
        loggedIn = true;
        return "";
      }
      // Run a real child process so the stdout-only error goes through run().
      return node(
        loggedIn
          ? `process.stdout.write(${JSON.stringify(JSON.stringify({ userId: 7, login: "fixture" }))})`
          : exitWith(signedOut),
        options,
      );
    },
  });
  return { provider, calls };
}
test("a signed-out InstaBox CLI without a terminal gives a login error naming instabox login", async () => {
  const { provider, calls } = signedOutProvider(false);
  await assert.rejects(provider.authenticate(), (error) => {
    assert.match(error.message, /sign-in is needed/i);
    assert.match(error.message, /`instabox login`/);
    assert.ok(!/ exited 1/.test(error.message), "generic exit error shown");
    return true;
  });
  assert.deepEqual(
    calls.map((c) => c.args[0]),
    ["whoami"],
  );
});
test("a signed-out InstaBox CLI in a terminal starts the official login once", async () => {
  const { provider, calls } = signedOutProvider(true);
  assert.deepEqual(await provider.authenticate(), {
    userId: 7,
    login: "fixture",
  });
  const logins = calls.filter((c) => c.args[0] === "login");
  assert.equal(logins.length, 1);
  assert.equal(logins[0].options.interactive, true);
  assert.deepEqual(
    calls.map((c) => c.args[0]),
    ["whoami", "login", "whoami"],
  );
});
