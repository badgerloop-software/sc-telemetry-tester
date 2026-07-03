const TIMESTAMP_CANDIDATES = ['Var1', 'timestamp', 'time', '_time', 'Time (s)'];

function detectTimestampColumn(headers, explicit) {
  if (explicit) {
    if (!headers.includes(explicit)) {
      throw new Error(`Timestamp column '${explicit}' not found in file`);
    }
    return explicit;
  }
  for (const candidate of TIMESTAMP_CANDIDATES) {
    if (headers.includes(candidate)) {
      return candidate;
    }
  }
  return null;
}

function parseRowTimestampMs(rawValue, rowIndex, startTimeMs, intervalS) {
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return startTimeMs + rowIndex * intervalS * 1000;
  }

  if (rawValue instanceof Date) {
    return rawValue.getTime();
  }

  const numeric = Number(rawValue);
  if (Number.isNaN(numeric)) {
    return startTimeMs + rowIndex * intervalS * 1000;
  }

  if (numeric > 1e12) {
    return numeric;
  }
  if (numeric > 1e9) {
    return numeric * 1000;
  }
  return startTimeMs + numeric * 1000;
}

function computeTimestamps(records, timestampColumn, intervalS, shiftToNow) {
  const startTimeMs = Date.now();
  const intervalMs = intervalS * 1000;
  let firstTimestampMs = null;

  return records.map((record, rowIndex) => {
    const rawTs = timestampColumn ? record[timestampColumn] : null;

    if (firstTimestampMs === null && rawTs !== null && rawTs !== undefined && rawTs !== '') {
      firstTimestampMs = parseRowTimestampMs(rawTs, rowIndex, startTimeMs, intervalS);
    }

    let tsMs = parseRowTimestampMs(rawTs, rowIndex, startTimeMs, intervalS);

    if (shiftToNow && firstTimestampMs !== null) {
      const offset = tsMs - firstTimestampMs;
      tsMs = startTimeMs + offset;
    }

    return Math.round(tsMs * 1e6);
  });
}

module.exports = {
  TIMESTAMP_CANDIDATES,
  detectTimestampColumn,
  parseRowTimestampMs,
  computeTimestamps,
};
