# Samaya (Obsidian plugin)

Repo: https://github.com/scimone/samaya (public). Plugin id `samaya`.

## Commands
- `npm run build` – typecheck + production bundle to `main.js` (gitignored)
- `npm run dev` – watch build
- `npm test` – run `test/run.mjs`

## Local-only files (never commit)
- `data.json` – user settings, contains a private calendar ICS URL and API tokens. It is gitignored.

## How to release
Releases are built by GitHub Actions (`.github/workflows/release.yml`) when a tag is pushed.
The tag must equal `manifest.json` `version` exactly (no `v` prefix), or the workflow fails.
The workflow attaches `main.js`, `manifest.json`, `styles.css` to a GitHub Release.

Steps when asked to "release" (ask the user for the version if not given; default to a patch bump):
1. Make sure the working tree is committed and `npm run build` and `npm test` pass.
2. Bump `version` in BOTH `manifest.json` and `package.json` (and `package-lock.json`'s top-level version if present) to X.Y.Z.
3. `git commit -am "Release X.Y.Z"` and `git push`.
4. `git tag X.Y.Z && git push origin X.Y.Z`.
5. Verify: `gh run list --limit 1` shows success, and `gh release view X.Y.Z -R scimone/samaya --json assets -q '.assets[].name'` lists the three files.

Users install by copying the three release files into `<vault>/.obsidian/plugins/samaya/`, or via BRAT using `scimone/samaya`.
