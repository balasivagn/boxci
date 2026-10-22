import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { WAKE_JOB, wakeJobYaml } from "./wake.js";

const SKIP_FILES = new Set(["boxci.yml", "boxci-wake.yml"]);
const SKIP_JOBS = new Set([WAKE_JOB, "wake"]);

export function gitRoot(cwd = process.cwd()) {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error(
      "Run inside a Git checkout, or pass --repo with migrate from that clone.",
    );
  }
}

/** @typedef {{ name: string, file: string, relPath: string, runsOn: string, runsOnLine: number, needsLine: number | null, needsValue: string | null, startLine: number, endLine: number }} WorkflowJob */

/**
 * @param {string} content
 * @param {string} relPath
 * @returns {WorkflowJob[]}
 */
export function listMigratableJobs(content, relPath) {
  const base = relPath.split("/").pop() || relPath;
  if (SKIP_FILES.has(base)) return [];
  const lines = content.split("\n");
  let jobsIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^jobs:\s*$/.test(lines[i])) {
      jobsIndex = i;
      break;
    }
  }
  if (jobsIndex < 0) return [];

  /** @type {WorkflowJob[]} */
  const out = [];
  let i = jobsIndex + 1;
  while (i < lines.length) {
    const jobHead = lines[i].match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (!jobHead) break;
    const name = jobHead[1];
    const startLine = i;
    i++;
    let runsOn = null;
    let runsOnLine = -1;
    let needsLine = null;
    let needsValue = null;
    while (i < lines.length) {
      if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i])) break;
      if (/^[a-zA-Z]/.test(lines[i]) && !lines[i].startsWith(" ")) break;
      const ro = lines[i].match(/^    runs-on:\s*(.+)$/);
      if (ro) {
        runsOn = ro[1].trim();
        runsOnLine = i;
      }
      const nd = lines[i].match(/^    needs:\s*(.+)$/);
      if (nd) {
        needsLine = i;
        needsValue = nd[1].trim();
      }
      i++;
    }
    const endLine = i - 1;
    if (
      runsOn &&
      runsOnLine >= 0 &&
      !SKIP_JOBS.has(name) &&
      !runsOn.includes("fromJSON(needs.") &&
      !runsOn.includes("${{")
    ) {
      out.push({
        name,
        file: base,
        relPath,
        runsOn,
        runsOnLine,
        needsLine,
        needsValue,
        startLine,
        endLine,
      });
    }
  }
  return out;
}

export function mergeNeeds(existing) {
  if (!existing) return WAKE_JOB;
  if (existing === WAKE_JOB || existing.includes(WAKE_JOB)) return existing;
  if (existing.startsWith("[") && existing.endsWith("]")) {
    const inner = existing.slice(1, -1).trim();
    if (!inner) return `[${WAKE_JOB}]`;
    return `[${WAKE_JOB}, ${inner}]`;
  }
  return `[${WAKE_JOB}, ${existing}]`;
}

function ensurePermissions(lines) {
  if (/^permissions:\s/m.test(lines.join("\n"))) return lines;
  const onLine = lines.findIndex((l) => /^on:\s/.test(l) || /^on:\s*$/.test(l));
  let insertAt = onLine >= 0 ? onLine + 1 : 0;
  while (insertAt < lines.length && lines[insertAt].trim() !== "") insertAt++;
  return [
    ...lines.slice(0, insertAt),
    "",
    "permissions:",
    "  contents: read",
    ...lines.slice(insertAt),
  ];
}

/**
 * @param {string} content
 * @param {Set<string>} selectedKeys - "relPath:jobName"
 * @param {string} wakeJobBlock
 */
export function applyMigration(content, selectedKeys, relPath, wakeJobBlock) {
  const jobs = listMigratableJobs(content, relPath).filter((j) =>
    selectedKeys.has(`${relPath}:${j.name}`),
  );
  if (!jobs.length) return { content, changed: false };

  let lines = content.split("\n");
  if (!content.includes(`  ${WAKE_JOB}:`)) {
    const jobsLine = lines.findIndex((l) => /^jobs:\s*$/.test(l));
    if (jobsLine < 0) throw new Error(`${relPath}: no jobs section`);
    const insert = wakeJobBlock.trimEnd().split("\n");
    lines = [
      ...lines.slice(0, jobsLine + 1),
      ...insert,
      ...lines.slice(jobsLine + 1),
    ];
  }

  lines = ensurePermissions(lines);
  let text = lines.join("\n");
  const refreshed = listMigratableJobs(text, relPath)
    .filter((j) => selectedKeys.has(`${relPath}:${j.name}`))
    .sort((a, b) => b.runsOnLine - a.runsOnLine);

  lines = text.split("\n");
  for (const job of refreshed) {
    lines[job.runsOnLine] =
      `    runs-on: \${{ fromJSON(needs.${WAKE_JOB}.outputs.runner) }}`;
    if (job.needsLine == null) {
      lines.splice(job.runsOnLine, 0, `    needs: ${WAKE_JOB}`);
    } else {
      lines[job.needsLine] = `    needs: ${mergeNeeds(job.needsValue)}`;
    }
  }

  return {
    content: lines.join("\n") + (lines.at(-1) === "" ? "" : "\n"),
    changed: true,
  };
}

export async function scanWorkflows(root) {
  const dir = join(root, ".github", "workflows");
  let names;
  try {
    names = await readdir(dir);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  /** @type {{ relPath: string, jobs: WorkflowJob[], content: string }[]} */
  const files = [];
  for (const name of names.sort()) {
    if (!/\.(ya?ml)$/i.test(name)) continue;
    const relPath = `.github/workflows/${name}`;
    const content = await readFile(join(root, relPath), "utf8");
    const jobs = listMigratableJobs(content, relPath);
    if (jobs.length) files.push({ relPath, jobs, content });
  }
  return files;
}

export function filterJobs(allJobs, { match, jobs: jobSpec }) {
  if (jobSpec) {
    const keys = new Set(
      jobSpec.split(",").map((s) => {
        const t = s.trim();
        if (!t.includes(":"))
          throw new Error(
            `Use workflow/file.yml:jobname, got ${JSON.stringify(t)}`,
          );
        const [file, job] = t.split(":");
        const rel = file.startsWith(".github/")
          ? file
          : `.github/workflows/${file.replace(/^.*\//, "")}`;
        return `${rel}:${job}`;
      }),
    );
    return allJobs.filter((j) => keys.has(`${j.relPath}:${j.name}`));
  }
  if (match) {
    const re = new RegExp(match, "i");
    return allJobs.filter((j) => re.test(j.runsOn));
  }
  return allJobs;
}

export async function buildMigratePlan(project, options = {}) {
  const root = options.root || gitRoot();
  const files = await scanWorkflows(root);
  const allJobs = files.flatMap((f) => f.jobs);
  const picked =
    options.selectedJobs ||
    filterJobs(allJobs, {
      match: options.match,
      jobs: options.jobs,
    });
  const wakeJobBlock = await wakeJobYaml({
    pool_variable: project.pool_variable || "BOXCI_POOL",
    label: project.label,
    secret: project.secret || "BOXCI_API_KEY",
    fallback: options.fallback || "ubuntu-24.04",
  });

  /** @type {{ relPath: string, before: string, after: string }[]} */
  const edits = [];
  const selectedKeys = new Set(picked.map((j) => `${j.relPath}:${j.name}`));
  for (const file of files) {
    const fileSelected = file.jobs.some((j) =>
      selectedKeys.has(`${j.relPath}:${j.name}`),
    );
    if (!fileSelected) continue;
    const { content, changed } = applyMigration(
      file.content,
      selectedKeys,
      file.relPath,
      wakeJobBlock,
    );
    if (changed)
      edits.push({
        relPath: file.relPath,
        before: file.content,
        after: content,
      });
  }
  return {
    repo: project.repo,
    label: project.label,
    jobs: picked.map((j) => ({
      workflow: j.relPath,
      job: j.name,
      runs_on: j.runsOn,
    })),
    edits,
  };
}

export async function applyMigratePlan(plan, { dryRun = false } = {}) {
  const root = gitRoot();
  if (dryRun) return plan;
  for (const edit of plan.edits) {
    await writeFile(join(root, edit.relPath), edit.after, "utf8");
  }
  return plan;
}

export async function promptJobSelection(candidates, ask) {
  if (!candidates.length) return [];
  console.error(
    "\nWorkflow jobs that can move to the InstaBox pool (wake + dynamic runs-on):\n",
  );
  candidates.forEach((j, i) => {
    console.error(
      `  ${String(i + 1).padStart(2)}. ${j.relPath} → ${j.name}  (${j.runsOn})`,
    );
  });
  console.error(
    "\nEnter numbers (e.g. 1,3,5), `all`, or a runs-on substring to match (e.g. blacksmith):",
  );
  const answer = (await ask()).trim();
  if (!answer || /^n(o)?$/i.test(answer)) return [];
  if (/^all$/i.test(answer)) return candidates;
  if (/^\d+(,\s*\d+)*$/.test(answer.replace(/\s/g, ""))) {
    const idx = answer.split(",").map((n) => Number(n.trim()) - 1);
    return idx.map((i) => candidates[i]).filter(Boolean);
  }
  const sub = answer.toLowerCase();
  return candidates.filter((j) => j.runsOn.toLowerCase().includes(sub));
}
