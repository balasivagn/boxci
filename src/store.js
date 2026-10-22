import {
  mkdir,
  readFile,
  writeFile,
  rename,
  open,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { legacyStateDirs } from "./brand.js";
export function dataDir() {
  return (
    process.env.BOXCI_HOME ||
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "BoxCI")
      : process.platform === "win32"
        ? join(process.env.LOCALAPPDATA || homedir(), "BoxCI")
        : join(
            process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
            "boxci",
          ))
  );
}
export function validateRepo(repo) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || "") ||
    repo.split("/").some((s) => s === "." || s === "..")
  )
    throw new Error("Use owner/repository, or run inside its Git checkout.");
  return repo;
}
export function fileFor(repo) {
  return join(
    dataDir(),
    "projects",
    validateRepo(repo).replace("/", "--") +
      "--" +
      createHash("sha256")
        .update(repo.toLowerCase())
        .digest("hex")
        .slice(0, 12) +
      ".json",
  );
}
async function readProjectFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return undefined;
    throw e;
  }
}

export async function readProject(repo) {
  const validated = validateRepo(repo);
  const current = await readProjectFile(fileFor(repo));
  if (current !== undefined) return current;

  const shortName = join("projects", validated.replace("/", "--") + ".json");
  const hashedName = join(
    "projects",
    validated.replace("/", "--") +
      "--" +
      createHash("sha256")
        .update(repo.toLowerCase())
        .digest("hex")
        .slice(0, 12) +
      ".json",
  );
  for (const rel of [shortName, hashedName]) {
    const previous = await readProjectFile(join(dataDir(), rel));
    if (previous && previous.repo?.toLowerCase() === repo.toLowerCase())
      return previous;
    for (const base of legacyStateDirs()) {
      const legacy = await readProjectFile(join(base, rel));
      if (legacy && legacy.repo?.toLowerCase() === repo.toLowerCase())
        return legacy;
    }
  }
  return null;
}
export async function saveProject(project) {
  const file = fileFor(project.repo);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID();
  await writeFile(temp, JSON.stringify(project, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temp, file);
}
export async function locked(repo, fn) {
  const file = fileFor(repo) + ".lock";
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  let lock;
  try {
    lock = await open(file, "wx", 0o600);
  } catch (e) {
    if (e.code === "EEXIST")
      throw new Error(
        `Another setup owns this project lock: ${file}. If it crashed, check that process has exited before removing the lock.`,
      );
    throw e;
  }
  try {
    await lock.writeFile(String(process.pid));
    return await fn();
  } finally {
    await lock.close();
    await unlink(file);
  }
}
