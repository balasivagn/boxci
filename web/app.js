const $ = (id) => document.getElementById(id);
let state = null,
  page = 0,
  busy = false;
const pageSize = 8;
const theme =
  localStorage.getItem("boxci-theme") ||
  (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
function setTheme(value) {
  document.documentElement.dataset.theme = value;
  $("theme").textContent = value === "dark" ? "Light mode" : "Dark mode";
  localStorage.setItem("boxci-theme", value);
}
setTheme(theme);
$("theme").onclick = () =>
  setTheme(
    document.documentElement.dataset.theme === "dark" ? "light" : "dark",
  );
function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function safeURL(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === "github.com"
      ? u.href
      : null;
  } catch {
    return null;
  }
}
function badge(text, kind) {
  return el("span", text, "badge " + kind);
}
function detail(label, value) {
  const node = el("div", undefined, "detail");
  node.append(el("span", label), el("span", value));
  return node;
}
function renderJobs() {
  const jobs = state?.jobs || [];
  $("jobs").replaceChildren();
  const start = page * pageSize;
  for (const job of jobs.slice(start, start + pageSize)) {
    const tr = el("tr");
    const result = job.conclusion || job.status;
    const kind =
      result === "success"
        ? "success"
        : ["failure", "timed_out", "cancelled"].includes(result)
          ? "error"
          : result === "in_progress"
            ? "info"
            : "warning";
    const status = el("td");
    status.append(badge(result.replaceAll("_", " "), kind));
    const link = el("td");
    const url = safeURL(job.html_url || job.run_url);
    if (url) {
      const a = el("a", "View ↗");
      a.href = url;
      a.target = "_blank";
      a.rel = "noreferrer";
      link.append(a);
    }
    tr.append(
      el("td", job.name),
      status,
      el("td", job.runner_name || "Awaiting assignment"),
      link,
    );
    $("jobs").append(tr);
  }
  if (!jobs.length) {
    const td = el(
      "td",
      state.history_error
        ? "Job history unavailable. " + state.history_error
        : "No jobs returned for this workflow yet.",
    );
    td.colSpan = 4;
    const tr = el("tr");
    tr.append(td);
    $("jobs").append(tr);
  }
  $("job-count").textContent = jobs.length + " fetched";
  $("page").textContent = jobs.length
    ? `${start + 1}–${Math.min(start + pageSize, jobs.length)} of ${jobs.length}`
    : "No jobs";
  $("previous").disabled = page === 0;
  $("next").disabled = start + pageSize >= jobs.length;
}
function render(data) {
  state = data;
  page = Math.min(
    page,
    Math.max(0, Math.ceil(data.jobs.length / pageSize) - 1),
  );
  $("repo").textContent = data.repo;
  $("account").textContent = `InstaBox account: ${data.account.login}`;
  $("checked").textContent =
    "Checked " + new Date(data.checked_at).toLocaleTimeString();
  $("machines").textContent = data.members.length;
  $("quota").textContent =
    `${data.quota.used}/${data.quota.max} account VM slots used`;
  $("busy").textContent = data.members.filter((m) => m.runner.busy).length;
  $("idle").textContent = data.members.filter(
    (m) => m.runner.status === "online" && !m.runner.busy,
  ).length;
  $("queued").textContent = data.jobs.filter(
    (j) => j.status === "queued",
  ).length;
  $("pool-label").textContent = data.label;
  const localPending = data.workflow_published === false;
  $("migration").hidden = !localPending && (!data.pr || data.pr.merged);
  $("migration-title").textContent = localPending
    ? "Workflow changes are local"
    : "CI migration awaits merge";
  $("migration-detail").textContent = localPending
    ? `Review git diff, then commit and push ${data.workflow_path} through your normal process.`
    : data.pr?.draft
      ? "The runner pool is configured. Normal CI switches after the draft PR is reviewed and merged."
      : "Review the workflow before merging. CI wake works with this dashboard closed.";
  const pr = safeURL(data.pr?.url);
  $("pr").hidden = localPending;
  if (pr) $("pr").href = pr;
  else $("pr").removeAttribute("href");
  $("members").replaceChildren();
  for (const m of data.members) {
    const card = el("article", undefined, "member");
    const top = el("div", undefined, "member-top");
    const vmState =
      m.vm.state === "suspended"
        ? "Paused"
        : m.vm.state[0].toUpperCase() + m.vm.state.slice(1);
    top.append(
      el("h3", m.name),
      badge(vmState, m.vm.state === "running" ? "success" : "warning"),
    );
    const spec = m.vm.spec;
    card.append(
      top,
      el(
        "p",
        `${spec?.vcpus ?? "—"} vCPU / ${spec?.memMiB ? spec.memMiB / 1024 : "—"} GiB RAM`,
        "spec",
      ),
      detail(
        "GitHub runner",
        m.runner.busy
          ? "Busy"
          : m.runner.status === "online"
            ? "Idle"
            : m.runner.status,
      ),
      detail(
        "Idle pause",
        m.vm.autoSuspendAfterSeconds
          ? `${Math.round(m.vm.autoSuspendAfterSeconds / 60)} minutes`
          : "Disabled",
      ),
    );
    const active = data.jobs.find(
      (j) => j.runner_name === m.name && j.status === "in_progress",
    );
    card.append(
      el(
        "p",
        active
          ? active.name
          : m.runner.busy
            ? "GitHub reports active work"
            : m.runner.status === "online"
              ? "Ready for the next job"
              : "No GitHub connection reported",
        "job-line",
      ),
    );
    $("members").append(card);
  }
  $("credential").textContent = data.key_expires_at
    ? "CI credential expires " +
      new Date(data.key_expires_at).toLocaleDateString()
    : "CI credential expiry managed externally";
  renderJobs();
  $("content").hidden = false;
  $("loading").hidden = true;
}
async function refresh() {
  if (busy) return;
  busy = true;
  $("refresh").disabled = true;
  try {
    const response = await fetch("/api/status");
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Unable to check the pool.");
    $("error").hidden = true;
    render(data);
  } catch (error) {
    $("loading").hidden = true;
    $("error-text").textContent = error.message;
    $("error").hidden = false;
  } finally {
    busy = false;
    $("refresh").disabled = false;
  }
}
$("refresh").onclick = refresh;
$("retry").onclick = refresh;
$("previous").onclick = () => {
  if (page > 0) {
    page--;
    renderJobs();
  }
};
$("next").onclick = () => {
  if ((page + 1) * pageSize < state.jobs.length) {
    page++;
    renderJobs();
  }
};
async function start() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const token = hash.get("token");
  history.replaceState(null, "", location.pathname);
  if (token) {
    const result = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!result.ok)
      throw new Error(
        "Dashboard authorization expired. Run boxci dashboard again.",
      );
  }
  await refresh();
  setInterval(() => {
    if (!document.hidden) refresh();
  }, 30000);
}
start().catch((error) => {
  $("loading").hidden = true;
  $("error-text").textContent = error.message;
  $("error").hidden = false;
});
