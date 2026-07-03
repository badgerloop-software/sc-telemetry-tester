/**
 * Replay CSV/Excel telemetry into InfluxDB — simulates Pi → CAN → Influx.
 *
 * Replaces race-profile/data_replayer/replay_to_influx.py
 *
 * Usage:
 *   node src/replay.js --file path/to.csv
 *   node src/replay.js --file path/to.csv --shift-to-now
 *   node src/replay.js --file path/to.csv --realtime --interval 1 --loop
 */

const fs = require('fs');
const path = require('path');
const { loadReplayFile } = require('./load_replay_file');
const { detectTimestampColumn, computeTimestamps } = require('./timestamp');
const {
  getConfig,
  isConfigured,
  printConfigHelp,
  buildWriteBodyForRows,
  writeLines,
} = require('./influx_client');

const DEFAULT_FILE = path.join(__dirname, '../data/test_telemetry.csv');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const args = {
    file: null,
    fields: null,
    measurement: null,
    timestampColumn: null,
    intervalS: 1.0,
    realtime: false,
    maxRows: null,
    loop: false,
    shiftToNow: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--file':
        args.file = path.resolve(argv[++i]);
        break;
      case '--fields':
        args.fields = argv[++i];
        break;
      case '--measurement':
        args.measurement = argv[++i];
        break;
      case '--timestamp-column':
        args.timestampColumn = argv[++i];
        break;
      case '--interval':
        args.intervalS = parseFloat(argv[++i]) || 1.0;
        break;
      case '--max-rows':
        args.maxRows = parseInt(argv[++i], 10);
        break;
      case '--realtime':
        args.realtime = true;
        break;
      case '--loop':
        args.loop = true;
        break;
      case '--shift-to-now':
        args.shiftToNow = true;
        break;
      case 'stream':
        args.realtime = true;
        args.loop = true;
        break;
      case 'batch':
        args.realtime = false;
        break;
      default:
        break;
    }
  }

  if (!args.file) {
    args.file = DEFAULT_FILE;
  }

  return args;
}

function resolveConfig(cliArgs) {
  const config = getConfig();
  if (cliArgs.fields) {
    config.flatFields = cliArgs.fields.split(',').map((f) => f.trim()).filter(Boolean);
  }
  if (cliArgs.measurement) {
    config.measurement = cliArgs.measurement.trim();
  }
  return config;
}

async function writeRows(rows, config, { chunkSize = 50 } = {}) {
  let written = 0;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const body = buildWriteBodyForRows(chunk, config);
    const result = await writeLines(config, body);
    written += result.lines;
    console.log(
      `Wrote rows ${offset + 1}-${Math.min(offset + chunkSize, rows.length)}/${rows.length} (${result.lines} lines)`,
    );
  }
  return written;
}

async function bulkReplay(records, config, cliArgs, timestampColumn) {
  const limit = cliArgs.maxRows ? Math.min(records.length, cliArgs.maxRows) : records.length;
  const slice = records.slice(0, limit);
  const timestampsNs = computeTimestamps(slice, timestampColumn, cliArgs.intervalS, cliArgs.shiftToNow);
  const rows = slice.map((record, index) => ({
    record,
    timestampNs: timestampsNs[index],
  }));

  console.log(`Mode: bulk, measurement=${config.measurement}`);
  if (config.writeMode === 'flat') {
    console.log(`Fields: ${config.flatFields.join(', ')}`);
  }
  if (timestampColumn) {
    console.log(`Timestamp column: ${timestampColumn}`);
  } else {
    console.log(`No timestamp column; synthetic spacing every ${cliArgs.intervalS}s`);
  }
  if (cliArgs.shiftToNow) {
    console.log('Shift to now: enabled');
  }
  console.log('');

  const written = await writeRows(rows, config);
  console.log(`\nReplay complete: wrote ${written} line-protocol points to bucket '${config.bucket}'.`);
  return written;
}

async function realtimeReplay(records, config, cliArgs, timestampColumn) {
  const limit = cliArgs.maxRows ? Math.min(records.length, cliArgs.maxRows) : records.length;
  const intervalMs = Math.round(cliArgs.intervalS * 1000);

  console.log(`Mode: realtime, interval=${cliArgs.intervalS}s, loop=${cliArgs.loop}`);
  console.log(`Records: ${limit}`);
  console.log('Press Ctrl+C to stop.\n');

  let stop = false;
  process.on('SIGINT', () => {
    stop = true;
    console.log('\n\nStopped replay.');
    process.exit(0);
  });

  while (!stop) {
    for (let index = 0; index < limit && !stop; index++) {
      const record = { ...records[index] };
      const timestampsNs = computeTimestamps(
        [record],
        timestampColumn,
        cliArgs.intervalS,
        true,
      );
      const rows = [{ record, timestampNs: timestampsNs[0] }];
      const body = buildWriteBodyForRows(rows, config);
      const result = await writeLines(config, body);

      const soc = typeof record.soc === 'number' ? record.soc.toFixed(1) : 'n/a';
      const speed = typeof record.speed === 'number' ? record.speed.toFixed(1) : 'n/a';
      console.log(
        `[${new Date().toISOString()}] Row ${index + 1}/${limit} | ${result.lines} lines | SOC: ${soc}% | Speed: ${speed} mph`,
      );

      if (index + 1 < limit) {
        await sleep(intervalMs);
      }
    }

    if (!cliArgs.loop || stop) {
      break;
    }
    console.log('Looping replay...\n');
    await sleep(intervalMs);
  }
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  const config = resolveConfig(cliArgs);

  if (!isConfigured(config)) {
    console.error('Error: InfluxDB credentials are not configured.');
    printConfigHelp();
    process.exit(1);
  }

  if (!fs.existsSync(cliArgs.file)) {
    console.error(`Error: Replay file not found: ${cliArgs.file}`);
    console.log('\nRun: npm run generate  to create test data.\n');
    process.exit(1);
  }

  const { headers, records } = loadReplayFile(cliArgs.file);
  if (records.length === 0) {
    console.error('Error: Replay file contains no data rows.');
    process.exit(1);
  }

  const timestampColumn = detectTimestampColumn(headers, cliArgs.timestampColumn);

  console.log(`Loaded ${records.length} rows from ${cliArgs.file}`);
  console.log(`Influx: ${config.url}`);
  console.log(`Write mode: ${config.writeMode}`);

  if (cliArgs.realtime) {
    await realtimeReplay(records, config, cliArgs, timestampColumn);
  } else {
    await bulkReplay(records, config, cliArgs, timestampColumn);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
