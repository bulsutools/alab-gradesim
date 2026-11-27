// Fixture-driven check for the ALAB SMS path. Run: node extension/alab-fixture.test.js
// Loads the REAL /students/me/grades and /enrollment/me responses captured from
// alabsms-server.bulsu.edu.ph (fixtures/alab-*.json, student identity scrubbed)
// through alab-content.js, then checks the stored shapes and the planner's
// remaining-units count built from the live curriculum.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const SRC = fs.readFileSync(require.resolve('./src/alab-content.js'), 'utf8');
const GRADES = JSON.parse(fs.readFileSync(require.resolve('./fixtures/alab-grades.json'), 'utf8'));
const ENROLL = JSON.parse(fs.readFileSync(require.resolve('./fixtures/alab-enroll.json'), 'utf8'));

async function page() {
  const store = {};
  let listener;
  const ctx = {
    localStorage: { getItem: () => null },
    fetch: async url => {
      if (url.endsWith('/auth/refresh')) return { ok: true, status: 200, json: async () => ({ accessToken: 'tok' }) };
      if (url.includes('/students/me/grades')) return { ok: true, status: 200, json: async () => GRADES };
      if (url.includes('/enrollment/me')) return { ok: true, status: 200, json: async () => ENROLL };
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
  return { store, send: msg => new Promise(r => listener(msg, {}, r)) };
}

(async () => {
  const { store } = await page();
  assert.strictEqual(store.lastError, null);
  assert.strictEqual(store.portal, 'alab');

  // --- gradesData: every term the API returned, in AMIS term-id shape ---
  const sg = store.gradesData.student_grades;
  assert.deepStrictEqual(Object.keys(sg).sort(),
    ['1241', '1242', '1243', '1251', '1252', '1253', '1261', '1262']);
  const term1261 = sg['1261'];
  assert.strictEqual(term1261.term, '1st Semester AY 2026-2027');
  assert.strictEqual(term1261.values.length, 10);
  const cpe301 = term1261.values.find(v => v.course.course_code === 'CPE 301');
  assert.strictEqual(cpe301.grade, '2.25');
  assert.strictEqual(cpe301.unit_taken, '3');
  assert.strictEqual(cpe301.status, 'passed');
  assert.strictEqual(cpe301.include_in_gwa, true);
  // HEIMS rows have no class_enrollment_id or section: the fallback id and the
  // empty section must still be stable and shaped right.
  const heimS = term1261.values.find(v => v.course.course_code === 'STS 101') ||
    Object.values(sg).flatMap(t => t.values).find(v => v.section === '');
  assert.ok(heimS.id, 'fallback id present');
  assert.strictEqual(heimS.section, '');
  // Missing grades stay in the data with grade null.
  const missing = sg['1262'].values.every(v => v.grade === null && v.status === 'missing');
  assert.ok(missing, 'current term is all missing grades');

  // --- enlisted + scheduleData for the current term ---
  assert.deepStrictEqual(Object.keys(store.enlisted), ['1262']);
  assert.strictEqual(store.enlisted['1262'].length, 11);
  assert.ok(store.enlisted['1262'].every(r => r[0].startsWith('CPE')));
  const sched = store.scheduleData;
  assert.strictEqual(sched.academic_year, '2026-2027');
  assert.strictEqual(sched.term, '2nd Semester');
  assert.strictEqual(sched.subjects.length, 11);
  const lab = sched.subjects.find(s => s.code === 'CPE 312L');
  assert.strictEqual(lab.meetings[0].mode, 'laboratory');
  assert.strictEqual(lab.meetings[0].weekday, 'Sat');
  assert.ok(lab.meetings[0].room.code.length > 0);

  // --- curriculumData: the real BulSU curriculum, captured live ---
  const cd = store.curriculumData;
  assert.ok(cd, 'curriculumData stored');
  assert.strictEqual(cd.program.code, 'BSCpE (Revised 2024)');
  assert.strictEqual(cd.program.name, 'Bachelor of Science in Computer Engineering');
  assert.strictEqual(cd.student.year_level, 3);
  assert.strictEqual(cd.blocks.length, 9);
  const allSubjects = cd.blocks.flatMap(b => b.subjects);
  assert.strictEqual(allSubjects.length, 79);
  const ojt = allSubjects.find(s => s.code === 'OJT CPE');
  assert.strictEqual(ojt.status, 'not_taken');
  assert.strictEqual(ojt.units, 5);
  assert.ok(ojt.prerequisites.length > 10, 'OJT lists its prerequisites');
  const cpe203l = allSubjects.find(s => s.code === 'CPE 203L');
  assert.deepStrictEqual(cpe203l.corequisites.map(c => c.code), ['CPE 203']);

  // --- popup pipeline on the fixture: GWA + remaining units ---
  Object.assign(globalThis, require('./src/curriculum.js'), require('./src/scheduler.js'));
  const { alabProgram } = require('./src/alab-curriculum.js');
  const { plannerCourseList, amisCourses, remainingRequirements } = require('./src/requirements.js');
  const { isNonGwaCourseCode } = require('./src/curriculum.js');
  const prog = alabProgram(cd, isNonGwaCourseCode);
  assert.ok(prog, 'live program built');
  assert.strictEqual(prog.name, 'Bachelor of Science in Computer Engineering');
  assert.strictEqual(prog.majorCourses.length, 79);
  assert.strictEqual(prog.live, true);

  const courses = plannerCourseList(prog, null, prog.catalog, null);
  assert.strictEqual(courses.length, 79, 'every curriculum subject survives enrichCourses');
  for (const code of ['RPH-101', 'CPE 210*', 'SSP 101D*', 'PE13', 'OJT CPE']) {
    const c = courses.find(x => x.code === code);
    assert.ok(c, `${code} kept as a checklist row`);
    assert.strictEqual(c.inCatalog, true, `${code} resolved against the live catalog`);
  }

  const passedRows = amisCourses(store.gradesData).filter(r => r.result === 'passed');
  assert.strictEqual(passedRows.length, 51);
  const left = remainingRequirements(courses, passedRows, { substitutions: {}, overrides: {} });
  assert.strictEqual(left.left.length, 28);
  assert.strictEqual(left.units, 55);
  assert.strictEqual(left.gwaUnits, 55);
  // The current term's 11 enlisted subjects plus OJT and 4th year are left,
  // plus the two COE 105 retakes that never earned a passing grade.
  assert.ok(left.left.some(c => c.code === 'CPE 307'));
  assert.ok(left.left.some(c => c.code === 'OJT CPE'));
  assert.ok(left.left.some(c => c.code === 'COE 105'));
  assert.ok(!left.left.some(c => c.code === 'CPE 301'), 'passed courses are not left');

  // --- GWA through the popup's own math ---
  const popup = vm.createContext({ document: { addEventListener() {} } });
  for (const file of ['curriculum.js', 'requirements.js', 'popup.js']) {
    vm.runInContext(fs.readFileSync(require.resolve(`./src/${file}`), 'utf8'), popup, { filename: file });
  }
  const parsed = popup.parseAMISData(store.gradesData);
  assert.strictEqual(parsed.length, 66, 'every grade record parsed');
  const { gwa, totalUnits, passedUnits } = popup.calculateGWA(parsed, new Set());
  // Hand-checked from the fixture: academic units with a posted grade,
  // include_in_gwa honored, NSTP/PE excluded, PE13 (no space) excluded too.
  assert.strictEqual(totalUnits, 110);
  assert.strictEqual(passedUnits, 105);
  assert.ok(Math.abs(gwa - 2.125) < 0.001, `GWA ${gwa}`);

  console.log('alab-fixture.test.js: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
