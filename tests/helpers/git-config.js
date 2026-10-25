import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Git fixtures must not see the machine's git config: a global insteadOf for
// git@github.com: (for example one that adds a token) would rewrite their
// remotes. Code under test inherits process.env, so isolate it for the test.
const keys = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
];
export async function isolateGitConfig(t) {
  const dir = await mkdtemp(join(tmpdir(), "boxci-gitconfig-"));
  const global = join(dir, "gitconfig");
  await writeFile(global, "");
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.GIT_CONFIG_GLOBAL = global;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  t.after(async () => {
    for (const key of keys)
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    await rm(dir, { recursive: true, force: true });
  });
}
