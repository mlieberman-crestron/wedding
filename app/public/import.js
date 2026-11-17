// import.js - loaded by the CSV import page only.
//
// Reads a CSV file chosen in the browser into the text box, so the page can
// submit a plain form (no file upload handling needed on the server).
// Without JavaScript the file picker stays hidden and pasting still works.
// Plain old JavaScript on purpose: no build step, works in any browser.

(function () {
  'use strict';

  var picker = document.getElementById('file-picker');
  var input = document.getElementById('csv-file');
  var textarea = document.getElementById('csv');
  var status = document.getElementById('file-status');
  if (!picker || !input || !textarea || !window.FileReader) return;

  var MAX_BYTES = 1500000; // keeps the form under the server's 2 MB limit

  picker.hidden = false;

  function read(file, encoding, done) {
    var reader = new FileReader();
    reader.onload = function () { done(String(reader.result)); };
    reader.onerror = function () { status.textContent = 'Could not read the file.'; };
    reader.readAsText(file, encoding);
  }

  input.addEventListener('change', function () {
    var file = input.files && input.files[0];
    if (!file) return;
    if (file.size > MAX_BYTES) {
      status.textContent = 'That file is too large (' + Math.round(file.size / 1024) + ' KB). Split it into smaller files.';
      return;
    }
    read(file, 'UTF-8', function (text) {
      // Excel's plain "CSV (Comma delimited)" format is not UTF-8 but
      // Windows-1252. Read as UTF-8, accented letters turn into the
      // replacement character U+FFFD; if that happens, read it again.
      if (text.indexOf('�') !== -1) {
        read(file, 'windows-1252', function (text2) {
          textarea.value = text2;
          status.textContent = 'Loaded ' + file.name + ' (read as Windows-1252). Check the text, then click Preview.';
        });
        return;
      }
      textarea.value = text;
      status.textContent = 'Loaded ' + file.name + '. Check the text, then click Preview.';
    });
  });
})();
