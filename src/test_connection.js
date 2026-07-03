/**
 * Test InfluxDB connection and write permissions.
 */

const { getConfig, isConfigured, printConfigHelp, testInfluxConnection } = require('./influx_client');

async function main() {
  const config = getConfig();

  console.log('SC Telemetry Tester — Connection Test');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!isConfigured(config)) {
    console.error('Error: InfluxDB credentials are not configured.');
    printConfigHelp();
    process.exit(1);
  }

  console.log(`URL: ${config.url}`);
  console.log(`Org: ${config.org}`);
  console.log(`Bucket: ${config.bucket}`);
  console.log(`Write mode: ${config.writeMode}`);
  console.log(`Measurement: ${config.measurement}`);
  if (config.writeMode === 'flat') {
    console.log(`Fields: ${config.flatFields.join(', ')}`);
  }
  console.log(`Token: ${config.token.substring(0, 12)}...`);
  console.log('');

  const results = await testInfluxConnection(config);
  for (const result of results) {
    const icon = result.ok ? 'OK' : 'FAIL';
    const detail = result.detail ? ` — ${result.detail}` : '';
    console.log(`[${icon}] ${result.name}${detail}`);
  }

  const failed = results.some((r) => !r.ok);
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(failed ? 'Connection test completed with failures.' : 'Connection test passed.');
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
