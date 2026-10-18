#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('====================================================');
console.log('   ICM Meteo Test Suite: sample_response & Renderer');
console.log('====================================================\n');

const sampleDataPath = path.resolve(__dirname, './sample_data.js');
const scriptsPath = path.resolve(__dirname, '../js/scripts.js');

let passCount = 0;
let failCount = 0;

function it(name, fn) {
  try {
    fn();
    console.log('  \x1b[32m✔\x1b[0m ' + name);
    passCount++;
  } catch (err) {
    console.error('  \x1b[31m✖\x1b[0m ' + name);
    console.error('    ' + (err.stack || err.message));
    failCount++;
  }
}

// --- 1. Load Files ---
let sampleJson;
it('sample_data.js exists and exports valid sample data', () => {
  assert.ok(fs.existsSync(sampleDataPath), 'sample_data.js should exist');
  sampleJson = require(sampleDataPath);
  assert.ok(sampleJson && sampleJson.data, 'sampleJson must have a "data" property');
});

// Mock browser globals for loading scripts.js in Node
global.window = {};
global.document = {
  getElementById: (id) => {
    return {
      textContent: '',
      className: '',
      setAttribute: () => {},
      getAttribute: () => null,
      classList: { toggle: () => {}, add: () => {}, remove: () => {} },
      addEventListener: () => {}
    };
  },
  querySelectorAll: () => [],
  addEventListener: () => {}
};

let ICMMeteo;
it('js/scripts.js loads and exports ICMMeteo', () => {
  ICMMeteo = require(scriptsPath);
  assert.ok(ICMMeteo, 'ICMMeteo object should be exported');
  assert.strictEqual(typeof ICMMeteo.parseMeteoResponse, 'function');
  assert.strictEqual(typeof ICMMeteo.renderMeteogram, 'function');
});

// --- 2. Verify sample_response structure and completeness ---
it('sample_response has all 28 expected series with 60 hourly points', () => {
  const d = sampleJson.data;
  const expectedKeys = [
    'airtmp_point', 'airtmp_min', 'airtmp_max',
    'grdtmp_min', 'grdtmp_max',
    'dwptmp_point',
    'wchill_point', 'wchill_min', 'wchill_max',
    'storm_max', 'flash_max',
    'pcpttl_aver', 'pcpttl_max', 'pcpttlprob_point', 'pcpttl_type_max',
    'realhum_aver',
    'trpres_point', 'slpres_point',
    'wind10_dr_deg_true_prev_point', 'wind10_sd_true_prev_point', 'wind_gust_max',
    'visibl_min',
    'cldbse01', 'cldbse25', 'cldbse45', 'cldbse65', 'cldbse79',
    'cldtop',
    'cldvlow_aver', 'cldlow_aver', 'cldmed_aver', 'cldhigh_aver', 'cldtot_aver',
    'fog_max'
  ];

  for (const k of expectedKeys) {
    assert.ok(d[k], `Series "${k}" must exist in sample_response`);
    assert.ok(Array.isArray(d[k].data), `Series "${k}.data" must be an array`);
    assert.strictEqual(d[k].data.length, 60, `Series "${k}.data" must contain exactly 60 data points`);
    assert.strictEqual(d[k].interval, 3600, `Series "${k}.interval" must be 3600s (1h)`);
    assert.strictEqual(d[k].first_timestamp, '1792328400', `Series "${k}.first_timestamp" must match start timestamp`);
  }
});

// --- 3. Parser and calculations verification ---
let parsed;
it('parseMeteoResponse correctly parses timestamps, coordinates, and models', () => {
  parsed = ICMMeteo.parseMeteoResponse(sampleJson);
  assert.strictEqual(parsed.count, 60);
  assert.strictEqual(parsed.firstTs, 1792328400);
  assert.strictEqual(parsed.interval, 3600);
  assert.strictEqual(parsed.point.lat, 51.7687);
  assert.strictEqual(parsed.point.lon, 19.457);
  assert.strictEqual(parsed.point.col, 225);
  assert.strictEqual(parsed.point.row, 198);
  assert.strictEqual(parsed.point.model, 'um4');
  assert.strictEqual(parsed.point.grid, 'P5');
  assert.strictEqual(parsed.timestamps.length, 60);
  assert.strictEqual(parsed.warsawTimes.length, 60);
  assert.strictEqual(parsed.utcTimes.length, 60);
  assert.strictEqual(parsed.isNight.length, 60);
});

it('Warsaw timezone and day names are correctly formatted', () => {
  const first = parsed.warsawTimes[0];
  // 1792328400 UTC is 13:00 UTC -> 15:00 CEST (GMT+2) in October
  assert.strictEqual(first.hour, 15);
  assert.strictEqual(first.tzName, 'CEST');
  assert.strictEqual(first.day, '18');
  assert.strictEqual(first.month, '10');
  assert.strictEqual(first.shortDate, '18.10');
});

it('Sunrise, sunset and night shading detection works accurately', () => {
  const st = parsed.sunTimes;
  assert.ok(st.sunriseSec && st.sunsetSec, 'Sunrise and sunset seconds must be computed');
  assert.ok(st.sunsetSec > st.sunriseSec, 'Sunset must be after sunrise');

  const srInfo = ICMMeteo.getWarsawInfo(st.sunriseSec);
  const ssInfo = ICMMeteo.getWarsawInfo(st.sunsetSec);
  assert.strictEqual(srInfo.hour, 7, 'Sunrise in Poland in mid-October should be around 07:xx CEST');
  assert.strictEqual(ssInfo.hour, 17, 'Sunset in Poland in mid-October should be around 17:xx CEST');

  // Verify that midnight is marked as night and noon is marked as day
  const midnightIdx = parsed.warsawTimes.findIndex(t => t.hour === 0);
  const noonIdx = parsed.warsawTimes.findIndex(t => t.hour === 12);
  assert.ok(midnightIdx >= 0 && parsed.isNight[midnightIdx] === true, 'Midnight must be night');
  assert.ok(noonIdx >= 0 && parsed.isNight[noonIdx] === false, 'Noon must be daytime');
});

it('DMS coordinate conversion matches expected format', () => {
  const latDms = ICMMeteo.toDMS(51.7687, 'N', 'S');
  const lonDms = ICMMeteo.toDMS(19.457, 'E', 'W');
  assert.strictEqual(latDms, '51°46\'7"N');
  assert.strictEqual(lonDms, '19°27\'25"E');
});

it('Cloud base sentinel values (< 0, e.g. -327276480.0) are correctly detected', () => {
  // In sample_response, cldbse65 index 0 is -327276480.0, index 4 is 0.973
  assert.strictEqual(parsed.cldbse65[0], -327276480.0);
  assert.strictEqual(parsed.cldbse65[4], 0.973);
  // Filtering test:
  const validPoints = parsed.cldbse65.filter(v => v !== null && v >= 0);
  assert.ok(validPoints.every(v => v >= 0 && v <= 20), 'Filtered points must all be non-negative altitudes');
  assert.ok(validPoints.length > 0 && validPoints.length < 60, 'Should have both valid points and sentinels');
});

it('Pressure units and conversion (Pa to hPa and mmHg)', () => {
  // 102585.633 Pa in slpres_point
  const slpresHpa = parsed.slpres_point[0] / 100;
  assert.strictEqual(Math.round(slpresHpa), 1026);
  const mmHg = Math.round(slpresHpa * 0.75006156);
  assert.strictEqual(mmHg, 769);
});

it('Non-linear piecewise mappings for cloud height and visibility', () => {
  const cldDomain = [0.0, 0.5, 2.0, 7.0, 15.0];
  const visDomain = [0.0, 1.0, 5.0, 20.0, 100.0];
  const ratios = [0.0, 0.25, 0.5, 0.75, 1.0];

  assert.strictEqual(ICMMeteo.mapPiecewise(0.0, cldDomain, ratios), 0.0);
  assert.strictEqual(ICMMeteo.mapPiecewise(0.5, cldDomain, ratios), 0.25);
  assert.strictEqual(ICMMeteo.mapPiecewise(2.0, cldDomain, ratios), 0.5);
  assert.strictEqual(ICMMeteo.mapPiecewise(7.0, cldDomain, ratios), 0.75);
  assert.strictEqual(ICMMeteo.mapPiecewise(15.0, cldDomain, ratios), 1.0);

  // Intermediate interpolation
  const midCloud = ICMMeteo.mapPiecewise(1.25, cldDomain, ratios);
  assert.ok(midCloud > 0.25 && midCloud < 0.5);
});

it('Color mapping functions (pressure and wind speed)', () => {
  const lowPresColor = ICMMeteo.getPressureColor(990);
  const highPresColor = ICMMeteo.getPressureColor(1026);
  assert.ok(lowPresColor.startsWith('rgb('));
  assert.ok(highPresColor.startsWith('rgb('));
  assert.notStrictEqual(lowPresColor, highPresColor);

  const calmWindColor = ICMMeteo.getWindFillColor(1.5);
  const strongWindColor = ICMMeteo.getWindFillColor(7.0);
  assert.strictEqual(calmWindColor, '#00d5ff');
  assert.strictEqual(strongWindColor, '#0b6b28');
});

// --- 4. Mock Canvas Rendering Execution ---
it('Canvas renderer runs completely without errors on sample data', () => {
  let pathsDrawn = 0;
  let textDrawn = 0;
  let rectsDrawn = 0;

  const mockCtx = {
    setTransform: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => { pathsDrawn++; },
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fill: () => {},
    rect: () => { rectsDrawn++; },
    fillRect: () => { rectsDrawn++; },
    strokeRect: () => { rectsDrawn++; },
    arc: () => {},
    clip: () => {},
    translate: () => {},
    rotate: () => {},
    fillText: () => { textDrawn++; },
    setLineDash: () => {},
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: ''
  };

  const mockCanvas = {
    width: 0,
    height: 0,
    style: {},
    getContext: () => mockCtx
  };

  global.document.getElementById = (id) => {
    if (id === 'meteogramCanvas') return mockCanvas;
    return {
      textContent: '',
      className: '',
      setAttribute: () => {},
      getAttribute: () => null,
      classList: { add: () => {}, remove: () => {}, toggle: () => {} }
    };
  };

  ICMMeteo.state.parsed = parsed;
  ICMMeteo.renderMeteogram();

  assert.ok(mockCanvas.width > 0, 'Canvas width must be set');
  assert.ok(mockCanvas.height > 0, 'Canvas height must be set');
  assert.ok(pathsDrawn > 50, `Renderer must draw paths (got ${pathsDrawn})`);
  assert.ok(rectsDrawn > 50, `Renderer must draw rects (got ${rectsDrawn})`);
  assert.ok(textDrawn > 50, `Renderer must draw text labels (got ${textDrawn})`);
});

it('Theme switching between dark and light functions correctly and re-renders', () => {
  assert.strictEqual(typeof ICMMeteo.applyTheme, 'function');
  ICMMeteo.applyTheme('dark');
  assert.strictEqual(ICMMeteo.state.theme, 'dark');

  ICMMeteo.applyTheme('light');
  assert.strictEqual(ICMMeteo.state.theme, 'light');

  ICMMeteo.applyTheme('dark');
  assert.strictEqual(ICMMeteo.state.theme, 'dark');
});

it('updateReadout(0) populates initial metrics from first hour with full names across 3 rows', () => {
  let readoutHtml = '';
  let readoutText = '';
  global.document.getElementById = (id) => {
    if (id === 'hoverReadout') {
      return {
        set innerHTML(val) {
          readoutHtml = val;
          readoutText = val.replace(/<[^>]*>/g, ' ');
        },
        get innerHTML() { return readoutHtml; },
        set textContent(val) { readoutText = val; },
        get textContent() { return readoutText; },
        style: {}
      };
    }
    return { style: {} };
  };
  global.document.querySelector = (sel) => {
    if (sel === '.top-bar') return { offsetWidth: 560 };
    return null;
  };

  ICMMeteo.updateReadout(0);
  assert.ok(readoutHtml.includes('readout-time'), 'Must include readout-time element');
  assert.ok(readoutHtml.includes('readout-row'), 'Must include readout-row elements');
  assert.ok(readoutText.includes('15:00 CEST'), 'Must include first hour');
  assert.ok(readoutText.includes('Temperatura: 11.7°C'), 'Must include full Temperatura');
  assert.ok(readoutText.includes('odczuwalna 11.7°C'), 'Must include full odczuwalna');
  assert.ok(readoutText.includes('Opady:'), 'Must include full Opady');
  assert.ok(readoutText.includes('Wilgotność:'), 'Must include full Wilgotność');
  assert.ok(readoutText.includes('Ciśnienie: 1025.9 hPa'), 'Must include full Ciśnienie');
  assert.ok(readoutText.includes('Wiatr: 3.2 m/s'), 'Must include full Wiatr');
});

// --- Summary ---
console.log('\n----------------------------------------------------');
console.log(`Results: ${passCount} passed, ${failCount} failed`);
console.log('----------------------------------------------------');

if (failCount > 0) {
  process.exit(1);
} else {
  console.log('\x1b[32mAll sample tests passed successfully!\x1b[0m\n');
  process.exit(0);
}
