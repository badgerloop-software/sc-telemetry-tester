/**
 * Inject lat/lon/elev from a route grades CSV into telemetry replay rows.
 *
 * Route files match BSR ASC GPX grades exports:
 *   latitude, longitude, elevation_m, distance_m (step length between points)
 *
 * Modes:
 *   distance — advance along route using speed × Δt (speed field assumed mph by default)
 *   index    — map row i to fraction i/(N-1) along total route length
 */

const { loadReplayFile } = require('./load_replay_file');
const { parseRowTimestampMs } = require('./timestamp');

const MPH_TO_MPS = 0.44704;

function coerceNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function readRoutePoint(row) {
  const lat = coerceNumber(row.latitude ?? row.lat);
  const lon = coerceNumber(row.longitude ?? row.lon);
  const elev = coerceNumber(row.elevation_m ?? row.elev ?? row.elevation);
  const stepM = coerceNumber(row.distance_m) ?? 0;
  if (lat === null || lon === null) return null;
  return { lat, lon, elev: elev ?? 0, stepM: Math.max(0, stepM) };
}

/**
 * @param {string} filePath
 * @returns {{ points: {lat:number, lon:number, elev:number}[], cumulativeM: number[], totalLengthM: number }}
 */
function loadRoute(filePath) {
  const { records } = loadReplayFile(filePath);
  const points = [];
  for (const row of records) {
    const pt = readRoutePoint(row);
    if (pt) points.push(pt);
  }
  if (points.length === 0) {
    throw new Error(`Route file contains no valid latitude/longitude rows: ${filePath}`);
  }

  const cumulativeM = points.map((_, i) =>
    (i === 0 ? 0 : points.slice(0, i).reduce((s, p) => s + p.stepM, 0)),
  );
  const totalLengthM = points.reduce((s, p) => s + p.stepM, 0);

  return {
    points: points.map(({ lat, lon, elev }) => ({ lat, lon, elev })),
    cumulativeM,
    totalLengthM,
  };
}

function sampleRouteAtDistance(route, distanceM) {
  const { points, cumulativeM, totalLengthM } = route;
  if (points.length === 1 || totalLengthM <= 0) {
    return { ...points[0] };
  }

  const d = Math.max(0, Math.min(distanceM, totalLengthM));

  let lo = 0;
  let hi = cumulativeM.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cumulativeM[mid] <= d) lo = mid;
    else hi = mid - 1;
  }

  const i = lo;
  if (i >= points.length - 1) {
    return { ...points[points.length - 1] };
  }

  const d0 = cumulativeM[i];
  const d1 = cumulativeM[i + 1];
  const span = d1 - d0;
  const t = span > 0 ? (d - d0) / span : 0;

  const p0 = points[i];
  const p1 = points[i + 1];
  return {
    lat: p0.lat + t * (p1.lat - p0.lat),
    lon: p0.lon + t * (p1.lon - p0.lon),
    elev: p0.elev + t * (p1.elev - p0.elev),
  };
}

function speedToMps(speed, unit) {
  const s = coerceNumber(speed);
  if (s === null || s < 0) return 0;
  if (unit === 'mps') return s;
  return s * MPH_TO_MPS;
}

function rowTimestampMs(record, rowIndex, timestampColumn, intervalS, startTimeMs) {
  const rawTs = timestampColumn ? record[timestampColumn] : null;
  return parseRowTimestampMs(rawTs, rowIndex, startTimeMs, intervalS);
}

/**
 * @param {object[]} records
 * @param {object} options
 * @param {ReturnType<typeof loadRoute>} options.route
 * @param {'distance'|'index'} options.mode
 * @param {string} [options.speedField]
 * @param {'mph'|'mps'} [options.speedUnit]
 * @param {string} [options.latField]
 * @param {string} [options.lonField]
 * @param {string} [options.elevField]
 * @param {string|null} [options.timestampColumn]
 * @param {number} [options.intervalS]
 * @param {'timestamps'|'fixed_interval'} [options.timeSource] — distance mode only
 */
function injectRouteIntoRecords(records, options) {
  const {
    route,
    mode = 'distance',
    speedField = 'speed',
    speedUnit = 'mph',
    latField = 'lat',
    lonField = 'lon',
    elevField = 'elev',
    timestampColumn = null,
    intervalS = 1,
    timestampsNs = null,
    timeSource = 'timestamps',
  } = options;

  const startTimeMs = Date.now();
  const out = [];
  let cumulativeDistanceM = 0;

  for (let i = 0; i < records.length; i++) {
    const record = { ...records[i] };
    let sampleDistanceM;

    if (mode === 'index') {
      const denom = Math.max(1, records.length - 1);
      const fraction = i / denom;
      sampleDistanceM = fraction * route.totalLengthM;
    } else {
      if (i > 0) {
        let dtS = intervalS;
        if (timeSource === 'timestamps') {
          let tsMs;
          let prevMs;
          if (timestampsNs && timestampsNs[i] != null && timestampsNs[i - 1] != null) {
            tsMs = timestampsNs[i] / 1e6;
            prevMs = timestampsNs[i - 1] / 1e6;
          } else {
            tsMs = rowTimestampMs(record, i, timestampColumn, intervalS, startTimeMs);
            prevMs = rowTimestampMs(records[i - 1], i - 1, timestampColumn, intervalS, startTimeMs);
          }
          if (tsMs >= prevMs) dtS = (tsMs - prevMs) / 1000;
        }
        const mps = speedToMps(records[i - 1][speedField], speedUnit);
        cumulativeDistanceM += mps * dtS;
      }
      cumulativeDistanceM = Math.min(cumulativeDistanceM, route.totalLengthM);
      sampleDistanceM = cumulativeDistanceM;
    }

    const { lat, lon, elev } = sampleRouteAtDistance(route, sampleDistanceM);
    record[latField] = lat;
    record[lonField] = lon;
    record[elevField] = elev;
    out.push(record);
  }

  return out;
}

module.exports = {
  loadRoute,
  sampleRouteAtDistance,
  injectRouteIntoRecords,
  MPH_TO_MPS,
};
