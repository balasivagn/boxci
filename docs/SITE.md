# Project website

The one-page site at `boxci.masalageek.com` is `docs/index.html`, served by GitHub Pages from the `docs/` folder on `main`. It is plain HTML with inline CSS: no build step, no JavaScript and no external assets. `docs/CNAME` holds the custom domain, and `docs/.nojekyll` makes Pages serve `docs/` as-is. None of these files are in the npm package.

Publishing from `docs/` also serves every other committed file in that folder as a static file.

## GitHub Pages settings

1. In the repository, open **Settings > Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**, **Branch** to `main` and the folder to `/docs`, then click **Save**.
3. Under **Custom domain**, enter `boxci.masalageek.com` and click **Save**. `docs/CNAME` already contains this value.
4. After GitHub issues the certificate (this can take up to 24 hours), select **Enforce HTTPS**.

## DNS record (Cloudflare, zone `masalageek.com`)

| Type  | Name    | Target                 | Proxy status          |
| ----- | ------- | ---------------------- | --------------------- |
| CNAME | `boxci` | `balasivagn.github.io` | DNS only (grey cloud) |

- Add the custom domain in the GitHub Pages settings **before** creating the DNS record. A record that points at GitHub Pages without a matching site can let someone else host on the subdomain.
- Point the record at `balasivagn.github.io`, without the repository name.
- Keep the record **DNS only** at least until GitHub has issued the HTTPS certificate.
- Optional but recommended: verify `masalageek.com` under the account's **Settings > Pages > Add a domain**, which asks for a TXT record. Verification stops other GitHub users from claiming the domain.
- Do not use wildcard records such as `*.masalageek.com`.
- If GitHub Pages is ever disabled for this repository, remove the `boxci` record.

Reference: [Managing a custom domain for your GitHub Pages site](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).

## Updating the site

Edit `docs/index.html` and open a PR. Keep every claim to what the **released npm version** does, not what is only on `main`. Check unreleased behaviour against the published package before adding it to the page. Run `npm run check` before pushing; Prettier covers `docs/`.
