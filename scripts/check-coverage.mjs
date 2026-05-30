import fs from 'fs';
import path from 'path';

const coverageSummaryPath = path.resolve('coverage/coverage-summary.json');
const coverageFinalPath = path.resolve('coverage/coverage-final.json');

if (!fs.existsSync(coverageSummaryPath)) {
  console.error(
    'Error: Coverage summary file not found. Please run "npm run test:coverage" first.',
  );
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(coverageSummaryPath, 'utf8'));
const final = fs.existsSync(coverageFinalPath)
  ? JSON.parse(fs.readFileSync(coverageFinalPath, 'utf8'))
  : null;

console.log('=== Code Coverage Summary ===');
const total = summary.total;
console.log(`Lines:      ${total.lines.pct}% (${total.lines.covered}/${total.lines.total})`);
console.log(
  `Statements: ${total.statements.pct}% (${total.statements.covered}/${total.statements.total})`,
);
console.log(
  `Functions:  ${total.functions.pct}% (${total.functions.covered}/${total.functions.total})`,
);
console.log(
  `Branches:   ${total.branches.pct}% (${total.branches.covered}/${total.branches.total})\n`,
);

console.log('=== Files Needing Coverage Improvement (ordered by uncovered lines) ===');
const files = [];

for (const [file, data] of Object.entries(summary)) {
  if (file === 'total') continue;
  const relativePath = path.relative(process.cwd(), file);

  // Find uncovered lines from coverage-final.json
  const uncoveredLines = [];
  if (final && final[file]) {
    const fileCoverage = final[file];
    const statementMap = fileCoverage.statementMap;
    const s = fileCoverage.s;
    const linesState = {}; // line -> boolean

    // First, map all statements
    for (const [id, count] of Object.entries(s)) {
      const loc = statementMap[id];
      if (!loc) continue;
      const startLine = loc.start.line;
      const endLine = loc.end.line;
      for (let l = startLine; l <= endLine; l++) {
        if (linesState[l] === undefined) {
          linesState[l] = false;
        }
        if (count > 0) {
          linesState[l] = true;
        }
      }
    }

    // Find lines where no statement was covered
    for (const [line, covered] of Object.entries(linesState)) {
      if (!covered) {
        uncoveredLines.push(parseInt(line));
      }
    }
    uncoveredLines.sort((a, b) => a - b);
  }

  files.push({
    path: relativePath,
    pct: data.lines.pct,
    covered: data.lines.covered,
    total: data.lines.total,
    missingCount: data.lines.total - data.lines.covered,
    uncoveredLines,
  });
}

// Sort by missingCount descending, then pct ascending
files.sort((a, b) => {
  if (b.missingCount !== a.missingCount) {
    return b.missingCount - a.missingCount;
  }
  return a.pct - b.pct;
});

// Helper to format line numbers into ranges (e.g. 1-5, 8, 11-13)
function formatRanges(lines) {
  if (lines.length === 0) return 'None';
  const ranges = [];
  let start = lines[0];
  let end = lines[0];

  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === end + 1) {
      end = lines[i];
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = lines[i];
      end = lines[i];
    }
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(', ');
}

files.forEach((f) => {
  if (f.pct === 100) return;
  console.log(`\nFile: ${f.path}`);
  console.log(`  Coverage:      ${f.pct}% (${f.covered}/${f.total} lines)`);
  console.log(`  Missing Lines: ${formatRanges(f.uncoveredLines)}`);
});
