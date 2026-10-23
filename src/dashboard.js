import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { redact } from "./process.js";
function equal(a, b) {
  const x = Buffer.from(a || ""),
    y = Buffer.from(b || "");
  return x.length === y.length && timingSafeEqual(x, y);
}
export async function serveDashboard(
  app,
  { repo, port = 0, token = randomBytes(32).toString("hex") } = {},
) {
  const root = new URL("../web/", import.meta.url);
  let origin;
  const sessions = new Set();
  const server = http.createServer(async (req, res) => {
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    };
    const send = (status, body, type = "application/json", extra = {}) => {
      res.writeHead(status, { ...headers, "Content-Type": type, ...extra });
      res.end(type === "application/json" ? JSON.stringify(body) : body);
    };
    try {
      if (
        req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin)
      )
        return send(403, { error: "Invalid host or origin." });
      const url = new URL(req.url, origin);
      if (req.method === "POST" && url.pathname === "/api/session") {
        if (
          req.headers.origin !== origin ||
          req.headers["content-type"] !== "application/json"
        )
          return send(403, { error: "Invalid session request." });
        let body = "";
        for await (const part of req) {
          body += part;
          if (body.length > 1024)
            return send(413, { error: "Request too large." });
        }
        let data;
        try {
          data = JSON.parse(body);
        } catch {
          return send(400, { error: "Invalid session request." });
        }
        if (!equal(data.token, token))
          return send(401, {
            error: "Open the dashboard using boxci dashboard.",
          });
        const session = randomBytes(32).toString("hex");
        sessions.add(session);
        if (sessions.size > 8) sessions.delete(sessions.values().next().value);
        return send(200, { ok: true }, "application/json", {
          "Set-Cookie": `boxci=${session}; HttpOnly; SameSite=Strict; Path=/`,
        });
      }
      if (req.method !== "GET")
        return send(405, {
          error: "Dashboard is read-only. Use the CLI for changes.",
        });
      const cookie = (req.headers.cookie || "")
        .split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith("boxci="))
        ?.slice(6);
      if (url.pathname.startsWith("/api/")) {
        if (!sessions.has(cookie))
          return send(401, {
            error:
              "Open this dashboard from boxci dashboard to authorize this browser.",
          });
        if (url.pathname === "/api/status")
          return send(200, await app.status({ repo }));
        return send(404, { error: "Not found." });
      }
      const assets = {
        "/": ["index.html", "text/html"],
        "/app.js": ["app.js", "text/javascript"],
        "/style.css": ["style.css", "text/css"],
        "/tokens.css": ["tokens.css", "text/css"],
        "/fonts/inter.woff2": ["fonts/inter.woff2", "font/woff2"],
        "/fonts/geist-mono.woff2": ["fonts/geist-mono.woff2", "font/woff2"],
      };
      if (!assets[url.pathname]) return send(404, { error: "Not found." });
      const [file, mime] = assets[url.pathname];
      return send(200, await readFile(new URL(file, root)), mime);
    } catch (error) {
      send(500, { error: redact(error.message) });
    }
  });
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(Number(port), "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    origin,
    url: origin + "/#token=" + token,
    token,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  };
}
