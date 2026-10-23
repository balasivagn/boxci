import net from "node:net";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  writeFile,
  unlink,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { serveDashboard } from "./dashboard.js";
import { validateRepo } from "./store.js";
import { protect, redact } from "./process.js";
import { certificateErrorMessage } from "./certificates.js";
import { version } from "./version.js";

export function dashboardPaths(directory, repo) {
  const id = createHash("sha256")
    .update(validateRepo(repo).toLowerCase())
    .digest("hex")
    .slice(0, 24);
  const root = join(directory, "dashboards");
  return {
    root,
    state: join(root, id + ".json"),
    lock: join(root, id + ".lock"),
    log: join(root, id + ".log"),
  };
}
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error(
      "Dashboard state directory must be owned by the current user and must not be a symlink.",
    );
  await chmod(path, 0o700);
}
export async function readPrivateJSON(file) {
  let stat;
  try {
    stat = await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 65536 ||
    (process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o077))
  )
    throw new Error(
      "Dashboard state must be a private regular file owned by the current user.",
    );
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error(
      "Dashboard state is invalid. No process was stopped; inspect the private dashboard state file.",
    );
  }
}
export function validateDashboardRecord(record, repo) {
  let url;
  try {
    url = new URL(record?.origin);
  } catch {
    throw new Error(
      "Dashboard state does not identify a valid local instance. No process was stopped.",
    );
  }
  if (
    record.repo?.toLowerCase() !== repo.toLowerCase() ||
    record.protocol !== 1 ||
    !Number.isInteger(record.pid) ||
    record.pid < 2 ||
    !Number.isInteger(record.control_port) ||
    record.control_port < 1 ||
    record.control_port > 65535 ||
    !/^[a-f0-9]{64}$/.test(record.control_token) ||
    !/^[a-f0-9]{64}$/.test(record.token) ||
    !/^[a-f0-9]{32}$/.test(record.instance) ||
    typeof record.version !== "string" ||
    typeof record.background !== "boolean" ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Dashboard state does not identify a valid local instance. No process was stopped.",
    );
  protect(record.control_token);
  protect(record.token);
  return record;
}
function signature(key, kind, payload) {
  return createHmac("sha256", key)
    .update(kind + "\n" + JSON.stringify(payload))
    .digest("hex");
}
function validSignature(key, kind, payload, mac) {
  if (typeof mac !== "string" || !/^[a-f0-9]{64}$/.test(mac)) return false;
  return timingSafeEqual(
    Buffer.from(mac, "hex"),
    Buffer.from(signature(key, kind, payload), "hex"),
  );
}

export function controlDashboard(record, action = "info", timeout = 3000) {
  const nonce = randomBytes(32).toString("hex");
  const request = {
    action,
    pid: record.pid,
    repo: record.repo,
    instance: record.instance,
    nonce,
  };
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: "127.0.0.1",
      port: record.control_port,
    });
    let input = "";
    socket.setTimeout(timeout, () =>
      socket.destroy(
        new Error(
          "Local dashboard control timed out. No process was signalled.",
        ),
      ),
    );
    socket.once("error", reject);
    socket.once("connect", () =>
      socket.write(
        JSON.stringify({
          ...request,
          mac: signature(record.control_token, "request", request),
        }) + "\n",
      ),
    );
    socket.on("data", (chunk) => {
      input += chunk;
      if (input.length > 4096)
        return socket.destroy(new Error("Invalid dashboard control response."));
      if (!input.includes("\n")) return;
      try {
        const result = JSON.parse(input.split("\n")[0]);
        const { mac, ...payload } = result;
        if (
          !validSignature(record.control_token, "response", payload, mac) ||
          result.nonce !== nonce ||
          !result.ok ||
          result.instance !== record.instance ||
          result.repo !== record.repo ||
          result.pid !== record.pid ||
          result.origin !== record.origin ||
          result.version !== record.version
        )
          throw new Error(
            "Cannot verify the saved dashboard instance. No process was stopped.",
          );
        socket.end();
        resolve(result);
      } catch (error) {
        socket.destroy(error);
      }
    });
    socket.once("end", () => {
      if (!input.includes("\n"))
        reject(new Error("Dashboard control closed before verification."));
    });
  });
}

export async function runDashboardService(
  app,
  { repo, directory, port = 0, background = true },
) {
  validateRepo(repo);
  if (
    !Number.isInteger(Number(port)) ||
    Number(port) < 0 ||
    Number(port) > 65535
  )
    throw new Error("Dashboard port must be between 0 and 65535.");
  const paths = dashboardPaths(directory, repo);
  await privateDirectory(paths.root);
  await app.status({ repo }); // Passive identity, pool and quota checks; no guest commands.
  const live = await serveDashboard(app, { repo, port });
  protect(live.token);
  const token = protect(randomBytes(32).toString("hex"));
  const instance = randomBytes(16).toString("hex");
  let record,
    stopping = false,
    resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const connections = new Set();
  const response = (nonce, cleanupPending = false) => {
    const payload = {
      ok: true,
      repo,
      instance,
      pid: process.pid,
      version,
      origin: live.origin,
      nonce,
      cleanup_pending: cleanupPending,
    };
    return { ...payload, mac: signature(token, "response", payload) };
  };
  const stop = async (request, nonce) => {
    if (stopping) return;
    stopping = true;
    const controlClosed = new Promise((resolve) => control.close(resolve));
    for (const socket of connections) if (socket !== request) socket.destroy();
    live.server.closeAllConnections();
    await live.close();
    let cleanupPending = false;
    try {
      if (record && (await readPrivateJSON(paths.state))?.instance === instance)
        await unlink(paths.state);
    } catch {
      cleanupPending = true;
    }
    if (request)
      request.end(JSON.stringify(response(nonce, cleanupPending)) + "\n");
    await controlClosed;
    resolveClosed();
  };
  const control = net.createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(3000, () => socket.destroy());
    let input = "",
      handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      input += chunk;
      if (input.length > 2048) return socket.destroy();
      if (!input.includes("\n")) return;
      handled = true;
      let request;
      try {
        request = JSON.parse(input.split("\n")[0]);
      } catch {
        return socket.destroy();
      }
      if (
        !request ||
        typeof request.nonce !== "string" ||
        !/^[a-f0-9]{64}$/.test(request.nonce)
      )
        return socket.end(JSON.stringify({ ok: false }) + "\n");
      const { mac, ...payload } = request;
      if (
        !validSignature(token, "request", payload, mac) ||
        request.instance !== instance ||
        request.repo !== repo ||
        request.pid !== process.pid ||
        !["info", "stop"].includes(request.action)
      )
        return socket.end(JSON.stringify({ ok: false }) + "\n");
      if (request.action === "info")
        socket.end(JSON.stringify(response(request.nonce)) + "\n");
      else stop(socket, request.nonce).catch(() => socket.destroy());
    });
  });
  try {
    await new Promise((resolve, reject) => {
      control.once("error", reject);
      control.listen(0, "127.0.0.1", resolve);
    });
    const state = {
      protocol: 1,
      repo,
      pid: process.pid,
      version,
      instance,
      control_token: token,
      control_port: control.address().port,
      token: live.token,
      origin: live.origin,
      background,
    };
    await writeFile(paths.state, JSON.stringify(state) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    record = state;
    return { record, closed, stop };
  } catch (error) {
    control.close();
    live.server.closeAllConnections();
    await live.close();
    throw error;
  }
}

export function dashboardWorker(createApp) {
  let live;
  const stop = () =>
    live ? live.stop().catch(() => process.exit(1)) : process.exit(1);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("disconnect", () => {
    if (!live) process.exit(1);
  });
  process.once("message", async (config) => {
    try {
      live = await runDashboardService(createApp(), config);
      process.send({ record: live.record });
      await live.closed;
      process.exit(0);
    } catch (error) {
      const message = redact(certificateErrorMessage(error));
      if (process.connected)
        process.send({ error: message }, () => process.exit(1));
      else process.exit(1);
    }
  });
}
