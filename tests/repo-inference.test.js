import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHub, repoFromRemote } from "../src/github.js";
import { isolateGitConfig } from "./helpers/git-config.js";

// Assertion messages may only carry remotes with their userinfo removed.
const safe = (url) => url.replace(/\/\/[^\s/]*@/, "//[REDACTED]@");
const signedOutGh = async () => {
  const error = new Error(
    "To get started with GitHub CLI, please run:  gh auth login",
  );
  error.code = 4;
  throw error;
};
async function checkout(t, ...remotes) {
  await isolateGitConfig(t);
  const root = await realpath(await mkdtemp(join(tmpdir(), "boxci-repo-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "--initial-branch=codex/test-fixture");
  for (const [name, url] of remotes) git("remote", "add", name, url);
  return {
    root,
    git,
    github: new GitHub({ exec: signedOutGh, cwd: root, interactive: false }),
  };
}

test("GitHub remotes in https, ssh and credentialed https forms name the repository", () => {
  for (const url of [
    "https://github.com/acme/project",
    "https://github.com/acme/project.git",
    "https://github.com/acme/project/",
    "https://GitHub.com/acme/project.git",
    "git@github.com:acme/project.git",
    "git@github.com:acme/project",
    "ssh://git@github.com/acme/project.git",
    "ssh://git@github.com/acme/project",
    "https://user@github.com/acme/project.git",
    "https://user:secret@github.com/acme/project.git",
    "https://x-access-token:FAKETOKEN0123456789@github.com/acme/project",
  ])
    assert.equal(repoFromRemote(url), "acme/project", safe(url));
  assert.equal(
    repoFromRemote("git@github.com:Acme-Org/my.project_1.git"),
    "Acme-Org/my.project_1",
  );
});
test("non-GitHub, spoofed and malformed remotes are rejected", () => {
  for (const url of [
    "",
    "https://gitlab.com/acme/project.git",
    "https://user:secret@gitlab.com/acme/project.git",
    "git@gitlab.com:acme/project.git",
    "ssh://git@gitlab.com/acme/project.git",
    "https://github.com.evil.com/acme/project.git",
    "https://user:secret@github.com.evil.com/acme/project.git",
    "git@github.com.evil.com:acme/project.git",
    "ssh://git@github.com.evil.com/acme/project.git",
    "https://evil.com/github.com/acme/project.git",
    "https://user:secret@evil.com@github.com/acme/project.git",
    "https://evil.com#@github.com/acme/project.git",
    "https://evil.com?@github.com/acme/project.git",
    "https://evil.com\\@github.com/acme/project.git",
    "https://github.com:8443/acme/project.git",
    "https://github.com/acme/project/extra.git",
    "https://github.com/acme",
    "http://github.com/acme/project.git",
    "http://user:secret@github.com/acme/project.git",
    "git://github.com/acme/project.git",
    "https://github.com/../project.git",
    "/srv/git/acme/project.git",
  ])
    assert.equal(repoFromRemote(url), null, `accepted ${safe(url)}`);
});
test("signed-out gh falls back to the checkout's GitHub remote", async (t) => {
  for (const url of [
    "https://github.com/acme/project.git",
    "git@github.com:acme/project.git",
    "ssh://git@github.com/acme/project.git",
    "https://user:secret@github.com/acme/project.git",
  ]) {
    const { github } = await checkout(t, ["origin", url]);
    assert.equal(await github.repo(), "acme/project", safe(url));
  }
});
test("a credentialed insteadOf rewrite resolves without exposing the token", async (t) => {
  const token = "FAKETOKEN0123456789";
  const { root, git, github } = await checkout(t, [
    "origin",
    "git@github.com:acme/project.git",
  ]);
  git(
    "config",
    `url.https://x-access-token:${token}@github.com/.insteadOf`,
    "git@github.com:",
  );
  const remotes = execFileSync("git", ["remote", "-v"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.ok(remotes.includes(token), "the fake token rewrite was not applied");
  assert.equal(await github.repo(), "acme/project");
  git(
    "remote",
    "set-url",
    "origin",
    `https://x-access-token:${token}@gitlab.com/acme/project.git`,
  );
  await assert.rejects(github.repo(), (error) => {
    assert.match(error.message, /No GitHub remote found/);
    assert.ok(!error.message.includes(token), "error message has the token");
    assert.ok(!/x-access-token|gitlab/.test(error.message), "remote echoed");
    return true;
  });
});
test("non-GitHub and spoofed remotes are not inferred, and the URL is never echoed", async (t) => {
  for (const url of [
    "https://user:secret@gitlab.com/acme/project.git",
    "https://user:secret@github.com.evil.com/acme/project.git",
    "https://evil.com#@github.com/acme/project.git",
  ]) {
    const { github } = await checkout(t, ["origin", url]);
    await assert.rejects(
      github.repo(),
      (error) => {
        assert.match(error.message, /No GitHub remote found/);
        assert.match(error.message, /--repo owner\/repository/);
        assert.ok(
          !/secret|evil|gitlab|user:/.test(error.message),
          `error message echoes ${safe(url)}`,
        );
        return true;
      },
      `accepted ${safe(url)}`,
    );
  }
});
test("origin wins; otherwise one distinct GitHub repository is required", async (t) => {
  const both = await checkout(
    t,
    ["upstream", "https://github.com/acme/project.git"],
    ["origin", "git@github.com:fork/project.git"],
  );
  assert.equal(await both.github.repo(), "fork/project");
  const same = await checkout(
    t,
    ["upstream", "https://github.com/acme/project.git"],
    ["mirror", "git@github.com:ACME/project.git"],
  );
  assert.match(await same.github.repo(), /^acme\/project$/i);
  const several = await checkout(
    t,
    ["upstream", "https://github.com/acme/project.git"],
    ["fork", "https://user:secret@github.com/fork/project.git"],
  );
  await assert.rejects(several.github.repo(), (error) => {
    assert.match(error.message, /several GitHub remotes/);
    assert.ok(!/secret|user:|acme|fork/.test(error.message), "remote echoed");
    return true;
  });
});
test("outside a Git checkout the error asks for a checkout or --repo", async (t) => {
  await isolateGitConfig(t);
  const dir = await realpath(await mkdtemp(join(tmpdir(), "boxci-nogit-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = new GitHub({
    exec: signedOutGh,
    // A failing git, as outside a checkout, without depending on the temp
    // directory's parents.
    git: () => {
      throw new Error("not a git repository");
    },
    cwd: dir,
  });
  await assert.rejects(
    github.repo(),
    /^Error: Run inside a Git checkout, or pass --repo owner\/repository\.$/,
  );
});
test("gh's answer is used when available and --repo skips inference", async () => {
  let gitCalls = 0;
  const github = new GitHub({
    exec: async () => "acme/project\n",
    git: () => {
      gitCalls++;
      return "";
    },
  });
  assert.equal(await github.repo(), "acme/project");
  assert.equal(await github.repo("other/repo"), "other/repo");
  assert.equal(gitCalls, 0);
});
