import { spawn } from "node:child_process";
const secrets = new Set();
export function protect(value) {
  if (value) secrets.add(value);
  return value;
}
export function redact(value) {
  let text = String(value ?? "");
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    text = text.replaceAll(secret, "[redacted]");
  return text.replace(
    /\b(?:ibk_|gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g,
    "[redacted]",
  );
}
export function run(
  command,
  args = [],
  { input, interactive = false, timeout = 60000, env = process.env } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: interactive ? ["inherit", 2, 2] : ["pipe", "pipe", "pipe"],
      env,
      windowsHide: true,
    });
    let stdout = "",
      stderr = "",
      done = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, timeout);
    child.stdout?.on("data", (d) => {
      stdout += d;
      if (stdout.length > 16 * 1024 * 1024) child.kill();
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
      if (stderr.length > 1024 * 1024) child.kill();
    });
    child.on("error", (e) => {
      done = true;
      clearTimeout(timer);
      e.message = redact(e.message);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (done) return;
      if (code === 0) resolve(stdout);
      else {
        const e = new Error(
          redact(
            stderr.trim() || `${command} exited ${code ?? "after timeout"}`,
          ),
        );
        e.code = code;
        e.stderr = redact(stderr);
        reject(e);
      }
    });
    if (!interactive) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}
export const jsonRun = async (command, args, options) =>
  JSON.parse(await run(command, args, options));
export function requireInteractive() {
  if (!process.stdin.isTTY)
    throw new Error(
      "Sign-in is needed. Run boxci init in a terminal; it will open the official sign-in flow.",
    );
}
