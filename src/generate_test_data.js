/**
 * Generate Test Telemetry Data
 * 
 * Creates realistic test data with all 140+ signals from the official firmware format.
 * Simulates a drive cycle: start → accelerate → cruise → decelerate → stop
 */

const fs = require('fs');
const path = require('path');

function loadDataFormat() {
  const candidates = [
    path.join(__dirname, '../../sc-data-format/format.json'),
    path.join(__dirname, '../data/data_format.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return require(candidate);
    }
  }
  throw new Error(
    'No format.json found. Clone sc-data-format as tools/sc-data-format or keep data/data_format.json.',
  );
}

const dataFormat = loadDataFormat();

// Generate a random value within the signal's nominal range
function generateValue(signalName, metadata, phase, t) {
  const [numBytes, dataType, units, nominalMin, nominalMax, category] = metadata;
  
  // Handle boolean types
  if (dataType === 'bool') {
    // Most booleans should be their nominal value (usually 0 for faults)
    if (signalName.includes('fault') || signalName.includes('failsafe')) {
      return 0; // No faults during normal operation
    }
    if (signalName.includes('heartbeat') || signalName.includes('enabled') || signalName.includes('contactor')) {
      return 1; // System healthy
    }
    return nominalMin; // Default to nominal
  }
  
  // Special handling for specific signals based on drive phase
  switch (signalName) {
    case 'speed':
      if (phase === 'idle') return 0;
      if (phase === 'accelerate') return Math.min(45, t * 3);
      if (phase === 'cruise') return 40 + Math.random() * 5;
      if (phase === 'decelerate') return Math.max(0, 45 - t * 3);
      return 0;
      
    case 'accelerator_pedal':
      if (phase === 'idle') return 0;
      if (phase === 'accelerate') return 0.3 + Math.random() * 0.4;
      if (phase === 'cruise') return 0.2 + Math.random() * 0.1;
      if (phase === 'decelerate') return 0;
      return 0;
      
    case 'soc':
      // SOC decreases over time
      return Math.max(50, 85 - t * 0.1);
      
    case 'pack_voltage':
      // Voltage correlates with SOC
      const soc = Math.max(50, 85 - t * 0.1);
      return 77.5 + (soc / 100) * 35.65;
      
    case 'motor_power':
    case 'pack_power':
      if (phase === 'idle') return 0;
      if (phase === 'accelerate') return 500 + t * 100;
      if (phase === 'cruise') return 1500 + Math.random() * 200;
      if (phase === 'decelerate') return -200 - Math.random() * 100; // Regen
      return 0;
      
    case 'motor_current':
    case 'pack_current':
      if (phase === 'idle') return 0;
      if (phase === 'accelerate') return 5 + t * 1;
      if (phase === 'cruise') return 15 + Math.random() * 3;
      if (phase === 'decelerate') return -2 - Math.random() * 3; // Regen
      return 0;
      
    case 'lat':
      // Madison, WI area - simulate movement
      return 43.0735 + t * 0.0001;
      
    case 'lon':
      return -89.4012 + t * 0.00015;
      
    case 'elev':
      return 268 + Math.sin(t / 10) * 5;
      
    case 'mcc_state':
      if (phase === 'idle') return 0;
      if (phase === 'accelerate') return 3;
      if (phase === 'cruise') return 6;
      if (phase === 'decelerate') return 4;
      return 0;
  }
  
  // Handle cell group voltages
  if (signalName.startsWith('cell_group') && signalName.endsWith('_voltage')) {
    // Slightly vary around 3.35V (nominal for LiFePO4)
    return 3.30 + Math.random() * 0.1;
  }
  
  // Temperature signals - vary slightly around room temp
  if (units === 'degC' || signalName.includes('temp')) {
    return 25 + Math.random() * 10;
  }
  
  // For other numeric types, generate within range
  if (nominalMin !== nominalMax && nominalMax > nominalMin) {
    const range = nominalMax - nominalMin;
    return nominalMin + Math.random() * range;
  }
  
  return nominalMin || 0;
}

// Generate test data
function generateTestData(numRecords = 30) {
  const records = [];
  const baseTimestamp = Date.now();
  
  for (let i = 0; i < numRecords; i++) {
    const record = {};
    
    // Determine drive phase
    let phase;
    if (i < 3) phase = 'idle';
    else if (i < 10) phase = 'accelerate';
    else if (i < 20) phase = 'cruise';
    else if (i < 27) phase = 'decelerate';
    else phase = 'idle';
    
    // Timestamp
    record.timestamp = baseTimestamp + i * 1000;
    
    // Generate all signals
    for (const [signalName, metadata] of Object.entries(dataFormat)) {
      record[signalName] = generateValue(signalName, metadata, phase, i);
    }
    
    // Add some computed/derived values
    record.regen_brake = phase === 'decelerate' ? 0.3 + Math.random() * 0.3 : 0;
    record.foot_brake = phase === 'decelerate' && i > 25 ? 1 : 0;
    record.park_brake = phase === 'idle' && i > 27 ? 1 : 0;
    record.eco = 1;
    record.fr_telem = 1;
    record.main_telem = 1;
    
    // MPPT values (solar input)
    record.mppt_mode = phase !== 'idle' ? 1 : 0;
    record.mppt_current_out = phase !== 'idle' ? 2 + Math.random() * 3 : 0;
    record.mppt_power_out = record.mppt_current_out * 105;
    
    // String voltages and currents
    for (let s = 1; s <= 3; s++) {
      record[`string${s}_V_in`] = 44 + Math.random() * 2;
      record[`string${s}_I_in`] = phase !== 'idle' ? 1.5 + Math.random() * 1 : 0;
      record[`string${s}_temp`] = 28 + Math.random() * 5;
    }
    
    records.push(record);
  }
  
  return records;
}

// Convert to CSV
function toCSV(records) {
  if (records.length === 0) return '';
  
  const headers = Object.keys(records[0]);
  const lines = [headers.join(',')];
  
  for (const record of records) {
    const values = headers.map(h => {
      const val = record[h];
      if (typeof val === 'number') {
        return Number.isInteger(val) ? val : val.toFixed(2);
      }
      return val;
    });
    lines.push(values.join(','));
  }
  
  return lines.join('\n');
}

// Main
function main() {
  console.log('SC Telemetry Test Data Generator');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  const numRecords = parseInt(process.argv[2]) || 30;
  console.log(`📊 Generating ${numRecords} records...`);
  
  const records = generateTestData(numRecords);
  const csv = toCSV(records);
  
  const outputPath = path.join(__dirname, '../data/test_telemetry.csv');
  fs.writeFileSync(outputPath, csv);
  
  console.log(`✅ Generated ${records.length} records with ${Object.keys(records[0]).length} signals`);
  console.log(`📁 Saved to: ${outputPath}`);
  
  // Show sample
  console.log('\n📋 Sample record (first):');
  console.log(`   Speed: ${records[0].speed?.toFixed(1) || 0} mph`);
  console.log(`   SOC: ${records[0].soc?.toFixed(1) || 0}%`);
  console.log(`   Pack Voltage: ${records[0].pack_voltage?.toFixed(1) || 0} V`);
  console.log(`   Location: ${records[0].lat?.toFixed(6)}, ${records[0].lon?.toFixed(6)}`);
}

main();
