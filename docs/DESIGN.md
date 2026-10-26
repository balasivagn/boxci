# Masala Geek visual alignment

The dashboard follows the look of [Masala Geek](https://masalageek.com): white page, warm ink, hairline rules instead of boxes, mono uppercase kickers, medium-weight grotesk headings, pill buttons and 4px corners. Values were read from its public stylesheet on 26 October 2026. `web/tokens.css` holds the mapping. Screen styles consume roles, not individual palette values.

| Role                 | Light            | Dark             |
| -------------------- | ---------------- | ---------------- |
| Page                 | white            | `14 14 12`       |
| Foreground / primary | `14 14 12`       | `245 245 243`    |
| Muted foreground     | `111 111 107`    | `160 160 154`    |
| Hairline border      | `232 230 224`    | white at 10%     |
| Code accent          | ink              | ink (foreground) |
| Corners              | 4px, pills 999px | 4px, pills 999px |

Masala Geek ships a light theme only; the warm dark palette is derived from the same ink and keeps the explicit light/dark switch.

Schibsted Grotesk and JetBrains Mono (Latin subsets) are served locally, with their SIL Open Font Licenses in `web/fonts/`, so the strict `font-src 'self'` policy holds and the page makes no third-party requests. Masala Geek's logo and content are not copied. The UI identifies this as CI and as a local dashboard.

Controls: visible focus, semantic buttons, accessible live errors, retry after failure, disabled paging at bounds, tables with headers, responsive single-column runner cards, explicit light/dark switch. The dashboard contains live data, not demo fleet metrics.
