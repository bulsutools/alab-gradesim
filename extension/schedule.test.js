// Self-check for src/schedule.js. Run: node extension/schedule.test.js
// Plain node (assert), no vitest — same style as alab-content.test.js.
// Covers the Room TBA schedule payload v1 port: payload shape, term.semester
// mapping, weekday normalization, meeting grouping by type, the storage-shape
// adapter (slimScheduleData), the real ALAB SMS fixture, and the URL-fragment
// round-trip. The contribution-envelope path is exercised with an explicit
// test secret via options.secret; the shipped BRIDGE_SECRET stays a
// '[SECRET]' placeholder until the real ALAB_BRIDGE_SECRET is configured.
const assert = require('assert');
const fs = require('fs');

const S = require('./src/schedule.js');
const FIXTURE = JSON.parse(fs.readFileSync(require.resolve('./fixtures/alab-enroll.json'), 'utf8'));

const ENROLLMENT = {
  registration: {
    academic_term: {
      academic_year: '2026-2027',
      term: '2nd Semester',
      term_number: 2,
    },
    subjects: [
      {
        subject: { code: 'CPE 307', title: 'OHSP', units: 3 },
        units: 3,
        class_offering: {
          section: { name: 'CPE 3C' },
          faculty: { full_name: 'Jimenez, Monaliza S.' },
          meetings: [
            {
              weekday: 'Mon',
              start_time: '14:00',
              end_time: '17:00',
              mode: 'lecture',
              is_online: false,
              room: { code: 'NH-509*', name: 'NH 509*' },
            },
            {
              weekday: 'wed',
              start_time: '09:00:00',
              end_time: '10:30:00',
              mode: 'recitation',
              is_online: false,
              room: { code: 'NH-509*', name: 'NH 509*' },
            },
          ],
        },
      },
      {
        subject: { code: 'CPE 312L', title: 'Digital Logic Lab', units: 1 },
        class_offering: {
          section: { name: 'CPE 3C' },
          faculty: { full_name: 'Navarra, Lech Walesa' },
          meetings: [
            {
              weekday: 'Wednesday',
              start_time: '09:00',
              end_time: '12:00',
              mode: 'laboratory',
              is_online: true,
              room: null,
            },
          ],
        },
      },
      {
        subject: { code: 'NSTP 1', title: 'NSTP', units: 3 },
        class_offering: null,
      },
    ],
  },
};

// The storage shape alab-content.js writes as scheduleData (plus the
// term_number this port adds).
const SCHEDULE_DATA = {
  term: '2nd Semester',
  academic_year: '2026-2027',
  term_number: 2,
  subjects: [
    {
      code: 'CPE 307',
      title: 'OHSP',
      units: 3,
      section: 'CPE 3C',
      faculty: 'Jimenez, Monaliza S.',
      meetings: [
        { weekday: 'Mon', start_time: '14:00', end_time: '17:00', mode: 'lecture', is_online: false, room: { code: 'NH-509*', name: 'NH 509*' } },
        { weekday: 'wed', start_time: '09:00:00', end_time: '10:30:00', mode: 'recitation', is_online: false, room: { code: 'NH-509*', name: 'NH 509*' } },
      ],
    },
    {
      code: 'CPE 312L',
      title: 'Digital Logic Lab',
      units: 1,
      section: 'CPE 3C',
      faculty: 'Navarra, Lech Walesa',
      meetings: [
        { weekday: 'Wednesday', start_time: '09:00', end_time: '12:00', mode: 'laboratory', is_online: true, room: null },
      ],
    },
    { code: 'NSTP 1', title: 'NSTP', units: 3, section: '', faculty: '', meetings: [] },
  ],
};

(async () => {
  // --- slimEnrollment: canonical class entries, one per component type ---
  const slim = S.slimEnrollment(ENROLLMENT, { student_no: '2024104115' });
  assert.deepStrictEqual(slim.term, {
    term: '2nd Semester',
    academicYear: '2026-2027',
    termNumber: 2,
  });
  assert.strictEqual(slim.student.number, '2024104115');
  // CPE 307 has LEC + SEM meetings -> two entries; CPE 312L one LAB; NSTP none.
  assert.strictEqual(slim.classes.length, 3);

  const lec = slim.classes[0];
  assert.deepStrictEqual(
    Object.keys(lec).sort(),
    ['courseCode', 'courseTitle', 'isOnline', 'meetings', 'professor', 'section', 'type'],
  );
  assert.strictEqual(lec.courseCode, 'CPE 307');
  assert.strictEqual(lec.courseTitle, 'OHSP');
  assert.strictEqual(lec.section, 'CPE 3C');
  assert.strictEqual(lec.type, 'LEC');
  assert.strictEqual(lec.professor, 'Jimenez, Monaliza S.');
  assert.strictEqual(lec.isOnline, false);
  assert.deepStrictEqual(lec.meetings, [
    {
      weekday: 'M',
      startTime: '14:00',
      endTime: '17:00',
      mode: 'LEC',
      isOnline: false,
      room: { code: 'NH-509*', name: 'NH 509*' },
    },
  ]);

  const sem = slim.classes[1];
  assert.strictEqual(sem.type, 'SEM');
  // "HH:MM:SS" normalizes to HH:MM; "wed" -> "W".
  assert.deepStrictEqual(sem.meetings[0], {
    weekday: 'W',
    startTime: '09:00',
    endTime: '10:30',
    mode: 'SEM',
    isOnline: false,
    room: { code: 'NH-509*', name: 'NH 509*' },
  });

  const lab = slim.classes[2];
  assert.strictEqual(lab.type, 'LAB');
  assert.strictEqual(lab.isOnline, true);
  assert.strictEqual(lab.meetings[0].weekday, 'W');
  assert.strictEqual(lab.meetings[0].room, null);

  assert.strictEqual(S.slimEnrollment({}), null);
  assert.strictEqual(S.slimEnrollment({ registration: { subjects: 'nope' } }), null);

  // --- term.semester mapping: 1->'1', 2->'2', 3->'midyear' ---
  for (const [n, semester] of [[1, '1'], [2, '2'], [3, 'midyear']]) {
    const s = S.slimScheduleData({ ...SCHEDULE_DATA, term_number: n }, n);
    const p = S.buildSchedulePayload(s, { exportedAt: '2026-11-27T00:00:00.000Z' });
    assert.strictEqual(p.term.semester, semester, `term_number ${n}`);
  }
  // Missing term number -> semester omitted, term still labelled.
  const noNum = S.buildSchedulePayload(S.slimScheduleData({ ...SCHEDULE_DATA, term_number: undefined }, null), {
    exportedAt: '2026-11-27T00:00:00.000Z',
  });
  assert.strictEqual(noNum.term.semester, undefined);
  assert.strictEqual(noNum.term.label, '2nd Semester AY 2026-2027');
  assert.strictEqual(noNum.term.schoolYear, '2026-2027');

  // --- slimScheduleData: the popup's storage-shape adapter ---
  const fromStorage = S.slimScheduleData(SCHEDULE_DATA, 2);
  assert.deepStrictEqual(fromStorage.term, { term: '2nd Semester', academicYear: '2026-2027', termNumber: 2 });
  // Same classes the raw-enrollment path produces (minus student).
  assert.deepStrictEqual(fromStorage.classes, slim.classes);
  assert.strictEqual(S.slimScheduleData(null, 2), null);
  assert.strictEqual(S.slimScheduleData({ subjects: 'nope' }, 2), null);

  // --- payload v1 shape: no student, no signature, no grades ---
  const payload = S.buildSchedulePayload(slim, { exportedAt: '2026-11-22T00:00:00.000Z' });
  assert.strictEqual(payload.schemaVersion, 1);
  assert.strictEqual(payload.source, 'alab-gradesim');
  assert.strictEqual(payload.exportedAt, '2026-11-22T00:00:00.000Z');
  assert.deepStrictEqual(payload.term, {
    label: '2nd Semester AY 2026-2027',
    schoolYear: '2026-2027',
    semester: '2',
  });
  assert.strictEqual(payload.student, undefined);
  assert.strictEqual(payload.signature, undefined);
  assert.strictEqual(payload.classes.length, 3);

  const entry = payload.classes[0];
  assert.deepStrictEqual(Object.keys(entry).sort(), [
    'courseCode',
    'courseTitle',
    'isOnline',
    'meetings',
    'professor',
    'section',
    'type',
  ]);
  for (const key of ['units', 'sectionTypes', 'faculty']) {
    assert.ok(!JSON.stringify(payload).includes(`"${key}"`), key);
  }
  const json = S.schedulePayloadJson(payload);
  assert.ok(!/"(grade|gwa|remarks?|student)"\s*:/i.test(json));
  assert.ok(!json.includes('2024104115'));

  // --- URL fragment round-trip ---
  const url = S.roomTbaScheduleUrl(payload);
  assert.ok(url.startsWith('https://room-tba.bulsu.tools/#schedule='));
  const parsed = S.parseScheduleFragment(url);
  assert.strictEqual(parsed.schemaVersion, 1);
  assert.strictEqual(parsed.source, 'alab-gradesim');
  assert.strictEqual(parsed.classes[0].courseCode, 'CPE 307');
  assert.strictEqual(parsed.classes[0].meetings[0].room.code, 'NH-509*');
  assert.strictEqual(parsed.classes[0].meetings[0].weekday, 'M');
  assert.strictEqual(S.parseScheduleFragment('not-a-fragment'), null);
  assert.strictEqual(S.parseScheduleFragment('#schedule=!!!'), null);

  // --- real ALAB SMS fixture: slimEnrollment -> payload ---
  const realSlim = S.slimEnrollment(FIXTURE, {});
  assert.ok(realSlim, 'fixture has registration.subjects');
  assert.strictEqual(realSlim.term.termNumber, 2);
  assert.strictEqual(realSlim.term.academicYear, '2026-2027');
  assert.ok(realSlim.classes.length > 0);
  const realPayload = S.buildSchedulePayload(realSlim, { exportedAt: '2026-11-27T00:00:00.000Z' });
  assert.strictEqual(realPayload.term.semester, '2');
  assert.strictEqual(realPayload.term.schoolYear, '2026-2027');
  const roundTrip = S.parseScheduleFragment(S.roomTbaScheduleUrl(realPayload));
  assert.deepStrictEqual(roundTrip.classes, realPayload.classes);
  // Fixture faculty name is scrubbed but present; room codes survive.
  const withRoom = realPayload.classes.find(c => c.meetings.some(m => m.room && m.room.code));
  assert.ok(withRoom, 'fixture has at least one room');
  // And the storage path on the same fixture agrees on classes.
  const storageSlim = {
    term: FIXTURE.registration.academic_term.term,
    academic_year: FIXTURE.registration.academic_term.academic_year,
    term_number: FIXTURE.registration.academic_term.term_number,
    subjects: FIXTURE.registration.subjects.map(s => ({
      code: s.subject && s.subject.code,
      title: (s.subject && s.subject.title) || '',
      units: s.units ?? null,
      section: s.class_offering && s.class_offering.section ? s.class_offering.section.name : '',
      faculty: s.class_offering && s.class_offering.faculty ? s.class_offering.faculty.full_name || '' : '',
      meetings: ((s.class_offering && s.class_offering.meetings) || []).map(m => ({
        weekday: m.weekday || '',
        start_time: m.start_time || '',
        end_time: m.end_time || '',
        mode: m.mode || '',
        is_online: !!m.is_online,
        room: m.room ? { code: m.room.code || '', name: m.room.name || '' } : null,
      })),
    })),
  };
  assert.deepStrictEqual(S.slimScheduleData(storageSlim, 2).classes, realSlim.classes);

  // --- contribution envelope: canonical string + self-verify with a test secret ---
  const SECRET = 'test-bridge-secret';
  const now = 1_800_000_000_000;
  const envelope = await S.buildContributionEnvelope(payload, {
    studentNumber: '2024104115',
    now,
    nonce: 'testnonce123456789',
    secret: SECRET,
  });
  assert.strictEqual(envelope.v, 1);
  assert.strictEqual(envelope.exp, Math.floor(now / 1000) + S.ENVELOPE_TTL_SECONDS);
  assert.strictEqual(envelope.nonce, 'testnonce123456789');
  assert.strictEqual(envelope.studentHash, await S.computeStudentHash('2024104115'));
  assert.match(envelope.studentHash, /^[A-Za-z0-9_-]{8,128}$/);
  // Literal-equivalent pin: base64url SHA-256(student_number + salt),
  // computed independently with node:crypto so a silent change fails loudly.
  const expectedHash = require('crypto')
    .createHash('sha256')
    .update(`2024104115${S.STUDENT_HASH_SALT}`)
    .digest('base64url');
  assert.strictEqual(envelope.studentHash, expectedHash);
  const message = S.envelopeSigningString({
    studentHash: envelope.studentHash,
    exp: envelope.exp,
    nonce: envelope.nonce,
    payload: envelope.payload,
  });
  assert.deepStrictEqual(message.split('\n'), [
    'alab-schedule-v1',
    envelope.studentHash,
    String(envelope.exp),
    envelope.nonce,
    envelope.payload,
  ]);
  assert.deepStrictEqual(JSON.parse(Buffer.from(envelope.payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()), payload);
  assert.strictEqual(await S.verifyContributionEnvelope(envelope, { now, secret: SECRET }), true);

  // Expired and tampered envelopes fail.
  const expired = await S.buildContributionEnvelope(payload, {
    studentNumber: '2024104115',
    now: now - (S.ENVELOPE_TTL_SECONDS + 60) * 1000,
    nonce: 'expirednonce12345',
    secret: SECRET,
  });
  assert.strictEqual(await S.verifyContributionEnvelope(expired, { now, secret: SECRET }), false);
  assert.strictEqual(
    await S.verifyContributionEnvelope({ ...envelope, payload: 'AAAA' }, { now, secret: SECRET }),
    false,
  );
  assert.strictEqual(
    await S.verifyContributionEnvelope({ ...envelope, studentHash: 'other' }, { now, secret: SECRET }),
    false,
  );
  // The placeholder secret must NOT verify a receiver-side check unless the
  // receiver happens to use the same placeholder — document the status.
  assert.strictEqual(S.BRIDGE_SECRET, '[SECRET]');

  console.log('schedule.test.js: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
