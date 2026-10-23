import test from "node:test";
import assert from "node:assert/strict";
import tls from "node:tls";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureCertificateTrust } from "../src/certificates.js";
import { Provider } from "../src/provider.js";

test("SDK HTTPS trusts an OS root while rejecting unknown issuers and incorrect hostnames; validation stays GET-only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxci-tls-"));
  const previous = tls.getCACertificates("default");
  const servers = [];
  try {
    const config = join(dir, "openssl.cnf");
    await writeFile(
      config,
      `[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=BoxCI temporary TLS fixture
[ext]
basicConstraints=critical,CA:TRUE
keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign
subjectAltName=IP:127.0.0.1
`,
    );
    const certificate = async (name) => {
      const key = join(dir, name + ".key");
      const cert = join(dir, name + ".pem");
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-config",
          config,
          "-keyout",
          key,
          "-out",
          cert,
        ],
        { stdio: "ignore" },
      );
      return { key: await readFile(key), cert: await readFile(cert, "utf8") };
    };
    const trusted = await certificate("trusted");
    const untrusted = await certificate("untrusted");
    const calls = [];
    const machine = {
      id: "m_" + "a".repeat(26),
      name: "fixture",
      state: "suspended",
      runtime: { ready: false },
    };
    const serve = async (credentials) => {
      const server = https.createServer(credentials, (req, res) => {
        calls.push({ method: req.method, path: req.url });
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            req.url.startsWith("/v1/machines?")
              ? { machines: [machine] }
              : machine,
          ),
        );
      });
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      return `https://127.0.0.1:${server.address().port}`;
    };
    const url = await serve(trusted);
    await assert.rejects(
      fetch(url),
      (error) => error.cause?.code === "DEPTH_ZERO_SELF_SIGNED_CERT",
    );
    configureCertificateTrust({
      getCACertificates: (type) =>
        type === "system" ? [trusted.cert] : previous,
      setDefaultCACertificates: (roots) => tls.setDefaultCACertificates(roots),
    });
    const provider = new Provider({
      environment: {
        INSTABOX_API_KEY: "ibk_fixture_only",
        INSTABOX_API_URL: url,
      },
      exec: async () => JSON.stringify({ userId: 7, login: "fixture" }),
    });
    assert.equal((await provider.list())[0].state, "suspended");
    await provider.validateKey("ibk_fixture_only", 7, machine.id);
    assert.ok(calls.length >= 3);
    assert.ok(calls.every((c) => c.method === "GET"));
    assert.equal(
      calls.some((c) => /resume|exec/.test(c.path)),
      false,
    );
    const other = await serve(untrusted);
    await assert.rejects(
      fetch(other),
      (error) => error.cause?.code === "DEPTH_ZERO_SELF_SIGNED_CERT",
    );
    await assert.rejects(
      new Promise((resolve, reject) => {
        https
          .get(url, { servername: "wrong.fixture" }, resolve)
          .on("error", reject);
      }),
      { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
    );
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    tls.setDefaultCACertificates(previous);
    await rm(dir, { recursive: true, force: true });
  }
});
