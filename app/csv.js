// csv.js - read and write CSV text (hand-written; no libraries).
//
// Reading (parseCsv) follows RFC 4180 and is lenient the way spreadsheet
// programs are:
//   - fields may be wrapped in double quotes; inside quotes, "" is one quote
//     and commas / line breaks are part of the value
//   - lines may end in CRLF (Windows) or LF; line breaks inside a quoted value
//     are normalised to LF
//   - a UTF-8 byte order mark (BOM) at the start is ignored
//   - blank lines (and lines with only delimiters) are skipped
//   - the delimiter is comma, semicolon or tab, guessed from the first line
//     (Excel in many European locales writes semicolons)
// Writing (toCsv) produces what Excel opens cleanly: UTF-8 with BOM, CRLF line
// ends, quotes where needed, and protection against formula injection.

'use strict';

const BOM = '﻿';
const DELIMITERS = [',', ';', '\t'];

// Guess the delimiter by counting candidates in the first non-blank line,
// ignoring anything inside quotes. Ties and no candidates -> comma.
function sniffDelimiter(text) {
  const firstLine = text.replace(/^﻿/, '').split(/\r\n|\n|\r/).find((l) => l.trim() !== '') || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  let best = ',';
  for (const d of DELIMITERS) if (counts[d] > counts[best]) best = d;
  return best;
}

// Parse CSV text into records. Returns
//   { delimiter, records: [{ line, fields: [..] }], unterminatedQuote }
// `line` is the 1-based line number where the record starts, for messages.
function parseCsv(text, delimiter = sniffDelimiter(text)) {
  const src = String(text).replace(/^﻿/, '');
  const records = [];
  let fields = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false; // has this field had any character yet?
  let line = 1; // current line number
  let recordLine = 1; // line where the current record started

  const endField = () => {
    fields.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    // Skip blank lines and lines that contain only delimiters/whitespace.
    if (fields.some((f) => f.trim() !== '')) records.push({ line: recordLine, fields });
    fields = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'; // "" inside quotes = one literal quote
          i++;
        } else {
          inQuotes = false; // closing quote
        }
      } else if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && src[i + 1] === '\n') i++;
        field += '\n'; // line break inside a value, normalised to LF
        line++;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && !fieldStarted) {
      inQuotes = true; // opening quote at the start of a field
      fieldStarted = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      field += ch; // includes a stray quote in the middle of a field (lenient)
      fieldStarted = true;
    }
  }
  const unterminatedQuote = inQuotes;
  if (field !== '' || fields.length > 0 || fieldStarted) endRecord();

  return { delimiter, records, unterminatedQuote };
}

// --- Writing ---------------------------------------------------------------

// Spreadsheet programs treat a cell starting with one of these characters as
// a formula. A guest name like =HYPERLINK("http://evil","click") would then
// become a live link (or worse) when the export is opened in Excel. Prefixing
// a single quote makes Excel show the text as-is.
const FORMULA_START = /^[=+\-@\t\r]/;

function protectCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return FORMULA_START.test(s) ? "'" + s : s;
}

// The reverse, used on import, so an exported file imports back unchanged
// (e.g. a phone number "+1 555 0100" is exported as "'+1 555 0100").
function unprotectCell(value) {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

function quoteCell(s, delimiter = ',') {
  return s.includes('"') || s.includes(delimiter) || s.includes('\n') || s.includes('\r')
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}

// rows: array of arrays (first row = header). Returns the full file text.
function toCsv(rows, { bom = true } = {}) {
  const body = rows.map((row) => row.map((cell) => quoteCell(protectCell(cell))).join(',')).join('\r\n');
  return (bom ? BOM : '') + body + '\r\n';
}

module.exports = { sniffDelimiter, parseCsv, protectCell, unprotectCell, quoteCell, toCsv };
