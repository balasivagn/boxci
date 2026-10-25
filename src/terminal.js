import { version } from "./version.js";

const codes = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, cyan: 36 };

export class Terminal {
  constructor({
    stream = process.stderr,
    environment = process.env,
    plain = false,
  } = {}) {
    this.stream = stream;
    this.color =
      !plain &&
      !!stream.isTTY &&
      environment.TERM !== "dumb" &&
      environment.NO_COLOR === undefined;
    this.animate =
      !plain &&
      !!stream.isTTY &&
      environment.TERM !== "dumb" &&
      !environment.CI;
    this.width = Math.max(40, Math.min(100, stream.columns || 88));
    this.timer = null;
    this.current = null;
  }
  paint(tone, value) {
    return this.color ? `\x1b[${codes[tone]}m${value}\x1b[0m` : String(value);
  }
  write(value) {
    this.stream.write(value + "\n");
  }
  wrap(value, prefix = "  ") {
    const lines = [];
    let line = prefix;
    for (const word of String(value).split(/\s+/)) {
      if (
        line.length > prefix.length &&
        line.length + word.length + 1 > this.width
      ) {
        lines.push(line);
        line = " ".repeat(prefix.length) + word;
      } else line += (line === prefix ? "" : " ") + word;
    }
    lines.push(line);
    return lines.join("\n");
  }
  plan(p) {
    this.finish();
    const saved = p.pool.length;
    const mode = p.already_configured
      ? "Already configured"
      : p.incomplete
        ? "Resume saved setup"
        : saved
          ? "Existing runner pool"
          : "New runner setup";
    const lines = [
      "",
      this.paint("bold", `BoxCI v${version} · ${mode}`),
      "",
      `  ${this.paint("dim", "Repository")}  ${this.paint("cyan", p.repo)}`,
      this.paint(
        "dim",
        "  GitHub Actions changes target the repository above.",
      ),
      `  ${this.paint("dim", "InstaBox  ")}  ${p.account.login}`,
      `  ${this.paint("dim", "VM quota  ")}  ${p.quota.used}/${p.quota.max} slots used`,
      `  ${this.paint("dim", "Runners   ")}  ${p.incomplete ? `${saved} saved · target ${p.target_count || saved}` : saved ? `${saved} existing${p.count ? ` + ${p.count} new` : ""}` : `${p.count} new`}`,
    ];
    if (p.incomplete) {
      lines.push(
        `  ${this.paint("dim", "Checkpoint")}  ${p.status.replaceAll("_", " ")}`,
      );
      for (const member of p.pool)
        lines.push(
          `  ${this.paint("green", "Reuse")}       ${member.runner_name}`,
        );
    }
    lines.push(`  ${this.paint("dim", "Routing   ")}  ${p.label}`);
    for (const edit of p.workflow_edits ||
      (p.workflow_edit ? [p.workflow_edit] : []))
      lines.push(`  ${this.paint("dim", "Local file")}  ${edit.relPath}`);
    if (p.command && !p.helper_only)
      lines.push(`  ${this.paint("dim", "Test      ")}  ${p.command}`);
    lines.push(
      "",
      this.paint(
        "bold",
        p.already_configured ? "Verified setup" : "Planned changes",
      ),
    );
    for (const action of p.actions) {
      const value = this.wrap(action, "  • ");
      lines.push(
        /all VMs|ALL account VMs/.test(action)
          ? this.paint("yellow", value)
          : value,
      );
    }
    if (p.pr_url && p.workflow_delivery !== "local")
      lines.push("", "  " + this.paint("cyan", p.pr_url));
    lines.push("");
    this.write(lines.join("\n"));
  }
  step(message) {
    this.finish();
    this.current = message.replace(/…$/, "");
    if (!this.animate) {
      this.write("→ " + this.current);
      return;
    }
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let frame = 0;
    const draw = () =>
      this.stream.write(
        "\r\x1b[2K" +
          this.paint("cyan", frames[frame++ % frames.length]) +
          " " +
          this.current.slice(0, this.width - 3),
      );
    draw();
    this.timer = setInterval(draw, 90);
    this.timer.unref();
  }
  finish(ok = true) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.current && this.animate)
      this.stream.write(
        "\r\x1b[2K" +
          this.paint(ok ? "green" : "red", ok ? "✓" : "✗") +
          " " +
          this.current +
          "\n",
      );
    this.current = null;
  }
}
