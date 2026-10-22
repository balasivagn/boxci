// Static README export of Archify 3.2 HTML; geometry stays renderer-owned.
import { readFile, writeFile } from "node:fs/promises";

const html = await readFile(new URL("boxci.html", import.meta.url), "utf8");
const font = html.match(/<style id="archify-fonts">([\s\S]*?)<\/style>/)?.[1];
const palette = html.match(/\[data-theme="light"\]\s*\{([^}]+)\}/)?.[1];
let svg = html.match(/<svg\b[\s\S]*?<\/svg>/)?.[0];
if (!font || !palette || !svg || !html.includes('content="archify 3.2.0"'))
  throw new Error("Expected Archify 3.2 HTML, font, light palette and SVG.");
const vars = Object.fromEntries(
  [...palette.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]),
);
const resolve = (s) =>
  s.replace(/var\((--[\w-]+)\)/g, (_, name) => {
    if (!(name in vars)) throw new Error(`Unknown SVG color: ${name}`);
    return vars[name];
  });
const rules = [
  ...html.matchAll(
    /(?:^|\n)\s*((?:\.[ctam]-[\w-]+|svg \.s-[\w-]+|svg \.semantic-sigil(?: > \*| \.sigil-fill)?))\s*\{([^{}]*)\}/g,
  ),
]
  .map((m) => `${m[1]} { ${resolve(m[2])} }`)
  .join("\n");
if (!rules.includes(".a-emphasis") || !rules.includes(".c-backend"))
  throw new Error("Expected Archify semantic paint rules.");
const viewBox = svg
  .match(/viewBox="([^"]+)"/)?.[1]
  .split(" ")
  .map(Number);
if (!viewBox || viewBox.length !== 4 || !viewBox.every(Number.isFinite))
  throw new Error("Expected finite SVG viewBox.");
const [x, y, width, height] = viewBox;
svg = resolve(svg.replace(/<style>[\s\S]*?<\/style>/g, ""))
  .replace(/data-animation="trace"/, 'data-animation="none"')
  .replace(
    /<svg /,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `,
  )
  .replace(
    /(<svg[^>]*>)/,
    `$1\n<style><![CDATA[${font}\nsvg { font-family: 'JetBrains Mono', monospace; }\n${rules}\n.c-region { fill: none; stroke: ${vars["--cloud-stroke"]}; stroke-dasharray: 6 4; }\n]]></style>\n<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${vars["--bg"]}"/>`,
  );
await writeFile(
  new URL("boxci.svg", import.meta.url),
  svg.replace(/[ \t]+$/gm, "").trimEnd() + "\n",
);
