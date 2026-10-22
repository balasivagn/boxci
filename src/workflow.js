import { wakeJobYaml } from "./wake.js";

export async function workflow({
  pool,
  label,
  secret,
  command,
  manager = "npm",
  managerVersion = "10.17.1",
  pool_variable = "BOXCI_POOL",
}) {
  const quote = (s) => JSON.stringify(s);
  const wake = await wakeJobYaml({ pool_variable, label, secret });
  return `name: BoxCI\n\non:\n  workflow_dispatch:\n  pull_request:\n    types: [opened, synchronize, reopened, ready_for_review]\n\npermissions:\n  contents: read\n\nconcurrency:\n  group: boxci-\${{ github.workflow }}-\${{ github.ref }}\n  cancel-in-progress: true\n\njobs:\n${wake}\n  build:\n    needs: boxci-wake\n    runs-on: \${{ fromJSON(needs.boxci-wake.outputs.runner) }}\n    timeout-minutes: 25\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          persist-credentials: false\n${manager === "pnpm" ? `      - uses: pnpm/action-setup@v4\n        with:\n          version: ${quote(managerVersion)}\n          dest: \${{ runner.temp }}/setup-pnpm\n` : ""}      - uses: actions/setup-node@v4\n        with:\n          node-version: '24'\n      - name: Build and test\n        shell: bash\n        run: ${quote(command)}\n`;
}
