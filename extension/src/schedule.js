// extension/src/schedule.js
//
// Schedule export payload, the canonical contract shared with Room TBA
// (bulsutools/room-tba#16; receiver spec: docs/schedule-payload.md and
// docs/schedule-payload.schema.json, ported from bulsutools/alab-grade-tools
// src/schedule.js). Plain script, no ESM: loaded by popup.html and required()
// by schedule.test.js. Pure module: no DOM, no chrome.*; also runs under node.
// Grades are never part of this payload, and no student identity leaves
// this module inside the payload (the student number is used only to
// compute the contribution envelope's studentHash).
//
// Two entry points:
//   slimEnrollment(data, studentHint)  raw GET /enrollment/me response -> slim
//   slimScheduleData(scheduleData, termNumber)  the storage shape written by
//     alab-content.js -> the same slim shape, for the popup's "Send schedule"
// Both feed buildSchedulePayload -> payload v1 -> scheduleFragment ->
// roomTbaScheduleUrl ("#schedule=<base64url>", never reaches a server).

const SCHEDULE_PAYLOAD_VERSION = 1;
const ENVELOPE_VERSION = 1;
const SIGNATURE_DOMAIN = 'alab-schedule-v1';
const ENVELOPE_TTL_SECONDS = 24 * 60 * 60;
// Mirrors the receiver's max-future-skew + TTL bound (signature.ts).
const ENVELOPE_MAX_FUTURE_SKEW_SECONDS = 5 * 60;
const ROOM_TBA_URL = 'https://room-tba.bulsu.tools/';

// Exporter identifier Room TBA records as payload.source (free-form,
// <= 64 chars). The signature domain above must stay 'alab-schedule-v1'.
const SCHEDULE_SOURCE = 'alab-gradesim';

// Bridge credentials shared with Room TBA's ALAB schedule endpoint
// (bulsutools/room-tba docs/alab-schedule-bridge.md). This is a browser
// extension: both values ship inside the bundle and are extractable by
// anyone who reads it. They are not access control; reviewers treat every
// contribution as unverified volunteer data.
//
// TODO(alab-gradesim): BRIDGE_SECRET must match Room TBA's
// ALAB_BRIDGE_SECRET env var byte for byte before the signed contribution
// path (buildContributionEnvelope) can verify. Until the real secret is
// configured, envelope signatures are NOT valid — the URL-fragment path
// (roomTbaScheduleUrl) needs no secret and is the working feature.
// STUDENT_HASH_SALT is mixed into the student hash; Room TBA never sees the
// raw student number. Kept identical to the alab-grade-tools exporter so the
// same student produces the same hash across exporters.
const BRIDGE_SECRET = '[SECRET]'; // TODO: replace with the real ALAB_BRIDGE_SECRET
const STUDENT_HASH_SALT = 'alab-grade-tools:student-hash:v1';

// Raw ALAB SMS meeting.mode -> compact component type. One classes[] entry
// is one section component (LEC/LAB/SEM); unknown modes pass through
// uppercased so receivers still get a usable string.
const MODE_TYPE = { lecture: 'LEC', laboratory: 'LAB', recitation: 'SEM', seminar: 'SEM' };

// ALAB SMS academic_term.term_number -> Room TBA terms.semester
// ('1' | '2' | 'midyear' per room-tba drizzle migrations).
const TERM_SEMESTER = { 1: '1', 2: '2', 3: 'midyear' };

// ALAB SMS meeting.weekday -> canonical compact day. The receiver also
// accepts full English names; we emit the compact form.
const WEEKDAY = {
  m: 'M',
  mon: 'M',
  monday: 'M',
  t: 'T',
  tue: 'T',
  tues: 'T',
  tuesday: 'T',
  w: 'W',
  wed: 'W',
  wednesday: 'W',
  th: 'Th',
  thu: 'Th',
  thur: 'Th',
  thurs: 'Th',
  thursday: 'Th',
  f: 'F',
  fri: 'F',
  friday: 'F',
  s: 'S',
  sat: 'S',
  saturday: 'S',
  su: 'Su',
  sun: 'Su',
  sunday: 'Su',
};

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstString(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
}

function pick(obj, path) {
  let node = obj;
  for (const key of path) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}

function normalizeWeekday(value) {
  const text = normalizeText(value).toLowerCase();
  return WEEKDAY[text] ?? null;
}

// "HH:MM" or "HH:MM:SS" -> "H:MM"/"HH:MM" 24-hour, or null when invalid.
function normalizeTime(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(normalizeText(value));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${match[1]}:${match[2]}`;
}

function timeMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function compactType(mode) {
  const raw = normalizeText(mode);
  return MODE_TYPE[raw.toLowerCase()] ?? raw.toUpperCase().slice(0, 12);
}

// Shared core: one subject's raw meetings -> canonical classes[] entries,
// one per compact component type (LEC/LAB/SEM). Meetings with an
// unparseable weekday, invalid time, end not after start, or unknown-empty
// mode are dropped; a component left with zero meetings produces no entry.
function classEntriesFor(code, title, section, professor, rawMeetings) {
  const byType = new Map();
  for (const m of Array.isArray(rawMeetings) ? rawMeetings : []) {
    const weekday = normalizeWeekday(m && m.weekday);
    const startTime = normalizeTime(m && m.start_time);
    const endTime = normalizeTime(m && m.end_time);
    if (!weekday || !startTime || !endTime) continue;
    // Receiver drops meetings whose end is not after start; skip them here.
    if (timeMinutes(endTime) <= timeMinutes(startTime)) continue;

    const type = compactType(m && m.mode);
    if (!type) continue;
    const room =
      m && m.room && normalizeText(m.room.code)
        ? {
            code: normalizeText(m.room.code),
            ...(normalizeText(m.room.name) ? { name: normalizeText(m.room.name) } : {}),
          }
        : null;
    const meeting = {
      weekday,
      startTime,
      endTime,
      mode: type,
      isOnline: !!(m && m.is_online),
      room,
    };
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(meeting);
  }

  const classes = [];
  for (const [type, meetings] of byType) {
    if (!meetings.length) continue;
    classes.push({
      courseCode: code,
      ...(title ? { courseTitle: title } : {}),
      section,
      type,
      ...(professor ? { professor } : {}),
      isOnline: meetings.every((m) => m.isOnline),
      meetings,
    });
  }
  return classes;
}

// /enrollment/me -> { term, student, classes }. `classes` are already
// canonical payload v1 entries grouped one-per-component-type.
// `student` stays inside this module's return value only; it is never
// copied into the payload; it feeds the contribution envelope's studentHash.
// `studentHint` supplies student_no/full_name when the enrollment payload
// omits them (e.g. read from /students/me/grades; grades themselves are
// discarded).
function slimEnrollment(data, studentHint = {}) {
  const reg = pick(data, ['registration']) ?? pick(data, ['data', 'registration']);
  if (!reg || !Array.isArray(reg.subjects)) return null;

  const term = reg.academic_term || {};
  const student =
    pick(data, ['student']) ?? pick(data, ['data', 'student']) ?? pick(reg, ['student']) ?? {};

  const classes = [];
  for (const s of reg.subjects) {
    const offering = s && s.class_offering;
    const subject = (s && s.subject) || {};
    const code = normalizeText(subject.code);
    if (!code) continue;

    const section = normalizeText(offering && offering.section && offering.section.name);
    const professor = normalizeText(offering && offering.faculty && offering.faculty.full_name);
    const title = normalizeText(subject.title);
    const rawMeetings = offering && offering.meetings;

    classes.push(...classEntriesFor(code, title, section, professor, rawMeetings));
  }

  return {
    term: {
      term: normalizeText(term.term),
      academicYear: normalizeText(term.academic_year),
      termNumber: Number.isInteger(term.term_number) ? term.term_number : null,
    },
    student: {
      number: firstString(
        student.student_no,
        student.studentNumber,
        student.id_number,
        studentHint.student_no,
        studentHint.studentNumber,
      ),
      name: firstString(student.full_name, student.name, studentHint.full_name),
    },
    classes,
  };
}

// The storage shape alab-content.js writes as `scheduleData`
// ({ term, academic_year, subjects: [{code,title,units,section,faculty,
// meetings:[{weekday,start_time,end_time,mode,is_online,room}]}] }) plus an
// optional term_number (added alongside this port; older captures lack it,
// so callers pass the term number recovered from the `enlisted` term key or
// omit it — term.semester is optional in the contract).
// Returns the same slim shape slimEnrollment produces, minus `student`
// (scheduleData never stores identity).
function slimScheduleData(scheduleData, termNumber = null) {
  if (!scheduleData || !Array.isArray(scheduleData.subjects)) return null;

  const classes = [];
  for (const s of scheduleData.subjects) {
    const code = normalizeText(s && s.code);
    if (!code) continue;
    classes.push(
      ...classEntriesFor(
        code,
        normalizeText(s.title),
        normalizeText(s.section),
        normalizeText(s.faculty),
        s.meetings,
      ),
    );
  }

  const n = Number.isInteger(termNumber) ? termNumber : null;
  return {
    term: {
      term: normalizeText(scheduleData.term),
      academicYear: normalizeText(scheduleData.academic_year),
      termNumber: n,
    },
    classes,
  };
}

// Versioned payload v1: the exact shape Room TBA's parseAlabSchedulePayload
// accepts. No student block, no signature block, no units/faculty fields.
function buildSchedulePayload(slim, options = {}) {
  const exportedAt = options.exportedAt ?? options.generatedAt ?? new Date().toISOString();
  const label = [slim.term.term, slim.term.academicYear && `AY ${slim.term.academicYear}`]
    .filter(Boolean)
    .join(' ');
  const semester =
    TERM_SEMESTER[slim.term.termNumber] ??
    (Number.isInteger(slim.term.termNumber) && slim.term.termNumber > 0
      ? String(slim.term.termNumber)
      : null);

  const term = {};
  if (label) term.label = label;
  if (slim.term.academicYear) term.schoolYear = slim.term.academicYear;
  if (semester) term.semester = semester;

  return {
    schemaVersion: SCHEDULE_PAYLOAD_VERSION,
    source: SCHEDULE_SOURCE,
    exportedAt,
    ...(Object.keys(term).length ? { term } : {}),
    classes: slim.classes,
  };
}

/* ---------- Contribution envelope (use case B: dataset contribution) ---------- */
// Contract: bulsutools/room-tba docs/alab-schedule-bridge.md "Signed
// contribution envelope". Envelope =
//   { v:1, studentHash, exp, nonce, payload: <base64url payload JSON>, sig }
//   sig = base64url HMAC-SHA256(secret, "alab-schedule-v1\n" + studentHash
//         + "\n" + exp + "\n" + nonce + "\n" + payload)
// studentHash = base64url SHA-256(student_number + STUDENT_HASH_SALT).
// Receivers dedupe on the mapping key (courseCode|section|type|roomCode),
// not on any exporter-computed ID list.
//
// NOTE: BRIDGE_SECRET is still the '[SECRET]' placeholder, so envelopes
// built here cannot verify at the receiver until the real secret ships.

// Accepts base64 or base64url (sig is base64url).
function base64ToBytes(b64) {
  const std = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesToBase64UrlString(text) {
  const bytes = new TextEncoder().encode(text);
  return bytesToBase64Url(bytes);
}

function base64UrlToString(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function randomNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function sha256Base64Url(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function computeStudentHash(studentNumber) {
  return sha256Base64Url(`${normalizeText(studentNumber)}${STUDENT_HASH_SALT}`);
}

// Canonical signing string. Keep in sync with room-tba signature.ts
// (alabSigningString). Documented in docs/schedule-payload.md.
function envelopeSigningString({ studentHash, exp, nonce, payload }) {
  return [SIGNATURE_DOMAIN, studentHash, String(exp), nonce, payload].join('\n');
}

// The receiver HMACs with the secret env string directly (UTF-8 bytes), so
// the key material here is the string itself, not a base64 decode.
async function hmacKey(secret = BRIDGE_SECRET) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

// Builds the POST body for /api/contributions/alab-schedule. `payload` is the
// object from buildSchedulePayload; it is serialized compactly and base64url
// encoded; receivers verify the signature over those exact bytes and never
// re-serialize. `exp` is unix seconds; defaults to now + ENVELOPE_TTL_SECONDS.
// NOT YET WIRED: BRIDGE_SECRET is a placeholder, so the sig cannot verify.
async function buildContributionEnvelope(payload, options = {}) {
  const studentNumber = options.studentNumber ?? '';
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const ttl = options.ttlSeconds ?? ENVELOPE_TTL_SECONDS;
  const nonce = options.nonce ?? randomNonce();

  const body = {
    v: ENVELOPE_VERSION,
    studentHash: await computeStudentHash(studentNumber),
    exp: nowSeconds + ttl,
    nonce,
    payload: bytesToBase64UrlString(schedulePayloadJson(payload, false)),
  };
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(options.secret),
    new TextEncoder().encode(envelopeSigningString(body)),
  );
  return { ...body, sig: bytesToBase64Url(new Uint8Array(signature)) };
}

// Exporter-side self-check mirroring the receiver's
// verifyAlabEnvelopeSignature: signature, expiry, and far-future bound.
// Receivers additionally enforce nonce replay and rate limits.
async function verifyContributionEnvelope(envelope, options = {}) {
  if (!envelope || envelope.v !== ENVELOPE_VERSION) return false;
  const { studentHash, exp, nonce, payload, sig } = envelope;
  if (
    typeof studentHash !== 'string' ||
    !Number.isInteger(exp) ||
    typeof nonce !== 'string' ||
    typeof payload !== 'string' ||
    typeof sig !== 'string'
  ) {
    return false;
  }
  let ok;
  try {
    ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(options.secret),
      base64ToBytes(sig),
      new TextEncoder().encode(envelopeSigningString({ studentHash, exp, nonce, payload })),
    );
  } catch {
    return false;
  }
  if (!ok) return false;
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (exp <= nowSeconds) return false;
  if (exp > nowSeconds + ENVELOPE_MAX_FUTURE_SKEW_SECONDS + ENVELOPE_TTL_SECONDS) {
    return false;
  }
  return true;
}

/* ---------- Serialization: clipboard, download, URL fragment ---------- */

function schedulePayloadJson(payload, pretty = true) {
  return JSON.stringify(payload, null, pretty ? 2 : 0);
}

// base64url of the compact JSON payload, safe inside a URL fragment.
function scheduleFragment(payload) {
  return bytesToBase64UrlString(schedulePayloadJson(payload, false));
}

// Personal "my classes" view: payload rides in the URL fragment, so it never
// reaches a server log. Receiver contract: room-tba#16.
function roomTbaScheduleUrl(payload, base = ROOM_TBA_URL) {
  return `${base}#schedule=${scheduleFragment(payload)}`;
}

function parseScheduleFragment(fragment) {
  const text = String(fragment ?? '');
  const hash = text.includes('#') ? text.slice(text.indexOf('#') + 1) : text;
  const match = hash.match(/(?:^|&)schedule=([^&]+)/);
  if (!match) return null;
  try {
    return JSON.parse(base64UrlToString(match[1]));
  } catch {
    return null;
  }
}

const SchedulePayload = {
  SCHEDULE_PAYLOAD_VERSION,
  ENVELOPE_VERSION,
  SIGNATURE_DOMAIN,
  ENVELOPE_TTL_SECONDS,
  ENVELOPE_MAX_FUTURE_SKEW_SECONDS,
  ROOM_TBA_URL,
  SCHEDULE_SOURCE,
  BRIDGE_SECRET,
  STUDENT_HASH_SALT,
  normalizeText,
  slimEnrollment,
  slimScheduleData,
  buildSchedulePayload,
  schedulePayloadJson,
  scheduleFragment,
  roomTbaScheduleUrl,
  parseScheduleFragment,
  computeStudentHash,
  envelopeSigningString,
  buildContributionEnvelope,
  verifyContributionEnvelope,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SchedulePayload;
} else {
  window.SchedulePayload = SchedulePayload;
}
