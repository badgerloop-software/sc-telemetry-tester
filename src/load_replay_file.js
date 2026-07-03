const fs = require('fs');
const path = require('path');

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
}

function coerceCell(value) {
  const trimmed = String(value).trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isNaN(parsed) ? trimmed : parsed;
}

function loadCsv(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split(/\r?\n/);
  if (lines.length === 0) {
    return { headers: [], records: [] };
  }

  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  const records = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = coerceCell(values[index]);
    });
    records.push(row);
  }

  return { headers, records };
}

function loadExcel(filePath) {
  let XLSX;
  try {
    XLSX = require('xlsx');
  } catch {
    throw new Error(
      'Excel replay requires the xlsx package. Run: npm install',
    );
  }

  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { headers, records: rows };
}

function loadReplayFile(filePath) {
  const suffix = path.extname(filePath).toLowerCase();
  if (suffix === '.csv' || suffix === '.txt') {
    return loadCsv(filePath);
  }
  if (suffix === '.xlsx' || suffix === '.xls') {
    return loadExcel(filePath);
  }
  throw new Error(`Unsupported file type: ${suffix}. Use CSV or Excel.`);
}

module.exports = {
  loadReplayFile,
};
