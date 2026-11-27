# ALAB GradeSim extension

Source for the ALAB GradeSim browser extension. Start with the [main README](../README.md) for what it does and where to install it.

![ALAB GradeSim](icons/icon128.png)

## How grades get in

`src/alab-content.js` runs on `alabsms.bulsu.edu.ph` for BulSU students. ALAB SMS keeps an httpOnly refresh-token cookie for `alabsms-server.bulsu.edu.ph`; the script trades it for a short-lived access token and calls the grades and enrollment endpoints once per open. It saves only the fields the popup reads to `chrome.storage.local`:

| Key | Meaning |
| --- | --- |
| `gradesData` | `{ student_grades: { <termId>: { term, values: [...] } } }` with only id, grade, unit_taken, section, status, course code and title, and grade term |
| `fetchedAt` | Time of the last good fetch, in ms |
| `lastError` | `'not-logged-in'`, `'alab-error'` or `null` |
| `portal` | `'alab'` or `'amis'`, whichever portal last wrote the grades |
| `enlisted` | `{ <termId>: [[course code, section, type]] }` for the sem in session and the one being enlisted. Bookmarked classes are left out |
| `scheduleData` | The current term's subjects with meeting times and rooms |
| `curriculumData` | The student's real BulSU curriculum from `/enrollment/me`: program identity plus one block per `{year_level, term_number}` with each subject's code, title, units, status, prerequisites and corequisites. `src/alab-curriculum.js` turns it into the planner's checklist; the popup prefers it over the bundled UPLB programs whenever `portal` is `'alab'` |

It skips the automatic fetch when `fetchedAt` is under an hour old. The popup's Refresh button sends `{ type: 'FETCH_GRADES', force: true }` to the open portal tab, which fetches right away and replies with `{ ok, lastError, fetchedAt }`.

`src/content.js` is the legacy path for UPLB's AMIS portal (`amis.uplb.edu.ph`). It reads the AMIS login token from the page's `localStorage` and calls `https://api-amis.uplb.edu.ph/api/students/grades?summarize=true`, storing the same `gradesData` shape with `portal: 'amis'` and `lastError: 'amis-error'` on failure.

Other keys: `selectedProgram`, `selectedTracks`, `selectedSpecializations` (program code to specialization key), `excludedCourses`, `substitutions`, `customCourseStatus`, `removals` (`<termId>:<code>` to `pass` or `fail` for a 4.00), `plannerPins`, `plannerPetitions`, `plannerOptions`, `theme`, `termsAccepted`, `newGrades` (grades the portal added or changed since the popup last opened, shown as the toolbar badge). Export JSON writes all of them plus `schemaVersion`. Import restores all of them except `termsAccepted`, `lastError` and `newGrades`. `{ type: 'CLEAR_DATA' }` to the background script clears everything.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Keeps grades and settings on your device |
| `alabsms.bulsu.edu.ph`, `alabsms-server.bulsu.edu.ph` | Runs the ALAB SMS content script and lets it call the grades API |
| `amis.uplb.edu.ph`, `api-amis.uplb.edu.ph` | Legacy AMIS content script, kept for students still on that portal |
| `externally_connectable` / `bridge.js` | Lets gradesim.bulsu.tools ask for your grades when you press Import there |

## Build and test

```sh
bash build.sh all
for t in *.test.js; do node "$t"; done
npx -y web-ext@8 lint -s dist/firefox
```

Load `dist/chrome` (Chrome, Edge, Brave, Opera) or `dist/firefox` as an unpacked extension.

## Curriculum data

Programs live in `src/curriculum.js` and the course catalog in `src/catalog.js`. `curriculum.js` is edited by hand now; the upstream generators that produced it were removed with the `scratch/` pipeline.

For ALAB SMS students the checklist is not the bundled data: `curriculumData` (captured live, see above) becomes the program through `src/alab-curriculum.js`, which emits the same shape `getPlannerCourses()`/`enrichCourses()` consume — named rows only, no GE/HK/NSTP placeholder slots, no tracks or specializations (ALAB SMS already knows the exact subject list). The UPLB programs remain the fallback when there is no `curriculumData` or `portal` is not `'alab'`. The live data has no GE/elective slot counts, offering history beyond `offered_this_term`, or standing rules, so the What if counts are exact for named courses but cannot model generic slots.
