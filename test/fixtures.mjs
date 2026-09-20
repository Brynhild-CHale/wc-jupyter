// The notebooks the harnesses run against.
//
// These used to sit in /tmp on one machine, which meant three suites could not
// run on a fresh clone at all — and the ones that did were asserting against
// files earlier runs had already mutated (struct45 opened with a cell a previous
// insert test had added). Seeding fresh per run fixes both: portable, and the
// same starting state every time.
//
// Each notebook is deliberately awkward in one specific way, noted on it. Keep
// them awkward — the tidy parts are what every other harness already covers.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('fs'), path = require('path');

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const FIXTURES = {
  // Everything a save must NOT destroy: attachments, per-cell metadata, a raw
  // cell, notebook-level metadata the spec knows nothing about, and 4.5 ids.
  'roundtrip.ipynb': {
    nbformat: 4, nbformat_minor: 5,
    metadata: {
      authors: [{ name: 'Dev' }],
      custom_top_level: { keep: 'me' },
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
    },
    cells: [
      {
        cell_type: 'markdown', id: 'm1',
        metadata: { jupyter: { source_hidden: false } },
        attachments: { 'dot.png': { 'image/png': PNG_1PX } },
        source: ['# A note with an attachment\n', '\n', '![dot](attachment:dot.png)\n'],
      },
      {
        cell_type: 'code', id: 'keep', execution_count: 3,
        metadata: { collapsed: false, custom_cell_key: 'kept' },
        outputs: [{ output_type: 'execute_result', execution_count: 3, metadata: {}, data: { 'text/plain': ['1'] } }],
        source: ['value = 1\n', 'value'],
      },
      { cell_type: 'raw', id: 'r1', metadata: { format: 'text/latex' }, source: ['\\LaTeX raw cell\n'] },
    ],
  },

  // 4.5: inserts must mint an id, and a save must map cells BY ID so an insert
  // cannot write one cell's text into its neighbour.
  'struct45.ipynb': {
    nbformat: 4, nbformat_minor: 5,
    metadata: { kernelspec: { language: 'python', name: 'python3' } },
    cells: [
      { cell_type: 'code', id: 'a1', execution_count: null, metadata: {}, outputs: [], source: ['first = 1'] },
      {
        cell_type: 'code', id: 'a2', execution_count: 1, metadata: { tags: ['keep'] },
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['two\n'] }],
        source: ['second = 2'],
      },
    ],
  },

  // 4.4: has NO cell ids and must not gain any — introducing them produces a
  // file older readers reject.
  'struct44.ipynb': {
    nbformat: 4, nbformat_minor: 4,
    metadata: { kernelspec: { language: 'python', name: 'python3' } },
    cells: [
      { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: ['legacy = 1'] },
      { cell_type: 'markdown', metadata: {}, source: ['# legacy md'] },
    ],
  },

  // One cell over the per-cell source cap, with real code after it. The cap used
  // to drain across the notebook, so a save wrote empty strings over everything
  // past the big cell — this is the regression test for that data loss.
  'truncation.ipynb': {
    nbformat: 4, nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3', language: 'python' } },
    cells: [
      { cell_type: 'code', id: 'huge', execution_count: null, metadata: {}, outputs: [], source: ['z'.repeat(120000)] },
      { cell_type: 'code', id: 'after1', execution_count: null, metadata: {}, outputs: [], source: ['def critical_analysis():\n', '    return 42'] },
      { cell_type: 'code', id: 'after2', execution_count: null, metadata: {}, outputs: [], source: ["print('also mine')"] },
    ],
  },
};

// Write the named notebooks into `dir`, replacing whatever is there, and clear
// the journal so per-cell undo starts from nothing.
export function seed(dir, ...names) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) {
    const nb = FIXTURES[name];
    if (!nb) throw new Error('no such fixture: ' + name + ' (have: ' + Object.keys(FIXTURES).join(', ') + ')');
    fs.writeFileSync(path.join(dir, name), JSON.stringify(nb, null, 1));
  }
  return names.map((n) => path.join(dir, n));
}

export { FIXTURES };
