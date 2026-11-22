// Self-check for alab-content.js. Run: node extension/alab-content.test.js
// Loads the script into a fake ALAB SMS page (mocked auth/refresh + API,
// in-memory chrome.storage.local) and checks what it stores.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const SRC = fs.readFileSync(require.resolve('./src/alab-content.js'), 'utf8');

const GRADES_RESPONSE = {
  data: {
    student: { student_no: '2024104115', full_name: 'Santos, John Carlo' },
    terms: [
      {
        term: { academic_year: '2025-2026', term: '1st Semester', term_number: 1, is_summer: false },
        records: [
          {
            class_enrollment_id: 9001,
            subject: { id: 1, code: 'CPE 301', title: 'Circuits', units: 3 },
            section: { name: 'CPE 3C' },
            grade_code: '1.50',
            status: 'passed',
            include_in_gwa: true,
            is_nstp: false,
          },
          {
            class_enrollment_id: 9002,
            subject: { id: 2, code: 'CPE 302', title: 'Lecture No GWA', units: 3 },
            section: { name: 'CPE 3C' },
            grade_code: '2.00',
            status: 'passed',
            include_in_gwa: false,
            is_nstp: false,
          },
        ],
      },
      {
        term: { academic_year: '2026-2027', term: '2nd Semester', term_number: 2, is_summer: false },
        records: [
          {
            class_enrollment_id: 9003,
            subject: { id: 3, code: 'CPE 307', title: 'OHSP', units: 3 },
            section: { name: 'CPE 3C' },
            grade_code: null,
            status: 'missing',
            include_in_gwa: true,
            is_nstp: false,
          },
        ],
      },
    ],
  },
};

const ENROLLMENT_RESPONSE = {
  registration: {
    academic_term: { academic_year: '2026-2027', term: '2nd Semester', term_number: 2 },
    subjects: [
      {
        subject: { code: 'CPE 307', title: 'OHSP', units: 3 },
        units: 3,
        class_offering: {
          section: { name: 'CPE 3C' },
          faculty: { full_name: 'Jimenez, Monaliza S.' },
          meetings: [
            { weekday: 'Mon', start_time: '14:00', end_time: '17:00', mode: 'lecture', is_online: false, room: { code: 'NH-509*', name: 'NH 509*' } },
          ],
        },
      },
      {
        subject: { code: 'CPE 312L', title: 'Digital Logic Lab', units: 1 },
        units: 1,
        class_offering: {
          section: { name: 'CPE 3C' },
          faculty: { full_name: 'Navarra, Lech Walesa' },
          meetings: [
            { weekday: 'Wed', start_time: '09:00', end_time: '12:00', mode: 'laboratory', is_online: false, room: { code: 'EE-201', name: 'EE 201' } },
          ],
        },
      },
      {
        subject: { code: 'NSTP 1', title: 'NSTP', units: 3 },
        units: 3,
        class_offering: null,
      },
    ],
  },
};

async function page({ refreshStatus = 200, gradesStatus = 200, stored = {} }) {
  const store = { ...stored };
  const calls = [];
  let listener;
  const ctx = {
    localStorage: { getItem: () => null },
    fetch: async (url, opts = {}) => {
      calls.push({ url, opts });
      if (url.endsWith('/auth/refresh')) {
        return { ok: refreshStatus === 200, status: refreshStatus, json: async () => ({ accessToken: 'tok' }) };
      }
      if (url.includes('/students/me/grades')) {
        return { ok: gradesStatus === 200, status: gradesStatus, json: async () => GRADES_RESPONSE };
      }
      if (url.includes('/enrollment/me')) {
        return { ok: true, status: 200, json: async () => ENROLLMENT_RESPONSE };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
    chrome: {
      storage: { local: {
        get: async k => (typeof k === 'string' && k in store ? { [k]: store[k] } : {}),
        set: async o => { Object.assign(store, o); },
      } },
      runtime: { onMessage: { addListener: fn => { listener = fn; } } },
    },
  };
  vm.runInNewContext(SRC, ctx);
  await new Promise(r => setTimeout(r, 10));
  const send = msg => new Promise(r => assert.strictEqual(listener(msg, {}, r), true));
  return { store, calls, send };
}

(async () => {
  // Happy path: refresh token, then grades + enrollment stored in AMIS shape.
  let p = await page({});
  assert.strictEqual(p.store.lastError, null);
  assert.strictEqual(p.store.portal, 'alab');
  assert.ok(Date.now() - p.store.fetchedAt < 5000);

  const sg = p.store.gradesData.student_grades;
  assert.deepStrictEqual(Object.keys(sg).sort(), ['1251', '1262']);
  assert.strictEqual(sg['1251'].term, '1st Semester AY 2025-2026');
  const cpe301 = sg['1251'].values.find(v => v.course.course_code === 'CPE 301');
  assert.strictEqual(cpe301.grade, '1.50');
  assert.strictEqual(cpe301.unit_taken, '3');
  assert.strictEqual(cpe301.section, 'CPE 3C');
  assert.strictEqual(cpe301.include_in_gwa, true);
  const noGwa = sg['1251'].values.find(v => v.course.course_code === 'CPE 302');
  assert.strictEqual(noGwa.include_in_gwa, false);

  // Enrollment -> enlisted refs for Room TBA + scheduleData with meetings.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.store.enlisted)), {
    '1262': [['CPE 307', 'CPE 3C', 'LEC'], ['CPE 312L', 'CPE 3C', 'LAB']],
  });
  const sched = p.store.scheduleData;
  assert.strictEqual(sched.academic_year, '2026-2027');
  assert.strictEqual(sched.subjects.length, 3);
  const lec = sched.subjects.find(s => s.code === 'CPE 307');
  assert.strictEqual(lec.meetings[0].room.code, 'NH-509*');
  assert.strictEqual(lec.meetings[0].start_time, '14:00');
  const nstp = sched.subjects.find(s => s.code === 'NSTP 1');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(nstp.meetings)), []);

  // Authorization header used the refreshed token.
  const gradesCall = p.calls.find(c => c.url.includes('/students/me/grades'));
  assert.strictEqual(gradesCall.opts.headers.Authorization, 'Bearer tok');

  // Not logged in: refresh fails -> lastError, still stored with portal.
  p = await page({ refreshStatus: 401 });
  assert.strictEqual(p.store.lastError, 'not-logged-in');
  assert.strictEqual(p.store.portal, 'alab');
  assert.ok(!p.store.gradesData);

  // API failure -> alab-error.
  p = await page({ gradesStatus: 500 });
  assert.strictEqual(p.store.lastError, 'alab-error');

  // Fresh fetchedAt skips the fetch on load; force refresh ignores it.
  const fresh = Date.now();
  p = await page({ stored: { fetchedAt: fresh } });
  assert.ok(!p.calls.some(c => c.url.includes('/students/me/grades')));
  const res = await p.send({ type: 'FETCH_GRADES', force: true });
  assert.strictEqual(res.ok, true);
  assert.ok(p.calls.some(c => c.url.includes('/students/me/grades')));

  console.log('alab-content.test.js: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
