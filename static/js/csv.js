// Minimal CSV parser for the masking UI's data-grid preview (plan §3.3).
// Handles quoted fields (with embedded commas/quotes/newlines) and both
// \n and \r\n line endings. Deliberately not a full RFC4180 implementation
// (no configurable delimiter, no BOM handling) — enough for the CSV
// fixtures this product deals with today; xlsx preview is a follow-up
// (see datasets-page.js).

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop fully-empty trailing rows (common with a trailing newline).
  while (rows.length && rows[rows.length - 1].every((v) => v === "")) rows.pop();

  const [headers, ...dataRows] = rows;
  return { headers: headers || [], rows: dataRows };
}
