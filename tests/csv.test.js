// Tests for app/csv.js. Run all tests with:  node --test tests/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, sniffDelimiter, toCsv, protectCell, unprotectCell } = require('../app/csv');

const fields = (text) => parseCsv(text).records.map((r) => r.fields);

test('simple rows, LF and CRLF line endings', () => {
  assert.deepEqual(fields('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(fields('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(fields('a,b\r\n1,2'), [['a', 'b'], ['1', '2']], 'no newline at end');
});

test('quoted fields with commas, escaped quotes and line breaks', () => {
  const text = 'name,notes\r\n"Smith, Jo","said ""hi""\r\nsecond line"\r\nx,"" \n';
  assert.deepEqual(fields(text), [
    ['name', 'notes'],
    ['Smith, Jo', 'said "hi"\nsecond line'],
    ['x', ' '],
  ]);
});

test('line numbers point at where each record starts', () => {
  const { records } = parseCsv('h\n"a\nb"\n\nc\n');
  assert.deepEqual(records.map((r) => r.line), [1, 2, 5]);
});

test('UTF-8 BOM is ignored', () => {
  assert.deepEqual(fields('﻿first,last\nA,B'), [['first', 'last'], ['A', 'B']]);
});

test('blank lines and delimiter-only lines are skipped', () => {
  assert.deepEqual(fields('a,b\n\n1,2\n,\n  \n3,4\n\n'), [['a', 'b'], ['1', '2'], ['3', '4']]);
});

test('empty fields are kept', () => {
  assert.deepEqual(fields('a,,c\n,,x'), [['a', '', 'c'], ['', '', 'x']]);
});

test('delimiter sniffing: comma, semicolon, tab; quoted delimiters do not count', () => {
  assert.equal(sniffDelimiter('a,b,c\n1;2;3'), ',');
  assert.equal(sniffDelimiter('a;b;c\n1,2,3'), ';');
  assert.equal(sniffDelimiter('a\tb\tc'), '\t');
  assert.equal(sniffDelimiter('"x;y;z",b'), ',');
  assert.equal(sniffDelimiter('\n\nfirst;last'), ';', 'skips leading blank lines');
  assert.equal(sniffDelimiter('single'), ',');
  assert.deepEqual(fields('first;last\n"A;1";B'), [['first', 'last'], ['A;1', 'B']]);
  assert.deepEqual(fields('first\tlast\nA\tB'), [['first', 'last'], ['A', 'B']]);
});

test('unterminated quote is reported, not thrown', () => {
  const r = parseCsv('a,b\n"open,x\n');
  assert.equal(r.unterminatedQuote, true);
  assert.equal(r.records.length, 2);
});

test('stray quote inside an unquoted field is kept as text', () => {
  assert.deepEqual(fields('a,b\n5" tall,x'), [['a', 'b'], ['5" tall', 'x']]);
});

test('export: formula injection protection', () => {
  for (const s of ['=1+1', '+1 555', '-5', '@SUM(A1)', '\tx', '\rx']) {
    assert.equal(protectCell(s), "'" + s);
    assert.equal(unprotectCell(protectCell(s)), s, 'import undoes the export prefix');
  }
  assert.equal(protectCell('Smith'), 'Smith');
  assert.equal(protectCell("'quoted"), "'quoted");
  assert.equal(unprotectCell("'quoted"), "'quoted", 'only strips before a formula character');
  assert.equal(protectCell(null), '');
});

test('export: quoting, BOM and CRLF', () => {
  const out = toCsv([
    ['Name', 'Notes'],
    ['Smith, Jo', 'said "hi"'],
    ['=HYPERLINK("http://x","y")', 'two\nlines'],
  ]);
  assert.ok(out.startsWith('﻿'), 'starts with BOM');
  assert.equal(
    out,
    '﻿Name,Notes\r\n' +
      '"Smith, Jo","said ""hi"""\r\n' +
      '"\'=HYPERLINK(""http://x"",""y"")","two\nlines"\r\n'
  );
});

test('export then parse gives back the same values', () => {
  const rows = [
    ['First', 'Notes'],
    ['Ann', 'a, b'],
    ['+44 20 7946 0000', '"quoted"\nnext line'],
  ];
  const back = parseCsv(toCsv(rows)).records.map((r) => r.fields.map(unprotectCell));
  assert.deepEqual(back, rows);
});
