// extension/src/alab-content.js

// Content script for ALAB GradeSim. Runs on alabsms.bulsu.edu.ph.
// ALAB SMS keeps an httpOnly refreshToken cookie for
// alabsms-server.bulsu.edu.ph; POST /api/v1/auth/refresh trades it for a
// short-lived accessToken JWT, which authorizes the read endpoints below.
// It saves only the fields the popup reads. Nothing leaves the browser.
//
// Storage keys written here (same contract as content.js):
//   gradesData  { student_grades: { <termId>: { term, values: [course] } } }
//   fetchedAt   ms timestamp of the last successful fetch
//   lastError   'not-logged-in', 'alab-error' or null
//   newGrades   count of grades ALAB SMS added or changed since the popup last opened
//   enlisted    { <termId>: [[course code, section, type]] } for Room TBA's planner
//   scheduleData  the current term's subjects with meeting times and rooms
//   curriculumData  the student's real BulSU curriculum (program, per-term
//     subjects with status, prerequisites, corequisites) for the planner

(function () {
  'use strict';

  const API = 'https://alabsms-server.bulsu.edu.ph/api/v1';
  const MAX_AGE_MS = 60 * 60 * 1000;
  let inFlight = null;

  async function accessToken() {
    const res = await fetch(`${API}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.accessToken ? data.accessToken : null;
  }

  async function api(token, path) {
    const res = await fetch(`${API}${path}`, {
      credentials: 'include',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(path);
    return res.json();
  }

  // AMIS-shaped term id the popup's ordering math understands: 1 + two-digit
  // start year + term number (1 1st sem, 2 2nd sem, 3 summer/midyear slot).
  // "2026-2027" 2nd Semester -> "1262".
  function termKey(term) {
    const year = String(term && term.academic_year || '').slice(0, 4);
    const n = term && term.term_number;
    if (!/^\d{4}$/.test(year) || ![1, 2, 3].includes(n)) return null;
    return `1${year.slice(2)}${n}`;
  }

  function slimGrades(data) {
    const out = {};
    for (const entry of data.data.terms || []) {
      const term = entry.term || {};
      const key = termKey(term);
      if (!key || !Array.isArray(entry.records)) continue;
      out[key] = {
        term: `${term.term || 'Term'} AY ${term.academic_year || ''}`.trim(),
        values: entry.records.map((r, i) => ({
          id: r.class_enrollment_id ?? `${key}:${(r.subject && r.subject.id) ?? i}`,
          grade: r.grade_code ?? null,
          unit_taken: r.subject && r.subject.units != null ? String(r.subject.units) : '',
          section: r.section && r.section.name ? r.section.name : '',
          status: r.status || '',
          course: {
            course_code: r.subject && r.subject.code,
            title: r.subject && r.subject.title,
          },
          grade_term: { term: term.term, ay: term.academic_year },
          include_in_gwa: r.include_in_gwa !== false,
          is_nstp: !!r.is_nstp,
        })),
      };
    }
    return { student_grades: out };
  }

  const MODE_TYPE = { lecture: 'LEC', laboratory: 'LAB', recitation: 'SEM', seminar: 'SEM' };

  function meetingType(meetings) {
    const types = [...new Set((meetings || []).map(m => MODE_TYPE[m && m.mode] || '').filter(Boolean))];
    return types;
  }

  // Current registration -> { enlisted, scheduleData } in the shapes the popup
  // and Room TBA's planner already understand.
  function slimEnrollment(data) {
    const reg = data && data.registration;
    const out = {};
    const slim = slimCurriculum(data);
    if (slim) out.curriculumData = slim;
    if (!reg || !Array.isArray(reg.subjects)) return out;
    const term = reg.academic_term || {};
    const key = termKey(term);
    const refs = [];
    const subjects = [];
    for (const s of reg.subjects) {
      const offering = s.class_offering;
      const code = s.subject && s.subject.code;
      if (!code) continue;
      const section = offering && offering.section && offering.section.name ? offering.section.name : '';
      const meetings = (offering && offering.meetings) || [];
      const types = meetingType(meetings);
      if (offering) for (const type of types.length ? types : ['']) refs.push([code, section, type]);
      subjects.push({
        code,
        title: s.subject.title || '',
        units: s.units ?? (s.subject && s.subject.units) ?? null,
        section,
        faculty: offering && offering.faculty ? offering.faculty.full_name || '' : '',
        meetings: meetings.map(m => ({
          weekday: m.weekday || '',
          start_time: m.start_time || '',
          end_time: m.end_time || '',
          mode: m.mode || '',
          is_online: !!m.is_online,
          room: m.room ? { code: m.room.code || '', name: m.room.name || '' } : null,
        })),
      });
    }
    out.scheduleData = { term: term.term || '', academic_year: term.academic_year || '', subjects };
    if (key && refs.length) out.enlisted = { [key]: refs };
    return out;
  }

  // The enrollment response's top-level `curriculum` is the student's real
  // BulSU curriculum: one block per {year_level, term_number} listing every
  // subject with its status, units, prerequisites and corequisites. Keep it
  // whole enough for the planner to build the checklist from live data.
  function slimCurriculum(data) {
    const blocks = data && data.curriculum;
    if (!Array.isArray(blocks) || !blocks.length) return null;
    const program = data.registration && data.registration.curriculum;
    return {
      program: program ? {
        id: program.id ?? null,
        code: program.code || '',
        name: program.name || '',
        effective_academic_year: program.effective_academic_year || '',
      } : null,
      student: data.student ? {
        year_level: data.student.year_level ?? null,
        academic_status: data.student.academic_status || '',
      } : null,
      blocks: blocks.map(b => ({
        year_level: b.year_level,
        term_number: b.term_number,
        subjects: (b.subjects || []).map(s => ({
          code: s.subject && s.subject.code,
          title: s.subject && s.subject.title || '',
          units: (s.subject && s.subject.units) ?? null,
          is_elective: !!s.is_elective,
          status: s.status || '',
          prerequisites: (s.prerequisites || []).map(p => ({ code: p.code, passed: !!p.passed })),
          corequisites: (s.corequisites || []).map(c => ({ code: c.code })),
          offered_this_term: !!s.offered_this_term,
          offered_as: (s.offered_as || []).map(a => a.code).filter(Boolean),
        })).filter(s => s.code),
      })),
    };
  }

  async function fetchAll() {
    const token = await accessToken();
    if (!token) return { lastError: 'not-logged-in', portal: 'alab' };
    try {
      const [grades, enrollment] = await Promise.all([
        api(token, '/students/me/grades'),
        api(token, '/enrollment/me').catch(() => null),
      ]);
      if (!grades || !grades.data || !Array.isArray(grades.data.terms)) return { lastError: 'alab-error', portal: 'alab' };
      return {
        gradesData: slimGrades(grades),
        ...slimEnrollment(enrollment),
        fetchedAt: Date.now(),
        lastError: null,
        portal: 'alab',
      };
    } catch (e) {
      return { lastError: 'alab-error', portal: 'alab' };
    }
  }

  function changedGrades(oldData, data) {
    const rows = d => Object.values(d.student_grades).flatMap(t => t.values);
    const before = new Map(rows(oldData).map(v => [v.id, v.grade]));
    return rows(data).filter(v => v.grade != null && String(v.grade).trim() !== '' && before.get(v.id) !== v.grade).length;
  }

  async function refresh(force) {
    if (!force) {
      const { fetchedAt } = await chrome.storage.local.get('fetchedAt');
      if (fetchedAt && Date.now() - fetchedAt < MAX_AGE_MS) return { ok: true, skipped: true, lastError: null, fetchedAt };
    }
    if (!inFlight) {
      inFlight = fetchAll()
        .then(async result => {
          const { gradesData: old } = await chrome.storage.local.get('gradesData');
          const added = old && result.gradesData ? changedGrades(old, result.gradesData) : 0;
          if (added) result.newGrades = added + ((await chrome.storage.local.get('newGrades')).newGrades || 0);
          await chrome.storage.local.set(result);
          return { ok: !result.lastError, lastError: result.lastError, fetchedAt: result.fetchedAt };
        })
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'FETCH_GRADES') return false;
    refresh(!!message.force).then(sendResponse);
    return true;
  });

  refresh(false);
})();
