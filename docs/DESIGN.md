# InstaBox visual alignment

Semantic values were inspected from [InstaBox's public stylesheet](https://instabox.sh/assets/a63c38bbfb2fccd1/style.css) on 22 October 2026. `web/tokens.css` holds the mapping. Screen styles consume roles, not individual palette values.

| Role                 | Light         | Dark          |
| -------------------- | ------------- | ------------- |
| Page                 | `247 247 247` | `18 18 18`    |
| Foreground / primary | black         | white         |
| Muted foreground     | `82 82 82`    | `163 163 163` |
| Border               | black at 8%   | white at 8%   |
| Code accent          | sky           | `116 174 234` |
| Corners              | 4 / 6 / 8 px  | 4 / 6 / 8 px  |

The public stylesheet's later dark overrides set page and card to `18 18 18` and primary to foreground. The dashboard follows those overrides rather than applying the earlier emerald primary globally.

Inter and Geist Mono font files were obtained from the same public site's assets, served locally, and accompanied by upstream SIL Open Font Licenses in `web/fonts/`. No provider logo asset is copied. The UI identifies this as CI and as a local dashboard. It is an independent integration, not the provider's account console.

Controls: visible focus, semantic buttons, accessible live errors, retry after failure, disabled paging at bounds, tables with headers, responsive single-column runner cards, explicit light/dark switch. The dashboard contains live data, not demo fleet metrics.
