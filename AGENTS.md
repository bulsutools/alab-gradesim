# GradeSim Extension Agent Guide

**Human developers:** start with [README.md](README.md).

Org-wide agent defaults are in [room-tba/AGENTS.md](https://github.com/bulsutools/room-tba/blob/main/AGENTS.md). This file tailors them to the GradeSim browser extension. Upstream: [uplbtools/gradesim](https://github.com/uplbtools/gradesim).

## Doc map

| When | Read |
| --- | --- |
| How grades get in, storage keys, permissions | [extension/README.md](extension/README.md) |
| Build all browsers | `extension/build.sh` |
| Per-browser manifests | `extension/manifests/` |
| Web app | [bulsutools/gradesim-website](https://github.com/bulsutools/gradesim-website), live at <https://gradesim.bulsu.tools> |
| Store listings | README |

## Stack

- Manifest V3 browser extension in plain JavaScript, no bundler and no root `package.json`
- Targets are Chrome, Firefox and Opera manifests. Edge and Brave install the Chrome build.
- `extension/build.sh [chrome|firefox|opera|edge|all]` writes `extension/dist/<browser>/`. `edge` is an alias for `chrome`.
- Grades come from the ALAB SMS JSON API, not page scraping. `src/alab-content.js` runs on `alabsms.bulsu.edu.ph`, trades the ALAB SMS refresh cookie for an access token, and calls the grades and enrollment endpoints on `alabsms-server.bulsu.edu.ph`, then stores only the fields the popup reads. `src/content.js` is the legacy AMIS path (`api-amis.uplb.edu.ph`) kept for students still on that portal.
- No server. Everything stays in `chrome.storage.local`.

## Branches and release

| Branch | Role |
| --- | --- |
| `staging` | Default branch. All pull requests go here. |
| `main` | Release line. A push that touches `extension/` publishes to the Chrome, Firefox and Edge stores through `.github/workflows/publish-extension.yml`. |

Never push or open pull requests to `main` directly. Store review is human-gated, so do not close issues that wait on store approval.

## Verify before done

| Step | When |
| --- | --- |
| `for t in extension/*.test.js; do node "$t"; done` | Every change (CI runs it too) |
| `bash extension/build.sh all` | Every extension change |
| `npx -y web-ext@8 lint -s extension/dist/firefox` | Must show 0 errors and 0 warnings |
| Manual ALAB SMS check | Load the unpacked build, log in to ALAB SMS, press Refresh in the popup, confirm grades and GWA |
| Manifest diff | When touching permissions, update every file in `extension/manifests/` |

## Extension rules

- Never send grades or student data to a server.
- Keep the stored grades shape (`gradesData.student_grades`) compatible with the web app importer in gradesim-website `src/lib/importers.ts` (repo: bulsutools/gradesim-website).
- Firefox add-on review rejects `innerHTML`, `outerHTML` and `insertAdjacentHTML` with dynamic strings. Build markup with `DOMParser` or DOM calls.
- No decorative motion in the popup. Keep the panel calm and readable.

## Commits

- Conventional Commits, for example `fix(content): ...`, `feat(planner): ...`, `chore(build): ...`
- Note which browsers you tested in the PR body.

## Security

- Do not add `<all_urls>` or other broad permissions without maintainer approval.
- Never send ALAB SMS or AMIS content to analytics or third parties.
