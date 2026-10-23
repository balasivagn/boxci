import test from "node:test";
import assert from "node:assert/strict";
import { credentialResponse } from "../src/credentials.js";
import { protect, redact } from "../src/process.js";

const meta = { id: "key_fixture", expiresAt: "2030-01-01T00:00:00Z" };
test("root and nested metadata work without treating a secret-valued key field as metadata", () => {
  for (const value of [
    { ...meta, key: "ibk_fixture" },
    { ...meta, prefix: "ibk_partial", key: "ibk_fixture" },
    { key: meta, secret: "ibk_fixture" },
    { apiKey: meta, key: "ibk_fixture" },
    { data: { ...meta, token: "ibk_fixture" } },
  ])
    assert.deepEqual(credentialResponse(value), {
      meta,
      secret: "ibk_fixture",
    });
});
test("ambiguous credentials fail and all returned secrets are redacted", () => {
  assert.throws(
    () => credentialResponse({ key: "ibk_one", other: "ibk_two", ...meta }),
    /Unexpected/,
  );
  assert.equal(redact("ibk_one ibk_two"), "[redacted] [redacted]");
  assert.throws(
    () =>
      credentialResponse({
        key: "ibk_one",
        first: meta,
        second: { ...meta, id: "key_other" },
      }),
    /Unexpected/,
  );
  assert.equal(
    credentialResponse({
      key: "ibk_one",
      id: "not-a-key",
      expiresAt: "invalid",
    }).meta,
    null,
  );
});
test("overlapping credential values cannot expose a token suffix during redaction", () => {
  protect("fixture-overlap");
  protect("fixture-overlap-secret");
  assert.equal(redact("fixture-overlap-secret"), "[redacted]");
  credentialResponse({ ...meta, prefix: "ibk_prefix", key: "ibk_prefix_full" });
  assert.equal(redact("ibk_prefix_full"), "[redacted]");
});
