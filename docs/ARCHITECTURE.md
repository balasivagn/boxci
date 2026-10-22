# BoxCI architecture

BoxCI configures a target GitHub repository from a local CLI. After setup, hosted GitHub Actions jobs wake the InstaBox runner pool independently of the CLI or dashboard.

![BoxCI runtime architecture](architecture/boxci.svg)

[Open the interactive Archify diagram](architecture/boxci.html) after downloading it, or open that file directly from a local checkout. GitHub displays HTML source rather than executing it. The static SVG above works in repository Markdown without hosting or a diagram service.

## Three paths through the system

- **Setup:** `bin/boxci.js` dispatches commands to `App` in `src/engine.js`. It reviews a plan, checks identities, quota, VM names and dedicated runner labels, provisions or verifies runners, writes the pool variable and CI secret, and opens a workflow PR. Setup does not merge it. Private local JSON records retain recovery checkpoints and credential metadata, without secret values.
- **CI:** `src/workflow.js` and `src/wake.js` generate workflow YAML with `ci/wake.py` embedded inline. A hosted Ubuntu job reads the repository secret and pool manifest. For trusted events, the helper calls the InstaBox HTTP API, wakes reviewed members concurrently and checks their services. It outputs runner labels for GitHub scheduling. Fork PRs and failed or incomplete wakes select hosted Ubuntu. The privileged wake phase never checks out PR code.
- **Monitoring:** the optional dashboard calls the local authenticated `GET /api/status` endpoint, which uses `App.status`. The engine reads provider state and GitHub runner/job history. These reads do not execute guest commands or resume VMs. The browser polls every 30 seconds while visible; closing it has no effect on hosted CI.

The “GitHub build job” box represents workflow scheduling; its steps execute on the selected InstaBox runner or hosted Ubuntu. The arrow to the VM pool crosses that runtime boundary. Provider reads and setup operations use the official InstaBox CLI or SDK through `src/provider.js`; GitHub operations use `gh` through `src/github.js`. The hosted Python wake helper calls the provider HTTP API directly.

## Source map

| Responsibility                                 | Source                                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Command dispatch and reviewed setup/operations | [CLI](../bin/boxci.js), [engine](../src/engine.js)                                                                          |
| Official service adapters and tool bootstrap   | [provider](../src/provider.js), [GitHub](../src/github.js), [tooling](../src/tooling.js)                                    |
| Private local records and recovery locking     | [store](../src/store.js)                                                                                                    |
| Workflow generation, migration and CI routing  | [workflow](../src/workflow.js), [wake YAML](../src/wake.js), [migration](../src/migrate.js), [Python helper](../ci/wake.py) |
| Runner install and legacy pool verification    | [installer](../vendor/install.sh), [identity and paths](../src/brand.js)                                                    |
| Loopback dashboard and browser rendering       | [server](../src/dashboard.js), [client](../web/app.js), [visual tokens](../web/tokens.css)                                  |

Service readiness does not prove GitHub connectivity. Hosted fallback is chosen before assignment and cannot rescue a build already queued on a disconnected self-hosted runner. VMs retain normal idle suspension. There is no always-on BoxCI server, keepalive process or webhook service.

## Keep the diagram in the repository

The editable source is [architecture/boxci.architecture.json](architecture/boxci.architecture.json). The source map above connects its components to the current code. The initial public snapshot omits revision-pinned diagram links so it does not depend on private development history. This is a runtime overview; individual SDK calls, renewal steps and migration edits are summarized in the source map above.

The artifacts were generated with [Archify 3.2.0](https://github.com/tt-a1i/archify/tree/25cf37080fc8b1dbe758a4efc3935b55f3327083), tool revision `25cf37080fc8b1dbe758a4efc3935b55f3327083`. Archify is a documentation tool, not a BoxCI runtime dependency. Its generated HTML includes its viewer and fonts, so it can be opened offline. The SVG is a static light-theme export of the same geometry.

After an architecture change:

1. Trace the changed behavior in source. Update the JSON components, connections and source map above. For revision-pinned interactive source links, add `meta.repository` and component `sources` using an existing public commit, then include `--repo-root .` in the Archify command to verify that evidence.
2. Use the pinned Archify skill package, setting `ARCHIFY_CLI` to its `bin/archify.mjs`. From the BoxCI repository root, generate into ignored scratch space so receipts containing local paths stay private:

   ```sh
   ARCHIFY_CLI=/path/to/archify/bin/archify.mjs
   mkdir -p .orca-scratch/architecture-build
   node "$ARCHIFY_CLI" finalize architecture \
     docs/architecture/boxci.architecture.json \
     .orca-scratch/architecture-build/boxci.html \
     --quality showcase \
     --out-dir .orca-scratch/architecture-build/review --json
   ```

3. After the checks pass, copy the portable HTML and regenerate the README image. The exporter uses Node.js built-ins and keeps the Archify-rendered geometry:

   ```sh
   cp .orca-scratch/architecture-build/boxci.html docs/architecture/boxci.html
   node docs/architecture/export-svg.mjs
   ```

4. Inspect the SVG and interactive HTML, then run the documented repository checks. Commit the JSON, HTML, SVG and any source-map edits together. Keep browser profiles, receipts, screenshots and tool downloads in `.orca-scratch/`.

The artifact passed Archify's showcase layout, delivery and strict artifact checks. The source map was checked against the code, and the static SVG was rendered and visually inspected. The automated browser gate could not complete because Chrome's DevTools pipe closed in this execution environment; interactive browser behavior has not been verified here.

The bundled viewer retains Archify's [MIT license](architecture/LICENSE-Archify.txt). Embedded JetBrains Mono fonts include their SIL Open Font License in the HTML and SVG. Existing project and installer notices remain in place.
