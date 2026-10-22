import { readFile } from "node:fs/promises";

export const WAKE_JOB = "boxci-wake";
export const REUSABLE_WAKE_PATH = ".github/workflows/boxci-wake.yml";

export async function wakeScriptBlock() {
  const helper = await readFile(
    new URL("../ci/wake.py", import.meta.url),
    "utf8",
  );
  return helper
    .split("\n")
    .map((l) => (l ? "          " + l : ""))
    .join("\n");
}

export function quoteWorkflow(s) {
  return JSON.stringify(s);
}

/** Inline wake job YAML (same behaviour as generated boxci.yml). */
export async function wakeJobYaml({
  pool_variable = "BOXCI_POOL",
  label,
  secret,
  fallback = "ubuntu-24.04",
  jobName = WAKE_JOB,
}) {
  const block = await wakeScriptBlock();
  const q = quoteWorkflow;
  return `  ${jobName}:
    if: github.event_name != 'pull_request' || github.event.pull_request.draft == false
    runs-on: ubuntu-24.04
    timeout-minutes: 7
    outputs:
      runner: \${{ steps.route.outputs.runner }}
    steps:
      - name: Wake InstaBox pool
        id: route
        env:
          BOXCI_POOL: \${{ vars.${pool_variable} }}
          BOXCI_RUNNER_LABEL: ${q(label)}
          BOXCI_API_KEY: \${{ secrets.${secret} }}
          BOXCI_FALLBACK_LABEL: ${q(fallback)}
          BOXCI_TRUSTED: \${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}
        shell: bash
        run: |
          python3 - <<'BOXCI_WAKE'
${block}
          BOXCI_WAKE
`;
}
