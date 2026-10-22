import { homedir } from "node:os";
import { join } from "node:path";

/** Product id on VMs, metadata, and guest install paths. */
export const APP_ID = "boxci";
/** Pre-rebrand app tag; still recognized for adoption. */
export const LEGACY_APP_ID = "instabox-ci";

export const runnerInstallRoot = `${APP_ID}/runners`;
export const legacyRunnerInstallRoot = `${LEGACY_APP_ID}/runners`;

export function ownsVm(metadata, repo) {
  const app = metadata?.app;
  return (app === APP_ID || app === LEGACY_APP_ID) && metadata?.repo === repo;
}

/** Local state directories from before the BoxCI rebrand. */
export function legacyStateDirs() {
  const home = homedir();
  return [
    join(home, "Library", "Application Support", "InstaBox CI"),
    join(process.env.LOCALAPPDATA || home, "InstaBox CI"),
    join(
      process.env.XDG_DATA_HOME || join(home, ".local", "share"),
      LEGACY_APP_ID,
    ),
  ];
}

/** Shell snippet: verify runner registration and service under current or legacy install root. */
export function runnerAdoptVerifyScript(name, repo, shellQuote) {
  const nodeCheck = shellQuote(
    'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1]));if(r.agentName!==' +
      JSON.stringify(name) +
      '||r.gitHubUrl.replace(/\\/$/,"")!==' +
      JSON.stringify("https://github.com/" + repo) +
      ")process.exit(1);",
  );
  return `set -eu
for root in ${runnerInstallRoot} ${legacyRunnerInstallRoot}; do
  dir="$HOME/$root/${name}"
  if [ -f "$dir/.runner" ]; then
    node -e ${nodeCheck} "$dir/.runner"
    systemctl is-active --quiet "$(cat "$dir/.service")"
    exit 0
  fi
done
exit 1
`;
}
