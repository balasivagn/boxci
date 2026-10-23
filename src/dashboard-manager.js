import { spawn } from "node:child_process";
import {
  open,
  unlink,
  writeFile,
  mkdir,
  rename,
  lstat,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { dataDir } from "./store.js";
import { run } from "./process.js";
import { version } from "./version.js";
import {
  dashboardPaths,
  privateDirectory,
  readPrivateJSON,
  validateDashboardRecord,
  controlDashboard,
  runDashboardService,
} from "./dashboard-runtime.js";

async function openBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  await run(command, args);
}
export class DashboardManager {
  constructor({
    directory = dataDir(),
    environment = process.env,
    worker = new URL("./dashboard-worker.js", import.meta.url),
    browser = openBrowser,
    timeout = 90000,
  } = {}) {
    this.directory = directory;
    this.environment = environment;
    this.worker = worker;
    this.browser = browser;
    this.timeout = timeout;
  }
  async locked(repo, fn) {
    const paths = dashboardPaths(this.directory, repo);
    await privateDirectory(paths.root);
    let lock;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        lock = await open(paths.lock, "wx", 0o600);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let owner;
        try {
          owner = await readPrivateJSON(paths.lock);
        } catch (readError) {
          if (!readError.message.startsWith("Dashboard state is invalid"))
            throw readError;
          await delay(100);
          continue;
        }
        if (owner && Number.isInteger(owner.pid) && owner.pid > 1) {
          try {
            process.kill(owner.pid, 0);
          } catch (check) {
            if (check.code === "ESRCH") {
              await unlink(paths.lock).catch(() => {});
              continue;
            }
          }
        }
        await delay(100);
      }
    }
    if (!lock)
      throw new Error(
        "Another command is managing this dashboard. Retry after it finishes.",
      );
    try {
      await lock.writeFile(
        JSON.stringify({
          pid: process.pid,
          nonce: randomBytes(16).toString("hex"),
        }),
      );
      return await fn(paths);
    } finally {
      await lock.close();
      await unlink(paths.lock).catch(() => {});
    }
  }
  async existing(repo, paths) {
    const state = await readPrivateJSON(paths.state);
    if (!state) return null;
    const record = validateDashboardRecord(state, repo);
    try {
      await controlDashboard(record);
      return record;
    } catch (error) {
      if (error.code !== "ECONNREFUSED") throw error;
      // A stale record is removed under the controller lock. Never signal its PID.
      await unlink(paths.state);
      return null;
    }
  }
  async present(record, options, reused = false) {
    if (options["session-file"]) {
      const file = options["session-file"];
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temp = file + "." + randomBytes(8).toString("hex");
      try {
        await writeFile(
          temp,
          JSON.stringify({
            origin: record.origin,
            url: record.origin + "/#token=" + record.token,
            token: record.token,
          }),
          { mode: 0o600, flag: "wx" },
        );
        await rename(temp, file);
      } finally {
        await unlink(temp).catch(() => {});
      }
    }
    let opened = false;
    if (!options["no-open"]) {
      try {
        await this.browser(record.origin + "/#token=" + record.token);
        opened = true;
      } catch {
        /* Report a recoverable browser launch failure without a token URL. */
      }
    }
    return {
      repo: record.repo,
      running: true,
      background: record.background,
      pid: record.pid,
      origin: record.origin,
      version: record.version,
      reused,
      browser_opened: opened,
      message: `Dashboard ${reused ? "already running" : "running"}${record.background ? " in the background" : ""}: ${record.origin}\nLocal and read-only. ${!opened && !options["no-open"] ? "Browser could not open; rerun boxci dashboard in a desktop session. " : ""}Use boxci dashboard status or boxci dashboard stop.`,
    };
  }
  async start(app, options = {}) {
    if (
      options.port !== undefined &&
      (!Number.isInteger(Number(options.port)) ||
        Number(options.port) < 0 ||
        Number(options.port) > 65535)
    )
      throw new Error("Dashboard port must be between 0 and 65535.");
    const repo = await app.github.repo(options.repo);
    const { record, reused } = await this.locked(repo, async (paths) => {
      let current = await this.existing(repo, paths);
      if (
        current &&
        options.port !== undefined &&
        Number(options.port) !== Number(new URL(current.origin).port)
      )
        throw new Error(
          `Dashboard already runs on ${current.origin}. Stop it before changing the port.`,
        );
      if (current && current.version !== version) {
        await controlDashboard(current, "stop");
        current = null;
      }
      if (current) return { record: current, reused: true };
      const oldLog = await lstat(paths.log).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (
        oldLog &&
        (!oldLog.isFile() ||
          oldLog.isSymbolicLink() ||
          (process.getuid && oldLog.uid !== process.getuid()))
      )
        throw new Error("Dashboard log must be a regular file.");
      const log = await open(
        paths.log,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_APPEND |
          (constants.O_NOFOLLOW || 0),
        0o600,
      );
      await log.chmod(0o600);
      let child;
      try {
        child = spawn(process.execPath, [fileURLToPath(this.worker)], {
          cwd: paths.root,
          env: this.environment,
          detached: true,
          windowsHide: true,
          stdio: ["ignore", log.fd, log.fd, "ipc"],
        });
        const record = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill("SIGTERM");
            reject(
              new Error(`Dashboard startup timed out. Inspect ${paths.log}.`),
            );
          }, this.timeout);
          const fail = (error) => {
            clearTimeout(timer);
            reject(error);
          };
          child.once("error", fail);
          child.once("exit", () =>
            fail(
              new Error(
                `Dashboard stopped before startup completed. Inspect ${paths.log}.`,
              ),
            ),
          );
          child.once("message", (message) => {
            clearTimeout(timer);
            if (message.error) return reject(new Error(message.error));
            try {
              const record = validateDashboardRecord(message.record, repo);
              if (record.pid !== child.pid)
                throw new Error(
                  "Dashboard startup did not identify the launched process.",
                );
              resolve(record);
            } catch (error) {
              reject(error);
            }
          });
          child.once("spawn", () =>
            child.send({
              repo,
              directory: this.directory,
              port: Number(options.port || 0),
            }),
          );
        });
        child.disconnect();
        child.unref();
        return { record, reused: false };
      } catch (error) {
        if (child?.connected) child.disconnect();
        child?.kill("SIGTERM");
        throw error;
      } finally {
        await log.close();
      }
    });
    return this.present(record, options, reused);
  }
  async status(app, options = {}) {
    const repo = await app.github.repo(options.repo);
    return this.locked(repo, async (paths) => {
      const record = await this.existing(repo, paths);
      return record
        ? {
            repo,
            running: true,
            pid: record.pid,
            origin: record.origin,
            version: record.version,
            background: record.background,
            message: `Dashboard running${record.background ? " in the background" : ""}: ${record.origin}`,
          }
        : {
            repo,
            running: false,
            message: "Dashboard is stopped. Run boxci dashboard to open it.",
          };
    });
  }
  async stop(app, options = {}) {
    const repo = await app.github.repo(options.repo);
    return this.locked(repo, async (paths) => {
      const record = await this.existing(repo, paths);
      const stopped = record ? await controlDashboard(record, "stop") : null;
      return {
        repo,
        running: false,
        message: record
          ? "Dashboard stopped. Cloud VMs and runners are unchanged." +
            (stopped?.cleanup_pending
              ? " Private runtime state could not be removed; inspect the dashboard state directory."
              : "")
          : "Dashboard is already stopped.",
      };
    });
  }
  async foreground(app, options = {}) {
    const repo = await app.github.repo(options.repo);
    const live = await this.locked(repo, async (paths) => {
      if (await this.existing(repo, paths))
        throw new Error(
          "Dashboard already running. Use boxci dashboard to reopen it, or stop it before using --foreground.",
        );
      return runDashboardService(app, {
        repo,
        directory: this.directory,
        port: options.port,
        background: false,
      });
    });
    const info = await this.present(live.record, options);
    if (!options.json) console.log(info.message + "\nPress Ctrl+C to stop.");
    else console.log(JSON.stringify(info));
    const stop = () => live.stop().catch(() => {});
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await live.closed;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
}
