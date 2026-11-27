// alab-curriculum.js - build the planner's course list from the student's real
// BulSU curriculum, captured live from ALAB SMS /enrollment/me (see
// alab-content.js slimCurriculum). The result is shaped like a UPLB_PROGRAMS
// entry plus a per-student catalog, so getPlannerCourses(), enrichCourses()
// and remainingRequirements() work unchanged. Loaded before popup.js; also
// runs under node for tests.
//
// What the live data gives us: every subject's code, title, units, year/term
// slot, pass status, prerequisites (all required, AND) and corequisites.
// What it does not: GE/HK/NSTP/elective slot counts, tracks, specializations,
// or per-semester offering history. Those stay empty - the curriculum is
// authoritative, so no placeholder slots are generated.

// term_number 3 is the summer/midyear term.
const TERM_SEM = { 1: '1', 2: '2', 3: 'midyear' };
const TERM_SEM_LABEL = { 1: '1s', 2: '2s', 3: 'midyear' };

// Same normalization as scheduler.js normCode, duplicated so this file also
// runs standalone under node.
function alabNorm(code) {
  return (code || '').toString().toUpperCase().replace(/\s+/g, ' ').replace(/\.$/, '').trim();
}

// curriculumData.blocks[] -> checklist rows ({code,title,units,year,sem,prereqs})
// plus a catalog entry per code ({units,title,catalogSem,pre,co}) carrying the
// same requisites, since enrichCourses prefers catalog requisites when present.
function alabCourses(curriculumData) {
  const rows = [];
  const catalog = {};
  const seen = new Set();
  ((curriculumData && curriculumData.blocks) || []).forEach(block => {
    const year = block.year_level;
    const sem = TERM_SEM[block.term_number];
    if (!sem) return;
    (block.subjects || []).forEach(s => {
      const code = alabNorm(s.code);
      if (!code || seen.has(code)) return;
      seen.add(code);
      const units = Number(s.units) || 0;
      const prereqs = (s.prerequisites || []).map(p => alabNorm(p.code)).filter(Boolean);
      const co = (s.corequisites || []).map(c => alabNorm(c.code)).filter(c => c && c !== code);
      const catalogSem = TERM_SEM_LABEL[block.term_number] || null;
      rows.push({
        code: s.code,
        title: s.title || '',
        units,
        year,
        sem,
        prereqs,
        catalogSem,
      });
      catalog[code] = {
        units,
        title: s.title || '',
        catalogSem,
        pre: prereqs.map(p => [p]),
        co,
      };
    });
  });
  return { rows, catalog };
}

// A UPLB_PROGRAMS-shaped program built from the live curriculum. Every
// checklist row is a real named subject; genericRequirement slots, tracks and
// specializations stay empty because ALAB SMS already knows the exact list.
// totalUnitsRequired counts only GWA courses, matching what calculateGWA's
// passedUnits accumulates (PE/HK/NSTP rows stay in majorCourses but are
// skipped there too).
function alabProgram(curriculumData, isNonGwa) {
  if (!curriculumData || !Array.isArray(curriculumData.blocks) || !curriculumData.blocks.length) return null;
  const { rows, catalog } = alabCourses(curriculumData);
  if (!rows.length) return null;
  const nonGwa = typeof isNonGwa === 'function' ? isNonGwa : () => false;
  const program = curriculumData.program || {};
  const name = program.name || 'ALAB SMS curriculum';
  return {
    code: 'ALAB',
    name,
    curriculumCode: program.code || '',
    available: true,
    live: true,
    totalUnitsRequired: rows.filter(r => !nonGwa(r.code)).reduce((sum, r) => sum + r.units, 0),
    geCoursesRequired: 0,
    hkCoursesRequired: 0,
    nstpCoursesRequired: 0,
    majorCourses: rows,
    requiredCodes: rows.map(r => alabNorm(r.code)),
    catalog,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { alabProgram, alabCourses, alabNorm, TERM_SEM };
}
