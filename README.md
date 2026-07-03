# SC Telemetry Tester

Simulates the onboard Raspberry Pi CAN reader and **replays CSV/Excel logs into InfluxDB** for deployment testing. This replaces the former `data_replayer/` Python tool in race-profile.

## Architecture

```
Production:   Firmware → Pi (can-telem-cloud) → InfluxDB → inference API
This tester:  CSV / Excel / generated data → InfluxDB → inference API
```

## Setup

```bash
npm install
```

Configure InfluxDB (same env vars as `docker/main.py`):

```bash
export INFLUXDB_URL="https://us-east-1-1.aws.cloud2.influxdata.com"
export INFLUXDB_TOKEN="your-token"
export INFLUXDB_ORG="your-org"
export INFLUXDB_BUCKET="your-bucket"
```

See `.env.example` for optional settings.

## Write modes

| Mode | Env | Line protocol |
|------|-----|----------------|
| **production** (default) | `INFLUX_WRITE_MODE=production` | `telemetry_snapshot,signal=soc value=85.5 <ts_ns>` — matches the car |
| **flat** | `INFLUX_WRITE_MODE=flat` | `telemetry,source=sc_telemetry_tester soc=85.5,pack_power=1500 <ts_ns>` — matches current docker `/predict` defaults |

For end-to-end inference tests against the deployment microservice, use **flat** mode until `/predict` queries the production `signal` tag layout.

## Replay modes

| Mode | Command | Behavior |
|------|---------|----------|
| **Bulk** (default) | `npm run batch` | Writes all rows using CSV timestamps (`Var1` ms epoch if present) |
| **Bulk + recent window** | `--shift-to-now` | Rewrites timestamps to start at now; use with `/predict` `lookback_seconds` |
| **Real-time** | `npm start` | Sleeps `--interval` seconds between rows; loops by default |

### Examples

From race-profile root (after `git submodule update --init`):

```bash
cd tools/sc-telemetry-tester
npm install

# Bulk load training CSV, shifted to current time (works with lookback_seconds)
export INFLUX_WRITE_MODE=flat
node src/replay.js \
  --file ../../data_pipeline/dataProcess/testData/raw_data.csv \
  --shift-to-now

# Simulate live 1 Hz telemetry from generated test data
npm start

# Custom fields (flat mode)
node src/replay.js \
  --file data/test_telemetry.csv \
  --fields soc,pack_power,air_temp,speed \
  --realtime --interval 1 --loop

# Excel replay
node src/replay.js --file path/to/log.xlsx --shift-to-now
```

### CLI flags

| Flag | Description |
|------|-------------|
| `--file` | CSV or Excel path (default: `data/test_telemetry.csv`) |
| `--fields` | Comma-separated fields for flat mode |
| `--measurement` | Override measurement name |
| `--timestamp-column` | Timestamp column (auto-detects `Var1`, `timestamp`, `time`, `_time`, `Time (s)`) |
| `--interval` | Seconds between rows in realtime mode (default: 1) |
| `--realtime` | Sleep between rows |
| `--loop` | Restart from first row after file ends |
| `--shift-to-now` | Rewrite CSV timestamps relative to now |
| `--max-rows` | Cap rows written |

## End-to-end test (race-profile)

1. **Load telemetry** (terminal 1):

   ```bash
   cd tools/sc-telemetry-tester
   export INFLUX_WRITE_MODE=flat
   node src/replay.js \
     --file ../../data_pipeline/dataProcess/testData/raw_data.csv \
     --shift-to-now
   ```

2. **Start inference** (terminal 2): see `docker/README.md`

3. **Query** (terminal 3):

   ```bash
   curl -X POST http://127.0.0.1:8000/predict \
     -H "Content-Type: application/json" \
     -d '{"lookback_seconds": 300, "fields": ["soc", "pack_power", "air_temp"]}'
   ```

## Other commands

```bash
npm run generate        # Create test_telemetry.csv from format.json
npm test                # Verify Influx connection and write permission
```

## File structure

```
sc-telemetry-tester/
├── data/
│   ├── data_format.json      # Fallback copy of signal schema
│   └── test_telemetry.csv    # Generated test drive cycle
├── src/
│   ├── influx_client.js      # Influx v2 line-protocol writer
│   ├── load_replay_file.js   # CSV / Excel loader
│   ├── timestamp.js          # Timestamp detection and shift-to-now
│   ├── replay.js             # Main replay CLI
│   ├── generate_test_data.js
│   └── test_connection.js
└── package.json
```

## Data format

Signal definitions live in [`sc-data-format`](https://github.com/badgerloop-software/sc-data-format) (`format.json`). When cloned as a sibling under `tools/` in race-profile:

```
tools/sc-data-format/format.json   ← canonical
tools/sc-telemetry-tester/          ← this repo
```

Do **not** nest `sc-data-format` as a submodule inside this repo; keep them as flat siblings in race-profile.
