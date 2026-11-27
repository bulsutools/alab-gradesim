# Schedule payload contract

Versioned JSON payload exported by ALAB GradeSim for downstream consumers:
Room TBA (`bulsutools/room-tba#16`), per-section class hubs, planners.
Schedule fields only. **Grades are never included**, by design and by
construction: the payload is built from `GET /enrollment/me` only.
`/students/me/grades` may be read once to recover `student.number` when the
enrollment payload omits it; the grades in that response are discarded in
memory and never stored or exported.

The canonical contract lives in the receiver repo:
`bulsutools/room-tba` → `docs/alab-schedule-bridge.md` and
`docs/alab-schedule-payload.v1.schema.json` (copied verbatim to
`docs/schedule-payload.schema.json` here). This file summarizes what this
exporter emits; when in doubt, the receiver doc wins.

Source endpoint: `https://alabsms-server.bulsu.edu.ph/api/v1/enrollment/me`,
authenticated with the same `POST /auth/refresh` → `accessToken` flow used by
ALAB GradeSim. Recon (room-tba#16 comments) confirmed ALAB SMS exposes
`class_offering.meetings[]` with `weekday`, `start_time`, `end_time`, `mode`,
`is_online`, and `room: {code, name}`; faculty name and section name are also
present. If a deployment omits rooms, `room` is `null` and consumers degrade
to section + time only.

## Payload v1

```json
{
  "schemaVersion": 1,
  "source": "alab-gradesim",
  "exportedAt": "2026-11-22T12:00:00.000Z",
  "term": {
    "label": "2nd Semester AY 2026-2027",
    "schoolYear": "2026-2027",
    "semester": "2"
  },
  "classes": [
    {
      "courseCode": "CPE 307",
      "courseTitle": "OHSP",
      "section": "CPE 3C",
      "type": "LEC",
      "professor": "Jimenez, Monaliza S.",
      "isOnline": false,
      "meetings": [
        {
          "weekday": "M",
          "startTime": "14:00",
          "endTime": "17:00",
          "mode": "LEC",
          "isOnline": false,
          "room": { "code": "NH-509*", "name": "NH 509*" }
        }
      ]
    }
  ]
}
```

Field notes:

- `schemaVersion` is the number `1`. Receivers reject unknown versions.
- `term.id` is omitted: ALAB SMS does not expose the Room TBA `terms.id`, so
  receivers resolve the term from `schoolYear` + `semester` (or `label`).
  `semester` maps ALAB `academic_term.term_number`: 1 → `"1"`, 2 → `"2"`,
  3 → `"midyear"`, matching Room TBA's `terms.semester` values.
- One `classes[]` entry is one section component. Meetings are grouped by
  compact type (`lecture` → `LEC`, `laboratory` → `LAB`,
  `recitation`/`seminar` → `SEM`), so a section meeting as both lecture and
  recitation produces two entries. `meetings[].mode` carries the same
  compact type; unrecognized ALAB modes pass through uppercased (max 12
  chars) rather than being dropped.
- `meetings[].weekday` is emitted in the receiver's compact set
  (`M T W Th F S Su`) regardless of ALAB's raw strings (`Mon`, `wed`,
  `Wednesday`, ...). Meetings with an unparseable weekday, invalid time, or
  `endTime <= startTime` are dropped at export; a component left with zero
  meetings produces no entry.
- `meetings[].startTime`/`endTime` are 24-hour `HH:MM` (seconds stripped).
  `meetings[].room` is `null` when ALAB reports no room code; `name` is
  omitted when empty.
- `professor` is ALAB `class_offering.faculty.full_name`; `isOnline` on a
  class entry is true only when every meeting is online.
- **No student identity in the payload.** No `student` block, no grades,
  no `units`/`sectionTypes`/`faculty` aggregates, and no `signature` block.
  The student number is used only to compute the contribution envelope's
  `studentHash` (below).

Reference implementation: `slimEnrollment` / `slimScheduleData` /
`buildSchedulePayload` in `extension/src/schedule.js` (ported from
bulsutools/alab-grade-tools `src/schedule.js`). Tests: `extension/schedule.test.js`.
In this extension the popup builds the payload from the `scheduleData`
already captured by `src/alab-content.js` — no fresh fetch, no grades, no
student identity.

## URL fragment transport (personal "my classes" view)

"Send to Room TBA" opens:

```
https://room-tba.bulsu.tools/#schedule=<base64url>
```

`<base64url>` is the compact JSON payload (no whitespace) encoded as
base64url, the same bytes `scheduleFragment()` produces. The fragment never
reaches a server, so nothing is published and no auth is needed. The
receiving side parses `location.hash` for `schedule=` and renders the
personal view client-side. Receivers treat every fragment payload as
personal-view data; only signed envelopes feed dataset contribution.

## Contribution envelope (dataset contribution, use case B)

`POST https://room-tba.bulsu.tools/api/contributions/alab-schedule` accepts:

```json
{
  "v": 1,
  "studentHash": "<base64url>",
  "exp": 1730000000,
  "nonce": "<random>",
  "payload": "<base64url of the payload JSON above>",
  "sig": "<base64url HMAC-SHA256>"
}
```

- `payload` is the base64url encoding of the exact compact payload JSON
  bytes. The signature covers that string, so receivers never re-serialize
  JSON.
- `sig = base64url HMAC-SHA256(ALB_BRIDGE_SECRET,
"alab-schedule-v1\n" + studentHash + "\n" + exp + "\n" + nonce + "\n" +
payload)`. `exp` is a unix-seconds timestamp; the exporter sets it to
  now + 24h (`ENVELOPE_TTL_SECONDS`). Receivers reject expired envelopes,
  replayed nonces, and expiry more than 5 minutes of clock skew plus the
  TTL in the future.
- `studentHash = base64url SHA-256(student_number + STUDENT_HASH_SALT)`
  computed by the exporter. Room TBA stores only this hash, for rate
  limiting and audit, and never a raw student number. The hash is inside
  the signature, so it cannot be swapped without the bridge secret.
- What the HMAC proves: the submission came from a holder of the bridge
  secret (an extension build) and is fresh. It does **not** prove
  enrollment; student numbers are not secrets. Reviewers treat every
  contribution as unverified volunteer data.
- Receivers dedupe on the mapping key
  `(courseCode, section, type, roomCode)` normalized; there is no
  exporter-computed signature section list to recompute or verify.

Both `ALB_BRIDGE_SECRET` and `STUDENT_HASH_SALT` are build-time constants in
`extension/src/schedule.js`. **Status in this extension: `BRIDGE_SECRET` is
still the `'[SECRET]'` placeholder** — envelopes built here cannot verify at
the receiver until the real secret is configured (tracked as a TODO in the
source). The URL-fragment path needs no secret and is fully working. The
extension is public, so both are extractable by
anyone who reads the bundle; per the receiver doc they provide origin and
freshness signaling only, not access control. `BRIDGE_SECRET` must match
Room TBA's `ALAB_BRIDGE_SECRET` env var byte for byte: the receiver passes
the env string straight to `createHmac`, so the HMAC key is the UTF-8 bytes
of the string, not a base64 decode. Rotation means bumping the signature
domain (`alab-schedule-v2`) and shipping new constants on both sides.

Reference implementation: `buildContributionEnvelope` /
`verifyContributionEnvelope` (exporter-side self-check mirroring the
receiver's `verifyAlabEnvelopeSignature`) / `envelopeSigningString` in
`extension/src/schedule.js`.
