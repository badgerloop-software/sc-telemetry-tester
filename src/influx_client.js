/**
 * InfluxDB v2 write client — matches can-telem-cloud line protocol.
 *
 * Production (default):
 *   telemetry_snapshot,signal=soc value=85.5 <timestamp_ns>
 *
 * Flat mode (INFLUX_WRITE_MODE=flat) — same layout as docker /predict defaults:
 *   telemetry,source=sc_telemetry_tester soc=85.5,pack_power=1500 <timestamp_ns>
 */

const DEFAULT_MEASUREMENT_PRODUCTION = 'telemetry_snapshot';
const DEFAULT_MEASUREMENT_FLAT = 'telemetry';
const DEFAULT_FIELDS_FLAT = ['soc', 'pack_power', 'air_temp'];
const DEFAULT_SIGNALS_PRODUCTION = [
  'soc',
  'pack_power',
  'pack_current',
  'motor_current',
  'speed',
  'lat',
  'lon',
  'elev',
  'mppt_power_out',
  'air_temp',
];

function requireEnv(name, fallbacks = []) {
  const names = [name, ...fallbacks];
  for (const key of names) {
    const value = process.env[key];
    if (value && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function getConfig() {
  const url = requireEnv('INFLUXDB_URL');
  const token = requireEnv('INFLUXDB_TOKEN', ['INFLUX_TOKEN']);
  const org = requireEnv('INFLUXDB_ORG');
  const bucket = requireEnv('INFLUXDB_BUCKET');
  const writeMode = (process.env.INFLUX_WRITE_MODE || 'production').toLowerCase();
  const isFlat = writeMode === 'flat';

  const measurement = (
    process.env.INFLUXDB_MEASUREMENT ||
    (isFlat ? DEFAULT_MEASUREMENT_FLAT : DEFAULT_MEASUREMENT_PRODUCTION)
  ).trim();

  const fieldsRaw = process.env.INFLUXDB_FIELDS || DEFAULT_FIELDS_FLAT.join(',');
  const flatFields = fieldsRaw.split(',').map((f) => f.trim()).filter(Boolean);

  const signalsRaw = process.env.INFLUXDB_SIGNALS || DEFAULT_SIGNALS_PRODUCTION.join(',');
  const productionSignals = signalsRaw.split(',').map((f) => f.trim()).filter(Boolean);

  return {
    url,
    token,
    org,
    bucket,
    writeMode: isFlat ? 'flat' : 'production',
    measurement,
    flatFields,
    productionSignals,
    tagSource: process.env.INFLUX_TAG_SOURCE || 'sc_telemetry_tester',
  };
}

function isConfigured(config) {
  return Boolean(config.url && config.token && config.org && config.bucket);
}

function printConfigHelp() {
  console.log('\nSet environment variables:');
  console.log('  export INFLUXDB_URL="https://us-east-1-1.aws.cloud2.influxdata.com"');
  console.log('  export INFLUXDB_TOKEN="your-token"');
  console.log('  export INFLUXDB_ORG="your-org"');
  console.log('  export INFLUXDB_BUCKET="your-bucket"');
  console.log('\nOptional:');
  console.log('  export INFLUXDB_MEASUREMENT="telemetry_snapshot"  # production default');
  console.log('  export INFLUX_WRITE_MODE="production"             # or "flat" for inference defaults');
  console.log('  export INFLUXDB_SIGNALS="soc,speed,pack_power,..." # production mode — strategy fields only');
  console.log('  export INFLUXDB_FIELDS="soc,pack_power,air_temp"  # flat mode only');
  console.log('');
}

function escapeTagValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/=/g, '\\=').replace(/ /g, '\\ ');
}

function rowTimestampNs(record, rowIndex, intervalMs) {
  const raw = record.timestamp;
  if (raw !== undefined && raw !== null && raw !== '') {
    const ms = Number(raw);
    if (!Number.isNaN(ms)) {
      if (ms > 1e12) return Math.round(ms * 1e6);
      if (ms > 1e9) return Math.round(ms * 1e9);
      return Math.round(ms * 1e6);
    }
  }
  return Date.now() * 1e6 + rowIndex * intervalMs * 1e6;
}

function isBoolField(name, value) {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number' && (value === 0 || value === 1)) {
    const lower = name.toLowerCase();
    if (
      lower.includes('fault') ||
      lower.includes('enabled') ||
      lower.includes('contactor') ||
      lower.includes('heartbeat') ||
      lower.includes('telem') ||
      lower.endsWith('_en') ||
      lower.includes('brake') ||
      lower === 'eco'
    ) {
      return Number.isInteger(value);
    }
  }
  return false;
}

function coerceNumeric(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const num = Number(value);
  if (Number.isNaN(num) || !Number.isFinite(num)) return null;
  return num;
}

function buildProductionLines(record, timestampNs, measurement, allowedSignals = null) {
  const allow = allowedSignals ? new Set(allowedSignals) : null;
  const lines = [];
  for (const [signal, rawValue] of Object.entries(record)) {
    if (signal === 'timestamp') continue;
    if (allow && !allow.has(signal)) continue;
    const numeric = coerceNumeric(rawValue);
    if (numeric === null) continue;
    const escSignal = escapeTagValue(signal);
    const value = isBoolField(signal, rawValue) ? (numeric ? 1.0 : 0.0) : numeric;
    lines.push(`${measurement},signal=${escSignal} value=${value} ${timestampNs}`);
  }
  return lines;
}

function buildFlatLine(record, timestampNs, measurement, fields, tagSource) {
  const parts = [];
  for (const field of fields) {
    const numeric = coerceNumeric(record[field]);
    if (numeric === null) continue;
    parts.push(`${field}=${numeric}`);
  }
  if (parts.length === 0) return null;
  return `${measurement},source=${escapeTagValue(tagSource)} ${parts.join(',')} ${timestampNs}`;
}

function buildWriteBodyForRows(rows, config) {
  const lines = [];
  for (const { record, timestampNs } of rows) {
    if (config.writeMode === 'flat') {
      const line = buildFlatLine(
        record,
        timestampNs,
        config.measurement,
        config.flatFields,
        config.tagSource,
      );
      if (line) lines.push(line);
    } else {
      lines.push(
        ...buildProductionLines(record, timestampNs, config.measurement, config.productionSignals),
      );
    }
  }
  return lines.join('\n');
}

function buildWriteBody(records, config, { rowIndex = 0, intervalMs = 1000, useNow = false } = {}) {
  const rows = records.map((record, i) => {
    let timestampNs;
    if (useNow) {
      timestampNs = Date.now() * 1e6;
    } else {
      timestampNs = rowTimestampNs(record, rowIndex + i, intervalMs);
    }
    return { record, timestampNs };
  });
  return buildWriteBodyForRows(rows, config);
}

async function writeLines(config, body) {
  if (!body) return { ok: true, lines: 0 };

  const baseUrl = config.url.replace(/\/+$/, '');
  const writeUrl = `${baseUrl}/api/v2/write?org=${encodeURIComponent(config.org)}&bucket=${encodeURIComponent(config.bucket)}&precision=ns`;

  const response = await fetch(writeUrl, {
    method: 'POST',
    headers: {
      Authorization: `Token ${config.token}`,
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Influx write failed: HTTP ${response.status} - ${errorText}`);
  }

  return { ok: true, lines: body.split('\n').filter(Boolean).length };
}

async function testInfluxConnection(config) {
  const results = [];

  results.push({ name: 'Configuration', ok: isConfigured(config) });
  if (!isConfigured(config)) {
    return results;
  }

  const baseUrl = config.url.replace(/\/+$/, '');
  try {
    const health = await fetch(`${baseUrl}/health`);
    results.push({ name: 'Influx /health', ok: health.ok, detail: `HTTP ${health.status}` });
  } catch (error) {
    results.push({ name: 'Influx /health', ok: false, detail: error.message });
  }

  try {
    const ping = await fetch(`${baseUrl}/ping`);
    results.push({ name: 'Influx /ping', ok: ping.ok, detail: `HTTP ${ping.status}` });
  } catch (error) {
    results.push({ name: 'Influx /ping', ok: false, detail: error.message });
  }

  try {
    const testRecord = { timestamp: Date.now(), soc: 100, pack_power: 0, air_temp: 22.5, speed: 0 };
    const body =
      config.writeMode === 'flat'
        ? buildFlatLine(
            testRecord,
            Date.now() * 1e6,
            config.measurement,
            config.flatFields,
            config.tagSource,
          )
        : buildProductionLines(testRecord, Date.now() * 1e6, config.measurement).slice(0, 3).join('\n');

    await writeLines(config, body);
    results.push({ name: 'Write permission', ok: true, detail: `${config.writeMode} mode` });
  } catch (error) {
    results.push({ name: 'Write permission', ok: false, detail: error.message });
  }

  return results;
}

module.exports = {
  getConfig,
  isConfigured,
  printConfigHelp,
  buildWriteBody,
  buildWriteBodyForRows,
  writeLines,
  testInfluxConnection,
  rowTimestampNs,
};
