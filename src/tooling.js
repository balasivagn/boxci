import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  chmod,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "./store.js";
import { run } from "./process.js";
export function verifyArchive(bytes, checksums, name) {
  const line = checksums
    .split("\n")
    .find((l) => l.trim().split(/\s+/).at(-1) === name);
  const expected = line?.trim().split(/\s+/)[0];
  if (
    !/^[a-f0-9]{64}$/i.test(expected || "") ||
    createHash("sha256").update(bytes).digest("hex") !== expected.toLowerCase()
  )
    throw new Error(
      "Official GitHub CLI checksum mismatch. Download will not be executed.",
    );
}
export function githubAsset(
  version,
  platform = process.platform,
  arch = process.arch,
) {
  const os = { darwin: "macOS", linux: "linux", win32: "windows" }[platform];
  const cpu = { arm64: "arm64", x64: "amd64" }[arch];
  if (!os || !cpu)
    throw new Error(
      "Install GitHub CLI for this platform from https://cli.github.com/.",
    );
  return `gh_${version}_${os}_${cpu}.${platform === "linux" ? "tar.gz" : "zip"}`;
}
let cached;
export async function ensureGitHubCLI({
  exec = run,
  fetcher = fetch,
  root = join(dataDir(), "tools"),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  try {
    await exec("gh", ["--version"]);
    return "gh";
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const binary = join(root, "gh", platform === "win32" ? "gh.exe" : "bin/gh");
  try {
    await exec(binary, ["--version"]);
    return binary;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const get = async (url) => {
    if (
      !url.startsWith("https://api.github.com/") &&
      !url.startsWith("https://github.com/cli/cli/releases/download/")
    )
      throw new Error("Unexpected bootstrap download URL.");
    const response = await fetcher(url, {
      headers: { "User-Agent": "@balasivagn/boxci" },
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok)
      throw new Error(
        `GitHub CLI bootstrap failed: HTTP ${response.status}. Install gh from https://cli.github.com/.`,
      );
    return response;
  };
  const release = await (
    await get("https://api.github.com/repos/cli/cli/releases/latest")
  ).json();
  const version = release.tag_name?.match(/^v(\d+\.\d+\.\d+)$/)?.[1];
  if (!version) throw new Error("Unexpected GitHub CLI release metadata.");
  const name = githubAsset(version, platform, arch),
    checksumName = `gh_${version}_checksums.txt`;
  const urls = [name, checksumName].map(
    (n) => release.assets.find((a) => a.name === n)?.browser_download_url,
  );
  if (urls.some((u) => !u))
    throw new Error(
      "Official GitHub CLI download is unavailable for this platform.",
    );
  const bytes = Buffer.from(await (await get(urls[0])).arrayBuffer());
  const checksums = await (await get(urls[1])).text();
  verifyArchive(bytes, checksums, name);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const staging = join(root, ".gh-" + randomUUID());
  await mkdir(staging, { mode: 0o700 });
  try {
    const archive = join(staging, name);
    await writeFile(archive, bytes, { mode: 0o600 });
    await exec("tar", ["-xf", archive, "-C", staging]);
    const extracted =
      platform === "win32"
        ? staging
        : join(staging, name.replace(/\.(tar\.gz|zip)$/, ""));
    const source = join(
      extracted,
      platform === "win32" ? "bin/gh.exe" : "bin/gh",
    );
    await readFile(source);
    await chmod(source, 0o755);
    await mkdir(join(root, "gh", "bin"), { recursive: true, mode: 0o700 });
    await rename(source, binary);
    return binary;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
export async function runGh(command, args, options) {
  if (command !== "gh") return run(command, args, options);
  cached ??= ensureGitHubCLI().catch((e) => {
    cached = undefined;
    throw e;
  });
  return run(await cached, args, options);
}
