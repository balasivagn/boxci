import test from "node:test";
import assert from "node:assert/strict";
import {
  configureCertificateTrust,
  certificateErrorMessage,
} from "../src/certificates.js";

test("system roots augment existing trust, including extra roots, exactly once", () => {
  const writes = [];
  const api = {
    getCACertificates: (type) =>
      type === "default"
        ? ["bundled-root", "extra-root"]
        : ["system-root", "extra-root"],
    setDefaultCACertificates: (roots) => writes.push(roots),
  };
  configureCertificateTrust(api);
  configureCertificateTrust(api);
  assert.deepEqual(writes, [["bundled-root", "extra-root", "system-root"]]);
});

test("an empty system store preserves existing trust and unsupported Node fails with upgrade guidance", () => {
  let roots;
  configureCertificateTrust({
    getCACertificates: (type) => (type === "default" ? ["existing-root"] : []),
    setDefaultCACertificates: (value) => {
      roots = value;
    },
  });
  assert.deepEqual(roots, ["existing-root"]);
  assert.throws(
    () => configureCertificateTrust({}),
    /Node.js 22.19\+ or 24.5\+/,
  );
});

test("trust failures explain recovery without exposing SDK request details or suggesting verification bypass", () => {
  const error = new Error("request details ibk_fixture_only", {
    cause: Object.assign(new Error("fetch failed"), {
      cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" },
    }),
  });
  const message = certificateErrorMessage(error);
  assert.match(message, /trusted CA/);
  assert.match(message, /saved setup checkpoints are kept/);
  assert.doesNotMatch(
    message,
    /ibk_|NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized/,
  );
  const hostnameError = Object.assign(new Error("hostname mismatch"), {
    code: "ERR_TLS_CERT_ALTNAME_INVALID",
  });
  assert.equal(certificateErrorMessage(hostnameError), "hostname mismatch");
  const cyclic = new Error("other failure");
  cyclic.cause = cyclic;
  assert.equal(certificateErrorMessage(cyclic), "other failure");
});
