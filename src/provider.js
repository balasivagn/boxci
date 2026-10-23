import { Sandbox } from "@insforge/instabox-sdk";
import { APP_ID } from "./brand.js";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { run } from "./process.js";
import { configureCertificateTrust } from "./certificates.js";
const require = createRequire(import.meta.url);
const bundled = join(
  dirname(require.resolve("instabox/package.json")),
  "bin",
  "instabox.mjs",
);
export class Provider {
  constructor({
    exec = run,
    environment = process.env,
    interactive = process.stdin.isTTY,
  } = {}) {
    configureCertificateTrust();
    this.interactive = interactive;
    this.exec = exec;
    this.env = environment;
    this.native = true;
  }
  async cli(args, options = {}) {
    try {
      return await this.exec("instabox", args, { env: this.env, ...options });
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      return this.exec(
        process.execPath,
        [
          "--import",
          new URL("./certificate-preload.js", import.meta.url).href,
          bundled,
          ...args,
        ],
        {
          env: this.env,
          ...options,
        },
      );
    }
  }
  async json(args, options = {}) {
    return JSON.parse(await this.cli([...args, "--json"], options));
  }
  async identity() {
    const who = await this.json(["whoami"]);
    if (!Number.isInteger(who.userId) || !who.login)
      throw new Error("InstaBox did not return an account identity.");
    return { userId: who.userId, login: who.login };
  }
  async authenticate({ provider, device = false } = {}) {
    try {
      return await this.identity();
    } catch (e) {
      if (e.code === "ENOENT") throw e;
      if (!/auth|sign|login|credential|401|unauthorized/i.test(e.message))
        throw e;
    }
    if (!this.interactive)
      throw new Error(
        "Sign-in is needed. Run boxci init in a terminal; the official browser flow will return to the command.",
      );
    if (device && provider === "google")
      throw new Error(
        "Device sign-in uses GitHub. Omit --provider google or omit --device.",
      );
    const args = ["login"];
    if (provider) args.push("--provider", provider);
    if (device) args.push("--device");
    await this.cli(args, { interactive: true, timeout: 300000 });
    return this.identity();
  }
  async list() {
    if (this.env.INSTABOX_API_KEY) {
      const list = await Sandbox.list(this.sdkOptions());
      return list.map((x) => x.machine);
    }
    return this.json(["ls"]);
  }
  sdkOptions() {
    return {
      apiKey: this.env.INSTABOX_API_KEY,
      apiUrl:
        this.env.INSTABOX_SERVER ||
        this.env.INSTABOX_API_URL ||
        "https://api.instabox.sh",
      operationTimeoutMs: 300000,
    };
  }
  async usage() {
    return this.env.INSTABOX_API_KEY
      ? Sandbox.usage(this.sdkOptions())
      : this.json(["usage"]);
  }
  async get(id) {
    return this.json(["get", id]);
  }
  async wake(id) {
    if (this.env.INSTABOX_API_KEY) {
      const sbx = await Sandbox.connect(id, {
        ...this.sdkOptions(),
        resume: false,
      });
      await sbx.resume();
      return;
    }
    const vm = await this.get(id);
    if (vm.state === "running") return;
    if (!["suspended", "stopped"].includes(vm.state))
      throw new Error(
        `VM is ${vm.state}; let its current operation finish, then retry.`,
      );
    await this.cli([vm.state === "stopped" ? "start" : "resume", id], {
      timeout: 360000,
    });
  }
  async create(name, repo) {
    if (this.env.INSTABOX_API_KEY) {
      const sbx = await Sandbox.create("agent-browser", {
        ...this.sdkOptions(),
        name,
        vault: false,
        metadata: { app: APP_ID, purpose: APP_ID, repo },
      });
      return (await sbx.getInfo()).machine;
    }
    await this.cli(
      [
        "create",
        "--name",
        name,
        "--template",
        "agent-browser",
        "--no-vault",
        "--meta",
        `app=${APP_ID}`,
        "--meta",
        `purpose=${APP_ID}`,
        "--meta",
        `repo=${repo}`,
      ],
      { timeout: 600000 },
    );
    return this.get(name);
  }
  async execScript(id, script) {
    if (this.env.INSTABOX_API_KEY) {
      const sbx = await Sandbox.connect(id, {
        ...this.sdkOptions(),
        resume: false,
      });
      return (
        await sbx.commands.run("sh -s", { stdin: script, timeoutMs: 600000 })
      ).stdout;
    }
    return this.cli(
      ["exec", id, "--timeout", "600", "--stdin", "--", "sh", "-s"],
      { input: script, timeout: 630000 },
    );
  }
  async validateKey(key, expectedAccount, machineId) {
    const who = await this.json(["whoami"], {
      env: { ...this.env, INSTABOX_API_KEY: key },
    });
    if (who.userId !== expectedAccount)
      throw new Error("New credential belongs to another account.");
    const sbx = await Sandbox.connect(machineId, {
      ...this.sdkOptions(),
      apiKey: key,
      resume: false,
    });
    await sbx.getInfo();
  }
  async keys() {
    const result = await this.json(["keys", "ls"]);
    return Array.isArray(result) ? result : result.keys || [];
  }
  async createKey(name) {
    return this.json([
      "keys",
      "create",
      "--name",
      name,
      "--scope",
      "machines:read",
      "--scope",
      "machines:write",
      "--expires-in-days",
      "30",
    ]);
  }
}
