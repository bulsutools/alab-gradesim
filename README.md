# ALAB GradeSim

ALAB GradeSim is a browser extension for BulSU students. It reads your grades from the ALAB SMS portal, works out your GWA, shows what you need for Latin honors, and plans the courses you still have to take.

Not affiliated with BulSU. Unofficial estimate. INC/DRP may not reflect correctly. Always verify with the Registrar's Office.

## Get it

The extension is not published to the app stores yet. Load a build from source:

```sh
bash extension/build.sh all       # chrome, firefox and opera
bash extension/build.sh firefox   # one target; edge is an alias for chrome
for t in extension/*.test.js; do node "$t"; done
```

Load `extension/dist/<browser>/` as an unpacked extension in developer mode. See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch flow.

No extension? The web app at [gradesim.bulsu.tools](https://gradesim.bulsu.tools) does the same math with grades you import or type in.

## What it does

- Reads your grades from ALAB SMS while you're logged in and computes your GWA
- Shows your Latin honors standing and the average you need on your remaining units
- Lists your grades by semester or year, with per-term scholar status
- Lets you leave courses out of the GWA and record substitutions
- Plans your remaining courses term by term on a curriculum map, using real prerequisites. The curriculum data is still the upstream UPLB catalog; BulSU curricula are pending
- Keeps your enrolled classes and schedule for the current term
- Backs up and restores all your data as a JSON file, and clears it with one button

## Privacy

Your grades stay in your browser. The extension calls the ALAB SMS grades API with your own login, keeps only the course fields it needs in `chrome.storage.local`, and sends nothing to any server. There are no analytics. It hands your grades to the web app only when you press Import there. Full policy at [gradesim.bulsu.tools/privacy](https://gradesim.bulsu.tools/privacy/).

## Repository

```text
extension/
  src/         popup, content and background scripts, curriculum data
  manifests/   one manifest per browser
  icons/       16, 32, 48 and 128 px icons
  build.sh     copies src and the right manifest into dist/<browser>/
  *.test.js    node self-checks
```

The web app lives in [bulsutools/gradesim-website](https://github.com/bulsutools/gradesim-website).

## Upstream

Forked from [uplbtools/gradesim](https://github.com/uplbtools/gradesim), the GradeSim extension for UPLB's AMIS portal.

## License

MIT
