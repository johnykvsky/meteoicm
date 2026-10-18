(function () {
  'use strict';

  var CITIES = {
    czestochowa: { label: 'Częstochowa', lat: '50.8118', lon: '19.1203' },
    kule:        { label: 'Kule',        lat: '51.0500', lon: '18.9667' },
    ustron:      { label: 'Ustroń',      lat: '49.7193', lon: '18.8120' },
    galezow:     { label: 'Gałęzów',     lat: '54.4697', lon: '16.9242' },
    ustka:       { label: 'Ustka',       lat: '54.5805', lon: '16.8619' },
    poddabie:    { label: 'Poddąbie',    lat: '54.6186', lon: '16.9825' },
    krakow:      { label: 'Kraków',      lat: '50.0647', lon: '19.9450' }
  };

  var state = {
    city: 'czestochowa',
    model: 'um4_60',
    showPrecipProb: true,
    useSeaLevelPressure: true,
    rawResponse: null,
    parsed: null,
    hoverIndex: null,
    theme: (function () {
      try {
        var saved = typeof localStorage !== 'undefined' ? localStorage.getItem('meteo_theme') : null;
        return saved === 'light' ? 'light' : 'dark';
      } catch (e) {
        return 'dark';
      }
    })()
  };

  // --- Astronomical Sunrise / Sunset & Timezone Helpers ---

  var warsawPartsFmt = new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short'
  });

  var DAY_NAMES_PL = {
    'pon.': 'pon', 'wt.': 'wto', 'śr.': 'śro', 'czw.': 'czw',
    'pt.': 'pią', 'sob.': 'sob', 'niedz.': 'nie',
    'pon': 'pon', 'wto': 'wto', 'śro': 'śro', 'czw': 'czw',
    'pią': 'pią', 'sob': 'sob', 'nie': 'nie'
  };

  function getWarsawInfo(unixSec) {
    var d = new Date(unixSec * 1000);
    var parts = warsawPartsFmt.formatToParts(d);
    var map = {};
    for (var i = 0; i < parts.length; i++) {
      map[parts[i].type] = parts[i].value;
    }
    var hr = parseInt(map.hour, 10);
    if (hr === 24) hr = 0;
    var wkRaw = (map.weekday || '').toLowerCase();
    var wk = DAY_NAMES_PL[wkRaw] || wkRaw.replace('.', '');
    var tz = map.timeZoneName || 'CET';
    if (tz === 'GMT+2' || tz === 'UTC+2') tz = 'CEST';
    if (tz === 'GMT+1' || tz === 'UTC+1') tz = 'CET';
    return {
      year: parseInt(map.year, 10),
      month: map.month,
      day: map.day,
      hour: hr,
      minute: map.minute,
      weekday: wk,
      dateLabel: wk + ', ' + map.day + '.' + map.month,
      shortDate: map.day + '.' + map.month,
      tzName: tz
    };
  }

  function getUTCInfo(unixSec) {
    var d = new Date(unixSec * 1000);
    var day = String(d.getUTCDate()).padStart(2, '0');
    var month = String(d.getUTCMonth() + 1).padStart(2, '0');
    return {
      hour: d.getUTCHours(),
      shortDate: day + '.' + month
    };
  }

  // Compute sunrise and sunset (in Unix seconds) for the given lat/lon on the UTC day of unixSec
  function computeSunTimes(unixSec, lat, lon) {
    var d = new Date(unixSec * 1000);
    var startOfYear = Date.UTC(d.getUTCFullYear(), 0, 0);
    var dayOfYear = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - startOfYear) / 86400000);
    var rad = Math.PI / 180;
    var gamma = (2 * Math.PI / 365) * (dayOfYear - 1);

    var eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
      - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
    var decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
      - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
      - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);

    var cosHA = (Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl))) - Math.tan(lat * rad) * Math.tan(decl);
    if (cosHA > 1) return { alwaysNight: true };
    if (cosHA < -1) return { alwaysDay: true };

    var haDeg = Math.acos(cosHA) / rad;
    var sunriseMinUTC = 720 - 4 * (lon + haDeg) - eqTime;
    var sunsetMinUTC = 720 - 4 * (lon - haDeg) - eqTime;
    var dayStartSec = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);

    return {
      sunriseSec: dayStartSec + Math.round(sunriseMinUTC * 60),
      sunsetSec: dayStartSec + Math.round(sunsetMinUTC * 60)
    };
  }

  function isNightTimestamp(unixSec, lat, lon) {
    var st = computeSunTimes(unixSec, lat, lon);
    if (st.alwaysNight) return true;
    if (st.alwaysDay) return false;
    return unixSec < st.sunriseSec || unixSec >= st.sunsetSec;
  }

  function formatHM(unixSec) {
    var info = getWarsawInfo(unixSec);
    return String(info.hour).padStart(2, '0') + ':' + info.minute + ' ' + info.tzName;
  }

  function toDMS(deg, posHemi, negHemi) {
    var hemi = deg >= 0 ? posHemi : negHemi;
    var abs = Math.abs(deg);
    var d = Math.floor(abs);
    var mFloat = (abs - d) * 60;
    var m = Math.floor(mFloat);
    var s = Math.round((mFloat - m) * 60);
    if (s === 60) { s = 0; m += 1; }
    if (m === 60) { m = 0; d += 1; }
    return d + '°' + m + '\'' + s + '"' + hemi;
  }

  // --- Forecast Run Timestamp Calculation & Fetching ---

  function getLatestRunCandidates() {
    var nowSec = Math.floor(Date.now() / 1000);
    // Allow ~4.5h model computation delay so e.g. 12:00 UTC run is used from 16:30 UTC (18:30 CEST)
    var baseRun = Math.floor((nowSec - 4.5 * 3600) / 21600) * 21600;
    var candidates = [];
    for (var i = 0; i < 5; i++) {
      candidates.push(baseRun - i * 21600);
    }
    return candidates;
  }

  function setStatus(text, cls) {
    var badge = document.getElementById('statusBadge');
    if (!badge) return;
    badge.textContent = text;
    badge.className = 'status-badge ' + (cls || '');
  }

  async function fetchFromICM(model, lat, lon) {
    var url = 'https://devmgramapi.meteo.pl/meteorograms/' + model;
    var candidates = getLatestRunCandidates();
    var lastErr = null;

    for (var i = 0; i < candidates.length; i++) {
      var runTs = candidates[i];
      try {
        var resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            date: runTs,
            point: { lat: String(lat), lon: String(lon) }
          })
        });
        if (!resp.ok) {
          lastErr = new Error('HTTP ' + resp.status);
          continue;
        }
        var json = await resp.json();
        if (json && json.data && json.data.airtmp_point && Array.isArray(json.data.airtmp_point.data) && json.data.airtmp_point.data.length > 0) {
          return { json: json, runTs: runTs };
        }
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Brak odpowiedzi z API ICM');
  }

  function getSampleData() {
    return (window.SAMPLE_METEO_RESPONSE && window.SAMPLE_METEO_RESPONSE.data)
      ? window.SAMPLE_METEO_RESPONSE
      : null;
  }

  async function loadMeteo(cityKey, modelKey) {
    if (cityKey) state.city = cityKey;
    if (modelKey) state.model = modelKey;

    var cityObj = CITIES[state.city] || CITIES.czestochowa;
    document.getElementById('currentCityLabel').textContent = cityObj.label;

    // Highlight active buttons
    var cityBtns = document.querySelectorAll('.btn-city');
    for (var i = 0; i < cityBtns.length; i++) {
      cityBtns[i].classList.toggle('active', cityBtns[i].getAttribute('data-city') === state.city);
    }
    var modelBtns = document.querySelectorAll('.btn-model');
    for (var j = 0; j < modelBtns.length; j++) {
      modelBtns[j].classList.toggle('active', modelBtns[j].getAttribute('data-model') === state.model);
    }

    setStatus('Pobieranie (' + state.model + ')...', 'loading');
    try {
      var res = await fetchFromICM(state.model, cityObj.lat, cityObj.lon);
      applyResponse(res.json, 'API ICM (' + state.model + ')', 'ok');
    } catch (err) {
      var fallbackJson = getSampleData();
      if (fallbackJson) {
        applyResponse(
          fallbackJson,
          'Tryb offline — pokazano dane przykładowe (' + (err && err.message ? err.message : 'błąd sieci') + ')',
          'fallback'
        );
      } else {
        setStatus('Błąd pobierania danych: ' + (err ? err.message : ''), 'fallback');
      }
    }
  }

  function parseMeteoResponse(raw) {
    var d = raw.data;
    var ref = d.airtmp_point;
    var count = ref.data.length;
    var firstTs = parseInt(ref.first_timestamp, 10);
    var interval = parseInt(ref.interval, 10) || 3600;
    var pt = ref.point || { lat: 51.7687, lon: 19.457, row: 198, col: 225, model: 'um4', grid: 'P5' };

    var timestamps = [];
    var warsawTimes = [];
    var utcTimes = [];
    var isNight = [];
    for (var i = 0; i < count; i++) {
      var ts = firstTs + i * interval;
      timestamps.push(ts);
      warsawTimes.push(getWarsawInfo(ts));
      utcTimes.push(getUTCInfo(ts));
      isNight.push(isNightTimestamp(ts, pt.lat, pt.lon));
    }

    function series(name) {
      return (d[name] && Array.isArray(d[name].data)) ? d[name].data : new Array(count).fill(null);
    }

    return {
      fstart: raw.fstart || ref.fstart || '',
      point: pt,
      count: count,
      firstTs: firstTs,
      interval: interval,
      timestamps: timestamps,
      warsawTimes: warsawTimes,
      utcTimes: utcTimes,
      isNight: isNight,
      sunTimes: computeSunTimes(firstTs, pt.lat, pt.lon),
      airtmp_point: series('airtmp_point'),
      airtmp_min: series('airtmp_min'),
      airtmp_max: series('airtmp_max'),
      grdtmp_min: series('grdtmp_min'),
      grdtmp_max: series('grdtmp_max'),
      dwptmp_point: series('dwptmp_point'),
      wchill_point: series('wchill_point'),
      wchill_min: series('wchill_min'),
      wchill_max: series('wchill_max'),
      storm_max: series('storm_max'),
      flash_max: series('flash_max'),
      pcpttl_aver: series('pcpttl_aver'),
      pcpttl_max: series('pcpttl_max'),
      pcpttlprob_point: series('pcpttlprob_point'),
      pcpttl_type_max: series('pcpttl_type_max'),
      realhum_aver: series('realhum_aver'),
      trpres_point: series('trpres_point'),
      slpres_point: series('slpres_point'),
      wind_dir: series('wind10_dr_deg_true_prev_point'),
      wind_speed: series('wind10_sd_true_prev_point'),
      wind_gust: series('wind_gust_max'),
      visibl_min: series('visibl_min'),
      cldbse01: series('cldbse01'),
      cldbse25: series('cldbse25'),
      cldbse45: series('cldbse45'),
      cldbse65: series('cldbse65'),
      cldbse79: series('cldbse79'),
      cldtop: series('cldtop'),
      cldvlow_aver: series('cldvlow_aver'),
      cldlow_aver: series('cldlow_aver'),
      cldmed_aver: series('cldmed_aver'),
      cldhigh_aver: series('cldhigh_aver'),
      cldtot_aver: series('cldtot_aver'),
      fog_max: series('fog_max')
    };
  }

  function applyResponse(raw, badgeText, badgeClass) {
    state.rawResponse = raw;
    state.parsed = parseMeteoResponse(raw);
    state.hoverIndex = null;

    var fstartStr = state.parsed.fstart
      ? state.parsed.fstart.replace('T', ' ').replace(':00Z', ' UTC')
      : '—';
    document.getElementById('meteoHour').textContent = fstartStr;
    setStatus(badgeText, badgeClass);
    renderMeteogram();
    updateReadout(0);
  }

  function updateReadout(idx) {
    var readout = document.getElementById('hoverReadout');
    if (!readout || !state.parsed) return;
    if (idx === null || idx === undefined || idx < 0 || idx >= state.parsed.count) {
      idx = 0;
    }
    var topBar = document.querySelector('.top-bar');
    if (topBar) {
      readout.style.maxWidth = topBar.offsetWidth + 'px';
    }
    var m = state.parsed;
    var wt = m.warsawTimes[idx];
    var presVal = ((state.useSeaLevelPressure ? m.slpres_point[idx] : m.trpres_point[idx]) / 100).toFixed(1);

    var timeStr = wt.dateLabel + ' ' + String(wt.hour).padStart(2, '0') + ':00 ' + wt.tzName;
    var tempStr = 'Temperatura: ' + m.airtmp_point[idx].toFixed(1) + '°C (odczuwalna ' + m.wchill_point[idx].toFixed(1) + '°C)';
    var pcpStr = 'Opady: ' + m.pcpttl_aver[idx].toFixed(2) + ' mm (max ' + m.pcpttl_max[idx].toFixed(2) + ' mm, ' + Math.round(m.pcpttlprob_point[idx]) + '%)';
    var humPresStr = 'Wilgotność: ' + Math.round(m.realhum_aver[idx]) + '%<span class="readout-sep">|</span>Ciśnienie: ' + presVal + ' hPa';
    var windStr = 'Wiatr: ' + m.wind_speed[idx].toFixed(1) + ' m/s (porywy ' + m.wind_gust[idx].toFixed(1) + ' m/s)';

    readout.innerHTML =
      '<div class="readout-time">' + timeStr + '</div>' +
      '<div class="readout-row">' + tempStr + '</div>' +
      '<div class="readout-row">' + pcpStr + '</div>' +
      '<div class="readout-row">' + humPresStr + '</div>' +
      '<div class="readout-row">' + windStr + '</div>';
  }

  // --- Classic old-meteo.jpg Canvas Renderer ---

  function getPressureColor(hpa) {
    // Classic ICM pressure palette: cyan/green (low) -> yellow -> orange -> red (high)
    var stops = [
      { p: 985,  r: 0,   g: 210, b: 255 },
      { p: 995,  r: 0,   g: 225, b: 120 },
      { p: 1005, r: 70,  g: 235, b: 20  },
      { p: 1013, r: 230, g: 230, b: 20  },
      { p: 1020, r: 255, g: 130, b: 10  },
      { p: 1028, r: 235, g: 20,  b: 20  }
    ];
    if (hpa <= stops[0].p) return 'rgb(0,210,255)';
    if (hpa >= stops[stops.length - 1].p) return 'rgb(235,20,20)';
    for (var i = 0; i < stops.length - 1; i++) {
      var a = stops[i], b = stops[i + 1];
      if (hpa >= a.p && hpa <= b.p) {
        var t = (hpa - a.p) / (b.p - a.p);
        var r = Math.round(a.r + t * (b.r - a.r));
        var g = Math.round(a.g + t * (b.g - a.g));
        var bl = Math.round(a.b + t * (b.b - a.b));
        return 'rgb(' + r + ',' + g + ',' + bl + ')';
      }
    }
    return 'rgb(70,235,20)';
  }

  function getWindFillColor(ms) {
    if (ms < 2.0) return '#00d5ff';
    if (ms < 3.5) return '#0092ff';
    if (ms < 5.5) return '#0055a5';
    if (ms < 8.0) return '#0b6b28';
    return '#94ad00';
  }

  function mapPiecewise(val, domain, range) {
    if (val <= domain[0]) return range[0];
    var last = domain.length - 1;
    if (val >= domain[last]) return range[last];
    for (var i = 0; i < last; i++) {
      if (val >= domain[i] && val <= domain[i + 1]) {
        var t = (val - domain[i]) / (domain[i + 1] - domain[i]);
        return range[i] + t * (range[i + 1] - range[i]);
      }
    }
    return range[0];
  }

  function renderMeteogram() {
    var m = state.parsed;
    if (!m) return;

    var canvas = document.getElementById('meteogramCanvas');
    var dpr = Math.max(window.devicePixelRatio || 1, 2);

    var N = m.count;
    var stepX = 7; // 7px per hour -> 413px plot width for 60h, 833px for 120h
    var padLeft = 66;
    var padRight = 66;
    var plotW = (N - 1) * stepX;
    var totalW = padLeft + plotW + padRight;
    var totalH = 675;
    var MONO_FONT = 'ui-monospace, Menlo, Consolas, "Liberation Mono", monospace';

    canvas.width = totalW * dpr;
    canvas.height = totalH * dpr;
    canvas.style.width = totalW + 'px';
    canvas.style.height = totalH + 'px';

    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var isDark = (state.theme !== 'light');

    // Clear full background
    ctx.fillStyle = isDark ? '#161b22' : '#ffffff';
    ctx.fillRect(0, 0, totalW, totalH);

    function xAt(i) {
      return padLeft + i * stepX;
    }

    // Panel vertical layout matching old-meteo.jpg
    var panels = {
      temp:   { top: 63,  h: 78 },
      precip: { top: 151, h: 74 },
      pres:   { top: 235, h: 74 },
      wind:   { top: 319, h: 74 },
      wdir:   { top: 401, h: 26 },
      cloudH: { top: 435, h: 74 },
      cloudC: { top: 519, h: 78 }
    };

    // --- 1. Header Info (Sunrise/Sunset, DMS + Grid, Model Run) ---
    ctx.fillStyle = isDark ? '#58a6ff' : '#000080';
    ctx.font = '11px ' + MONO_FONT;
    ctx.textBaseline = 'top';

    if (m.sunTimes && m.sunTimes.sunriseSec) {
      ctx.textAlign = 'left';
      ctx.fillText('wschód słońca: ' + formatHM(m.sunTimes.sunriseSec), 8, 4);
      ctx.fillText('zachód słońca: ' + formatHM(m.sunTimes.sunsetSec), 8, 17);
    }

    ctx.textAlign = 'center';
    var dmsStr = toDMS(m.point.lon, 'E', 'W') + ', ' + toDMS(m.point.lat, 'N', 'S');
    ctx.fillText(dmsStr, padLeft + plotW / 2, 4);
    ctx.fillText('(x=' + m.point.col + ', y=' + m.point.row + ')', padLeft + plotW / 2, 17);

    ctx.textAlign = 'right';
    ctx.fillText('model: UM 4km (' + N + 'h)', totalW - 8, 4);
    if (m.fstart) {
      ctx.fillText('start: ' + m.fstart.slice(0, 16).replace('T', ' ') + ' UTC', totalW - 8, 17);
    }

    // --- 2. Top Local Time Header Band (Day/Night shading + CEST/CET hours) ---
    var topBandY = 35;
    var topBandH = 28;
    for (var i = 0; i < N; i++) {
      var x0 = i === 0 ? padLeft : xAt(i) - stepX / 2;
      var x1 = i === N - 1 ? padLeft + plotW : xAt(i) + stepX / 2;
      ctx.fillStyle = isDark
        ? (m.isNight[i] ? '#1c2129' : '#282e37')
        : (m.isNight[i] ? '#dcdcdc' : '#f5f5f5');
      ctx.fillRect(x0, topBandY, x1 - x0, topBandH);
    }

    var tzLabel = m.warsawTimes[0] ? m.warsawTimes[0].tzName : 'CET';
    ctx.fillStyle = isDark ? '#e6edf3' : '#000000';
    ctx.font = '11px ' + MONO_FONT;
    ctx.textAlign = 'right';
    ctx.fillText(tzLabel, padLeft - 6, 50);
    ctx.textAlign = 'left';
    ctx.fillText(tzLabel, padLeft + plotW + 6, 50);

    // Day labels ("pon, 19.10") centered around 12:00-13:00 local time
    ctx.textAlign = 'center';
    for (var i = 0; i < N; i++) {
      var wt = m.warsawTimes[i];
      if (wt.hour === 13 && i > 2 && i < N - 3) {
        ctx.font = 'bold 11px ' + MONO_FONT;
        ctx.fillStyle = isDark ? '#e6edf3' : '#000000';
        ctx.fillText(wt.dateLabel, xAt(i), topBandY + 3);
      }
      // 6-hour local time markers (matching 03, 09, 15, 21 UTC)
      var utHr = m.utcTimes[i].hour;
      if (utHr % 6 === 3) {
        ctx.font = '11px ' + MONO_FONT;
        ctx.fillStyle = isDark ? '#e6edf3' : '#000000';
        ctx.fillText(String(wt.hour).padStart(2, '0'), xAt(i), 50);
      }
    }

    // Helper to draw panel background (day/night columns) and vertical grid lines
    function drawPanelBase(p, isSkyPanel) {
      for (var i = 0; i < N; i++) {
        var x0 = i === 0 ? padLeft : xAt(i) - stepX / 2;
        var x1 = i === N - 1 ? padLeft + plotW : xAt(i) + stepX / 2;
        if (isSkyPanel) {
          ctx.fillStyle = isDark
            ? (m.isNight[i] ? '#10253a' : '#193f61')
            : (m.isNight[i] ? '#71b0df' : '#85c8f2');
        } else {
          ctx.fillStyle = isDark
            ? (m.isNight[i] ? '#21262d' : '#161b22')
            : (m.isNight[i] ? '#dddddd' : '#ffffff');
        }
        ctx.fillRect(x0, p.top, x1 - x0, p.h);
      }
    }

    function drawPanelGridAndBorder(p, yTicksRatio) {
      ctx.save();
      // Vertical 1h dotted & 6h dashed lines
      for (var i = 0; i < N; i++) {
        var x = xAt(i);
        var utHr = m.utcTimes[i].hour;
        ctx.beginPath();
        if (utHr % 6 === 3) {
          ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.35)' : 'rgba(0, 0, 0, 0.45)';
          ctx.setLineDash([2, 2]);
        } else {
          ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.14)';
          ctx.setLineDash([1, 3]);
        }
        ctx.lineWidth = 1;
        ctx.moveTo(x, p.top);
        ctx.lineTo(x, p.top + p.h);
        ctx.stroke();
      }

      // Horizontal grid lines
      ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.35)' : 'rgba(0, 0, 0, 0.45)';
      ctx.setLineDash([2, 2]);
      ctx.lineWidth = 1;
      for (var k = 0; k < yTicksRatio.length; k++) {
        var ry = yTicksRatio[k];
        if (ry <= 0.001 || ry >= 0.999) continue;
        var y = Math.round(p.top + p.h * (1 - ry)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(padLeft + plotW, y);
        ctx.stroke();
      }

      // Solid frame
      ctx.setLineDash([]);
      ctx.strokeStyle = isDark ? '#484f58' : '#000000';
      ctx.lineWidth = 1;
      ctx.strokeRect(padLeft + 0.5, p.top + 0.5, plotW - 1, p.h - 1);
      ctx.restore();
    }

    function drawRotatedLabel(textLines, x, centerY, angleDeg, color) {
      ctx.save();
      ctx.translate(x, centerY);
      ctx.rotate((angleDeg * Math.PI) / 180);
      var defaultColor = isDark ? '#79c0ff' : '#000080';
      ctx.fillStyle = color ? (isDark && color === '#000080' ? '#79c0ff' : color) : defaultColor;
      ctx.font = '11px ' + MONO_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (textLines.length === 1) {
        ctx.fillText(textLines[0], 0, 0);
      } else {
        ctx.fillText(textLines[0], 0, -6);
        ctx.fillText(textLines[1], 0, 6);
      }
      ctx.restore();
    }

    // =========================================================================
    // PANEL 1: TEMPERATURA (°C)
    // =========================================================================
    var pTemp = panels.temp;
    drawPanelBase(pTemp, false);

    var allTemps = [];
    for (var i = 0; i < N; i++) {
      if (m.airtmp_max[i] !== null) allTemps.push(m.airtmp_max[i]);
      if (m.airtmp_min[i] !== null) allTemps.push(m.airtmp_min[i]);
      if (m.grdtmp_max[i] !== null) allTemps.push(m.grdtmp_max[i]);
      if (m.grdtmp_min[i] !== null) allTemps.push(m.grdtmp_min[i]);
      if (m.wchill_min[i] !== null) allTemps.push(m.wchill_min[i]);
      if (m.dwptmp_point[i] !== null) allTemps.push(m.dwptmp_point[i]);
    }
    var tMin = Math.floor((Math.min.apply(null, allTemps) - 1) / 5) * 5;
    var tMax = Math.ceil((Math.max.apply(null, allTemps) + 1) / 5) * 5;
    if (tMax - tMin < 15) tMax = tMin + 15;

    function yTemp(val) {
      return pTemp.top + pTemp.h * (1 - (val - tMin) / (tMax - tMin));
    }

    // Shaded band: wchill_min .. wchill_max
    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, pTemp.top, plotW, pTemp.h);
    ctx.clip();

    ctx.fillStyle = isDark ? 'rgba(56, 139, 253, 0.3)' : 'rgba(135, 195, 255, 0.55)';
    ctx.beginPath();
    for (var i = 0; i < N; i++) {
      var x = xAt(i), y = yTemp(m.wchill_max[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    for (var i = N - 1; i >= 0; i--) {
      ctx.lineTo(xAt(i), yTemp(m.wchill_min[i]));
    }
    ctx.closePath();
    ctx.fill();

    // Shaded band: airtmp_min .. airtmp_max
    ctx.fillStyle = isDark ? 'rgba(248, 81, 73, 0.25)' : 'rgba(255, 165, 180, 0.55)';
    ctx.beginPath();
    for (var i = 0; i < N; i++) {
      var x = xAt(i), y = yTemp(m.airtmp_max[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    for (var i = N - 1; i >= 0; i--) {
      ctx.lineTo(xAt(i), yTemp(m.airtmp_min[i]));
    }
    ctx.closePath();
    ctx.fill();

    // Ground temp vertical min-max sticks (grdtmp_min .. grdtmp_max)
    ctx.strokeStyle = isDark ? '#f85149' : '#902020';
    ctx.lineWidth = 1;
    for (var i = 0; i < N; i++) {
      var x = Math.round(xAt(i)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, yTemp(m.grdtmp_min[i]));
      ctx.lineTo(x, yTemp(m.grdtmp_max[i]));
      ctx.stroke();
    }

    // Dew point (dwptmp_point) purple dots
    ctx.fillStyle = isDark ? '#bc8cff' : '#4b3898';
    for (var i = 0; i < N; i++) {
      ctx.beginPath();
      ctx.arc(xAt(i), yTemp(m.dwptmp_point[i]), 1.7, 0, Math.PI * 2);
      ctx.fill();
    }

    // Wind chill (wchill_point) solid blue curve
    ctx.strokeStyle = isDark ? '#58a6ff' : '#0000d8';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (var i = 0; i < N; i++) {
      var x = xAt(i), y = yTemp(m.wchill_point[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Air temperature (airtmp_point) solid red curve
    ctx.strokeStyle = isDark ? '#ff5555' : '#e60000';
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    for (var i = 0; i < N; i++) {
      var x = xAt(i), y = yTemp(m.airtmp_point[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();

    var tempStep = (tMax - tMin) > 25 ? 10 : 5;
    var tempRatios = [];
    ctx.font = '10px ' + MONO_FONT;
    ctx.fillStyle = isDark ? '#e6edf3' : '#000000';
    ctx.textBaseline = 'middle';
    for (var tv = tMin; tv <= tMax; tv += tempStep) {
      var ratio = (tv - tMin) / (tMax - tMin);
      tempRatios.push(ratio);
      var y = pTemp.top + pTemp.h * (1 - ratio);
      ctx.textAlign = 'right';
      ctx.fillText(String(tv), padLeft - 4, y);
      ctx.textAlign = 'left';
      ctx.fillText(String(tv), padLeft + plotW + 4, y);
    }
    drawPanelGridAndBorder(pTemp, tempRatios);
    drawRotatedLabel(['temperatura', '(°C)'], 16, pTemp.top + pTemp.h / 2, -90, '#000080');
    drawRotatedLabel(['temperatura', '(°C)'], totalW - 16, pTemp.top + pTemp.h / 2, 90, '#000080');

    // =========================================================================
    // PANEL 2: OPAD (mm/h) & WILGOTNOŚĆ WZGL. (%)
    // =========================================================================
    var pPrecip = panels.precip;
    drawPanelBase(pPrecip, false);

    var maxPcp = Math.max(5, Math.ceil(Math.max.apply(null, m.pcpttl_max.concat([5]))));
    var minHum = Math.min.apply(null, m.realhum_aver);
    var humFloor = minHum < 50 ? 0 : 50;

    function yPcp(val) {
      return pPrecip.top + pPrecip.h * (1 - Math.min(val, maxPcp) / maxPcp);
    }
    function yHum(val) {
      return pPrecip.top + pPrecip.h * (1 - (val - humFloor) / (100 - humFloor));
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, pPrecip.top, plotW, pPrecip.h);
    ctx.clip();

    // Average precipitation bars & max precipitation spikes
    for (var i = 0; i < N; i++) {
      var x = xAt(i);
      var avg = m.pcpttl_aver[i] || 0;
      var mx = m.pcpttl_max[i] || 0;
      if (avg > 0) {
        var yA = yPcp(avg);
        ctx.fillStyle = (m.pcpttl_type_max[i] === 2) ? '#00bfff' : (isDark ? '#3fb950' : '#2eb82e');
        ctx.fillRect(x - stepX * 0.38, yA, stepX * 0.76, pPrecip.top + pPrecip.h - yA);
      }
      if (mx > 0) {
        ctx.strokeStyle = isDark ? '#3fb950' : '#199d19';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, pPrecip.top + pPrecip.h);
        ctx.lineTo(Math.round(x) + 0.5, yPcp(mx));
        ctx.stroke();
      }
      // Storm indicator if storm_max > 0.1
      if ((m.storm_max[i] || 0) > 0.1 || (m.flash_max[i] || 0) > 0.1) {
        ctx.fillStyle = isDark ? '#ff7b72' : '#e60000';
        ctx.font = 'bold 10px ' + MONO_FONT;
        ctx.textAlign = 'center';
        ctx.fillText('⚡', x, pPrecip.top + 8);
      }
    }

    // Relative humidity curve (realhum_aver)
    ctx.strokeStyle = isDark ? '#f0883e' : '#c85214';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (var i = 0; i < N; i++) {
      var x = xAt(i), y = yHum(m.realhum_aver[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Optional precipitation probability numbers (%) along bottom of Panel 2
    if (state.showPrecipProb) {
      ctx.font = 'bold 9px ' + MONO_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      for (var i = 0; i < N; i++) {
        var utHr = m.utcTimes[i].hour;
        if (utHr % 3 === 0 && i > 0 && i < N - 1) {
          var prob = Math.round(m.pcpttlprob_point[i] || 0);
          ctx.fillStyle = prob > 0 ? (isDark ? '#3fb950' : '#008800') : (isDark ? 'rgba(63, 185, 80, 0.55)' : 'rgba(0, 128, 0, 0.55)');
          ctx.fillText(String(prob), xAt(i), pPrecip.top + pPrecip.h - 1);
        }
      }
    }
    ctx.restore();

    var pcpRatios = [];
    ctx.font = '10px ' + MONO_FONT;
    ctx.textBaseline = 'middle';
    for (var s = 0; s <= 5; s++) {
      var r = s / 5;
      pcpRatios.push(r);
      var y = pPrecip.top + pPrecip.h * (1 - r);
      var pVal = Math.round((maxPcp * r) * 10) / 10;
      ctx.fillStyle = isDark ? '#e6edf3' : '#000000';
      ctx.textAlign = 'right';
      ctx.fillText(String(pVal), padLeft - 4, y);

      var hVal = Math.round(humFloor + (100 - humFloor) * r);
      ctx.fillStyle = isDark ? '#f0883e' : '#c85214';
      ctx.textAlign = 'left';
      ctx.fillText(String(hVal), padLeft + plotW + 4, y);
    }
    drawPanelGridAndBorder(pPrecip, pcpRatios);
    drawRotatedLabel(['opad', '(mm/h, kg/m²/h)'], 16, pPrecip.top + pPrecip.h / 2, -90, '#000080');
    drawRotatedLabel(['(%)', 'wilgotność wzgl.'], totalW - 16, pPrecip.top + pPrecip.h / 2, 90, '#000080');

    // =========================================================================
    // PANEL 3: CIŚNIENIE (hPa & mm Hg)
    // =========================================================================
    var pPres = panels.pres;
    drawPanelBase(pPres, false);

    var rawPres = state.useSeaLevelPressure ? m.slpres_point : m.trpres_point;
    var presHpa = rawPres.map(function (v) { return v / 100; });
    var pMin = Math.floor((Math.min.apply(null, presHpa) - 1) / 5) * 5;
    var pMax = Math.ceil((Math.max.apply(null, presHpa) + 1) / 5) * 5;
    if (pMax - pMin < 20) {
      var mid = Math.round((pMin + pMax) / 10) * 10;
      pMin = mid - 10;
      pMax = mid + 10;
    }

    function yPres(val) {
      return pPres.top + pPres.h * (1 - (val - pMin) / (pMax - pMin));
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, pPres.top, plotW, pPres.h);
    ctx.clip();

    // Colored hourly polygon strips under pressure curve
    for (var i = 0; i < N - 1; i++) {
      var x0 = xAt(i), x1 = xAt(i + 1);
      var y0 = yPres(presHpa[i]), y1 = yPres(presHpa[i + 1]);
      ctx.fillStyle = getPressureColor((presHpa[i] + presHpa[i + 1]) / 2);
      ctx.beginPath();
      ctx.moveTo(x0, pPres.top + pPres.h);
      ctx.lineTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x1, pPres.top + pPres.h);
      ctx.closePath();
      ctx.fill();
    }

    ctx.strokeStyle = isDark ? '#ffffff' : '#000000';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (var i = 0; i < N; i++) {
      var x = xAt(i), y = yPres(presHpa[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();

    var presStep = (pMax - pMin) > 25 ? 10 : 5;
    var presRatios = [];
    ctx.font = '10px ' + MONO_FONT;
    ctx.fillStyle = isDark ? '#e6edf3' : '#000000';
    ctx.textBaseline = 'middle';
    for (var pv = pMin; pv <= pMax; pv += presStep) {
      var r = (pv - pMin) / (pMax - pMin);
      presRatios.push(r);
      var y = pPres.top + pPres.h * (1 - r);
      ctx.textAlign = 'right';
      ctx.fillText(String(pv), padLeft - 4, y);
      ctx.textAlign = 'left';
      var mmHg = Math.round(pv * 0.75006156);
      ctx.fillText(String(mmHg), padLeft + plotW + 4, y);
    }
    drawPanelGridAndBorder(pPres, presRatios);
    drawRotatedLabel(['ciśnienie', '(hPa)'], 16, pPres.top + pPres.h / 2, -90, '#000080');
    drawRotatedLabel(['(mm Hg)', 'ciśnienie'], totalW - 16, pPres.top + pPres.h / 2, 90, '#000080');

    // =========================================================================
    // PANEL 4: WIATR (m/s & km/h) + KIERUNEK WIATRU
    // =========================================================================
    var pWind = panels.wind;
    drawPanelBase(pWind, false);

    var maxGust = Math.max.apply(null, m.wind_gust.concat(m.wind_speed).concat([14]));
    var wMax = Math.ceil(maxGust / 5) * 5;
    if (wMax < 15) wMax = 15;

    function yWind(ms) {
      return pWind.top + pWind.h * (1 - ms / wMax);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, pWind.top, plotW, pWind.h);
    ctx.clip();

    // Mean wind speed colored strips
    for (var i = 0; i < N - 1; i++) {
      var x0 = xAt(i), x1 = xAt(i + 1);
      var y0 = yWind(m.wind_speed[i]), y1 = yWind(m.wind_speed[i + 1]);
      ctx.fillStyle = getWindFillColor((m.wind_speed[i] + m.wind_speed[i + 1]) / 2);
      ctx.beginPath();
      ctx.moveTo(x0, pWind.top + pWind.h);
      ctx.lineTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x1, pWind.top + pWind.h);
      ctx.closePath();
      ctx.fill();
    }

    // Mean wind top contour
    ctx.strokeStyle = isDark ? '#58a6ff' : '#000090';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (var i = 0; i < N; i++) {
      var x = xAt(i), y = yWind(m.wind_speed[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Max gusts as horizontal red dashes (old-meteo.jpg style)
    ctx.strokeStyle = isDark ? '#ff7b72' : '#d81818';
    ctx.lineWidth = 1.4;
    for (var i = 0; i < N; i++) {
      if (m.wind_gust[i] !== null) {
        var gx = xAt(i);
        var gy = Math.round(yWind(m.wind_gust[i])) + 0.5;
        ctx.beginPath();
        ctx.moveTo(gx - 2.6, gy);
        ctx.lineTo(gx + 2.6, gy);
        ctx.stroke();
      }
    }
    ctx.restore();

    var windRatios = [0, 1 / 3, 2 / 3, 1];
    ctx.font = '10px ' + MONO_FONT;
    ctx.fillStyle = isDark ? '#e6edf3' : '#000000';
    ctx.textBaseline = 'middle';
    for (var k = 0; k < windRatios.length; k++) {
      var r = windRatios[k];
      var y = pWind.top + pWind.h * (1 - r);
      var msVal = Math.round(wMax * r);
      var kmhVal = Math.round(msVal * 3.6);
      ctx.textAlign = 'right';
      ctx.fillText(String(msVal), padLeft - 4, y);
      ctx.textAlign = 'left';
      ctx.fillText(String(kmhVal), padLeft + plotW + 4, y);
    }
    drawPanelGridAndBorder(pWind, windRatios);
    drawRotatedLabel(['wiatr', '(m/s)'], 16, pWind.top + pWind.h / 2, -90, '#000080');
    drawRotatedLabel(['(km/h)', 'wiatr'], totalW - 16, pWind.top + pWind.h / 2, 90, '#000080');

    // Wind Direction Arrows Strip + N/S/W/E Compass Rose
    var pWdir = panels.wdir;
    var wyMid = pWdir.top + pWdir.h / 2;

    function drawCompassRose(cx, cy) {
      ctx.save();
      ctx.fillStyle = isDark ? '#79c0ff' : '#000080';
      ctx.font = '9px ' + MONO_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('N', cx, cy - 7);
      ctx.fillText('S', cx, cy + 7);
      ctx.fillText('W', cx - 9, cy);
      ctx.fillText('E', cx + 8, cy);
      ctx.restore();
    }
    drawCompassRose(24, wyMid);
    drawCompassRose(totalW - 24, wyMid);

    for (var i = 0; i < N; i++) {
      var deg = m.wind_dir[i];
      if (deg === null || isNaN(deg)) continue;
      var ax = xAt(i);
      // Meteorological direction is where wind blows FROM (0° = North -> blows South)
      var blowToRad = ((deg + 180) * Math.PI) / 180;
      ctx.save();
      ctx.translate(ax, wyMid);
      ctx.rotate(blowToRad);
      ctx.strokeStyle = isDark ? '#79c0ff' : '#000080';
      ctx.fillStyle = isDark ? '#79c0ff' : '#000080';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(0, 6);
      ctx.stroke();
      // Arrowhead at (0, -7) pointing up in rotated coords (Wait: at deg=0 (North), blowToRad=180°, so (0, -7) in rotated coords points DOWN (South)!)
      ctx.beginPath();
      ctx.moveTo(0, -8);
      ctx.lineTo(-2.3, -3.5);
      ctx.lineTo(2.3, -3.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // =========================================================================
    // PANEL 5: PION. ROZCIĄGŁ. CHM. (km) & WIDZIALNOŚĆ (km)
    // =========================================================================
    var pCloudH = panels.cloudH;
    drawPanelBase(pCloudH, true);

    var cldDomain = [0.0, 0.5, 2.0, 7.0, 15.0];
    var visDomain = [0.0, 1.0, 5.0, 20.0, 100.0];
    var levelRatios = [0.0, 0.25, 0.5, 0.75, 1.0];

    function yCloudKm(km) {
      var r = mapPiecewise(km, cldDomain, levelRatios);
      return pCloudH.top + pCloudH.h * (1 - r);
    }
    function yVisKm(km) {
      var r = mapPiecewise(km, visDomain, levelRatios);
      return pCloudH.top + pCloudH.h * (1 - r);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, pCloudH.top, plotW, pCloudH.h);
    ctx.clip();

    // Cloud base 5 thresholds (cldbse01..79) & cloud top (cldtop)
    var bseLevels = [
      { data: m.cldbse01, fill: '#ffffff', stroke: '#777777' },
      { data: m.cldbse25, fill: '#cccccc', stroke: '#555555' },
      { data: m.cldbse45, fill: '#888888', stroke: '#333333' },
      { data: m.cldbse65, fill: '#444444', stroke: '#111111' },
      { data: m.cldbse79, fill: isDark ? '#333333' : '#000000', stroke: isDark ? '#ffffff' : '#000000' }
    ];

    for (var b = 0; b < bseLevels.length; b++) {
      var lvl = bseLevels[b];
      ctx.fillStyle = lvl.fill;
      ctx.strokeStyle = lvl.stroke;
      ctx.lineWidth = 0.6;
      for (var i = 0; i < N; i++) {
        var val = lvl.data[i];
        if (val !== null && val >= 0 && val <= 20) {
          var cx = xAt(i), cy = yCloudKm(val);
          ctx.beginPath();
          ctx.arc(cx, cy, 2.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }

    // Cloud top (cldtop) brown-red dots
    ctx.fillStyle = isDark ? '#ff7b72' : '#8b2500';
    for (var i = 0; i < N; i++) {
      var ct = m.cldtop[i];
      if (ct !== null && ct >= 0 && ct <= 20) {
        ctx.beginPath();
        ctx.arc(xAt(i), yCloudKm(ct), 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Minimum visibility (visibl_min in m -> km) orange curve
    ctx.strokeStyle = isDark ? '#f0883e' : '#df7d00';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (var i = 0; i < N; i++) {
      var vKm = (m.visibl_min[i] || 0) / 1000;
      var x = xAt(i), y = yVisKm(vKm);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();

    ctx.font = '10px ' + MONO_FONT;
    ctx.textBaseline = 'middle';
    for (var k = 0; k < levelRatios.length; k++) {
      var r = levelRatios[k];
      var y = pCloudH.top + pCloudH.h * (1 - r);
      ctx.fillStyle = isDark ? '#e6edf3' : '#000000';
      ctx.textAlign = 'right';
      ctx.fillText(cldDomain[k].toFixed(1), padLeft - 4, y);
      ctx.fillStyle = isDark ? '#f0883e' : '#df7d00';
      ctx.textAlign = 'left';
      ctx.fillText(String(visDomain[k]), padLeft + plotW + 4, y);
    }
    drawPanelGridAndBorder(pCloudH, levelRatios);
    drawRotatedLabel(['pion. rozciągł. chm.', '(km)'], 16, pCloudH.top + pCloudH.h / 2, -90, '#000080');
    drawRotatedLabel(['(km)', 'widzialność'], totalW - 16, pCloudH.top + pCloudH.h / 2, 90, '#000080');

    // =========================================================================
    // PANEL 6: ZACHMURZENIE (oktanty 0-8) & MGŁA (frakcja 0-1)
    // =========================================================================
    var pCloudC = panels.cloudC;
    drawPanelBase(pCloudC, true);

    function yFrac(f) {
      var clamped = Math.max(0, Math.min(1, f || 0));
      return pCloudC.top + pCloudC.h * (1 - clamped);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, pCloudC.top, plotW, pCloudC.h);
    ctx.clip();

    // Total cloud cover filled dark grey area (cldtot_aver)
    ctx.fillStyle = '#484848';
    ctx.beginPath();
    ctx.moveTo(padLeft, pCloudC.top + pCloudC.h);
    for (var i = 0; i < N; i++) {
      ctx.lineTo(xAt(i), yFrac(m.cldtot_aver[i]));
    }
    ctx.lineTo(padLeft + plotW, pCloudC.top + pCloudC.h);
    ctx.closePath();
    ctx.fill();

    // High clouds filled white/light area where higher than low/med
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.beginPath();
    ctx.moveTo(padLeft, pCloudC.top + pCloudC.h);
    for (var i = 0; i < N; i++) {
      ctx.lineTo(xAt(i), yFrac(m.cldhigh_aver[i]));
    }
    ctx.lineTo(padLeft + plotW, pCloudC.top + pCloudC.h);
    ctx.closePath();
    ctx.fill();

    // Medium clouds medium-grey area
    ctx.fillStyle = 'rgba(135, 135, 135, 0.85)';
    ctx.beginPath();
    ctx.moveTo(padLeft, pCloudC.top + pCloudC.h);
    for (var i = 0; i < N; i++) {
      ctx.lineTo(xAt(i), yFrac(m.cldmed_aver[i]));
    }
    ctx.lineTo(padLeft + plotW, pCloudC.top + pCloudC.h);
    ctx.closePath();
    ctx.fill();

    // Low clouds dark-grey area
    ctx.fillStyle = 'rgba(72, 72, 72, 0.92)';
    ctx.beginPath();
    ctx.moveTo(padLeft, pCloudC.top + pCloudC.h);
    for (var i = 0; i < N; i++) {
      ctx.lineTo(xAt(i), yFrac(m.cldlow_aver[i]));
    }
    ctx.lineTo(padLeft + plotW, pCloudC.top + pCloudC.h);
    ctx.closePath();
    ctx.fill();

    // Contour line for medium clouds (white)
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (var i = 0; i < N; i++) {
      var x = xAt(i), y = yFrac(m.cldmed_aver[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Contour line for high clouds (light grey)
    ctx.strokeStyle = '#b8b8b8';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (var i = 0; i < N; i++) {
      var x = xAt(i), y = yFrac(m.cldhigh_aver[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Very low clouds (cldvlow_aver) top inverted brown-red line (as in ICM UM4)
    ctx.strokeStyle = isDark ? '#ff7b72' : '#b43c14';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (var i = 0; i < N; i++) {
      var x = xAt(i), y = pCloudC.top + pCloudC.h * (m.cldvlow_aver[i] || 0);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Fog vertical yellow bars with horizontal black hatching (old-meteo.jpg style)
    for (var i = 0; i < N; i++) {
      var fg = m.fog_max[i] || 0;
      if (fg > 0.01) {
        var fx = xAt(i) - 2;
        var fy = yFrac(fg);
        var fh = pCloudC.top + pCloudC.h - fy;
        ctx.fillStyle = '#ffbb00';
        ctx.fillRect(fx, fy, 4, fh);
        ctx.strokeStyle = isDark ? '#553300' : '#332200';
        ctx.lineWidth = 0.7;
        ctx.strokeRect(fx, fy, 4, fh);
        for (var hy = pCloudC.top + pCloudC.h - 3; hy > fy; hy -= 3) {
          ctx.beginPath();
          ctx.moveTo(fx, hy);
          ctx.lineTo(fx + 4, hy);
          ctx.stroke();
        }
      }
    }
    ctx.restore();

    var cldRatios = [0, 0.25, 0.5, 0.75, 1.0];
    var fogLabels = ['0', '0.25', '0.5', '0.75', '1'];
    ctx.font = '10px ' + MONO_FONT;
    ctx.textBaseline = 'middle';
    for (var k = 0; k < cldRatios.length; k++) {
      var r = cldRatios[k];
      var y = pCloudC.top + pCloudC.h * (1 - r);
      ctx.fillStyle = isDark ? '#e6edf3' : '#000000';
      ctx.textAlign = 'right';
      ctx.fillText(String(k * 2), padLeft - 4, y);
      ctx.fillStyle = isDark ? '#f0883e' : '#d27800';
      ctx.textAlign = 'left';
      ctx.fillText(fogLabels[k], padLeft + plotW + 4, y);
    }
    drawPanelGridAndBorder(pCloudC, cldRatios);
    drawRotatedLabel(['zachmurzenie', '(oktanty)'], 16, pCloudC.top + pCloudC.h / 2, -90, '#000080');
    drawRotatedLabel(['(frakcja)', 'mgła'], totalW - 16, pCloudC.top + pCloudC.h / 2, 90, '#000080');

    // =========================================================================
    // BOTTOM UTC TIME AXIS & FOOTER
    // =========================================================================
    var botBandY = pCloudC.top + pCloudC.h + 1;
    var botBandH = 26;
    for (var i = 0; i < N; i++) {
      var x0 = i === 0 ? padLeft : xAt(i) - stepX / 2;
      var x1 = i === N - 1 ? padLeft + plotW : xAt(i) + stepX / 2;
      ctx.fillStyle = isDark
        ? (m.isNight[i] ? '#1c2129' : '#282e37')
        : (m.isNight[i] ? '#dcdcdc' : '#f5f5f5');
      ctx.fillRect(x0, botBandY, x1 - x0, botBandH);
    }

    ctx.fillStyle = isDark ? '#e6edf3' : '#000000';
    ctx.font = '11px ' + MONO_FONT;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'right';
    ctx.fillText('UTC', padLeft - 6, botBandY + 2);
    ctx.textAlign = 'left';
    ctx.fillText('UTC', padLeft + plotW + 6, botBandY + 2);

    ctx.textAlign = 'center';
    for (var i = 0; i < N; i++) {
      var ut = m.utcTimes[i];
      if (ut.hour % 6 === 3) {
        ctx.font = '11px ' + MONO_FONT;
        ctx.fillStyle = isDark ? '#e6edf3' : '#000000';
        ctx.fillText(String(ut.hour).padStart(2, '0'), xAt(i), botBandY + 2);
      }
      if (ut.hour === 12 && i > 2 && i < N - 2) {
        ctx.font = '11px ' + MONO_FONT;
        ctx.fillStyle = isDark ? '#e6edf3' : '#000000';
        ctx.fillText(ut.shortDate, xAt(i), botBandY + 14);
      }
    }

    // Footer credits
    ctx.fillStyle = isDark ? '#58a6ff' : '#000080';
    ctx.font = '11px ' + MONO_FONT;
    ctx.textAlign = 'left';
    ctx.fillText('meteo@icm.edu.pl', 12, totalH - 16);
    ctx.textAlign = 'right';
    ctx.fillStyle = isDark ? '#8b949e' : '#000080';
    ctx.fillText('© 2007-2026 ICM, Uniwersytet Warszawski', totalW - 12, totalH - 16);

    // =========================================================================
    // HOVER CROSSHAIR
    // =========================================================================
    if (state.hoverIndex !== null && state.hoverIndex >= 0 && state.hoverIndex < N) {
      var hx = Math.round(xAt(state.hoverIndex)) + 0.5;
      ctx.save();
      ctx.strokeStyle = isDark ? 'rgba(255, 100, 100, 0.85)' : 'rgba(200, 0, 0, 0.7)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, pTemp.top);
      ctx.lineTo(hx, pCloudC.top + pCloudC.h);
      ctx.stroke();
      ctx.restore();
    }
  }

  function applyTheme(t) {
    state.theme = t === 'light' ? 'light' : 'dark';
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('meteo_theme', state.theme);
      }
    } catch (e) {}
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.setAttribute('data-theme', state.theme);
    }
    if (typeof document !== 'undefined') {
      var darkBtn = document.getElementById('theme-dark');
      var lightBtn = document.getElementById('theme-light');
      if (darkBtn && lightBtn && darkBtn.classList && lightBtn.classList) {
        if (state.theme === 'dark') {
          darkBtn.classList.add('active');
          lightBtn.classList.remove('active');
        } else {
          lightBtn.classList.add('active');
          darkBtn.classList.remove('active');
        }
      }
    }
    if (state.parsed) {
      renderMeteogram();
    }
  }

  // --- Interactive Hover & Event Listeners ---

  function setupInteractions() {
    var cityBtns = document.querySelectorAll('.btn-city');
    for (var i = 0; i < cityBtns.length; i++) {
      cityBtns[i].addEventListener('click', function () {
        loadMeteo(this.getAttribute('data-city'), null);
      });
    }

    var modelBtns = document.querySelectorAll('.btn-model');
    for (var j = 0; j < modelBtns.length; j++) {
      modelBtns[j].addEventListener('click', function () {
        loadMeteo(null, this.getAttribute('data-model'));
      });
    }

    var togglePrecip = document.getElementById('togglePrecipProb');
    if (togglePrecip) {
      togglePrecip.addEventListener('change', function () {
        state.showPrecipProb = this.checked;
        renderMeteogram();
      });
    }

    var togglePres = document.getElementById('toggleSeaLevelPres');
    if (togglePres) {
      togglePres.addEventListener('change', function () {
        state.useSeaLevelPressure = this.checked;
        renderMeteogram();
        updateReadout(state.hoverIndex !== null ? state.hoverIndex : 0);
      });
    }

    var darkBtn = document.getElementById('theme-dark');
    if (darkBtn) {
      darkBtn.addEventListener('click', function () {
        applyTheme('dark');
      });
    }
    var lightBtn = document.getElementById('theme-light');
    if (lightBtn) {
      lightBtn.addEventListener('click', function () {
        applyTheme('light');
      });
    }

    applyTheme(state.theme);

    var canvas = document.getElementById('meteogramCanvas');
    if (canvas) {
      canvas.addEventListener('mousemove', function (e) {
        if (!state.parsed) return;
        var rect = canvas.getBoundingClientRect();
        var x = e.clientX - rect.left;
        var idx = Math.round((x - 66) / 7);
        if (idx < 0 || idx >= state.parsed.count) {
          state.hoverIndex = null;
          renderMeteogram();
          updateReadout(0);
          return;
        }
        if (state.hoverIndex !== idx) {
          state.hoverIndex = idx;
          renderMeteogram();
          updateReadout(idx);
        }
      });

      canvas.addEventListener('mouseleave', function () {
        state.hoverIndex = null;
        renderMeteogram();
        updateReadout(0);
      });
    }

    window.addEventListener('resize', function () {
      updateReadout(state.hoverIndex !== null ? state.hoverIndex : 0);
    });
  }

  var ICMMeteo = {
    CITIES: CITIES,
    state: state,
    getWarsawInfo: getWarsawInfo,
    computeSunTimes: computeSunTimes,
    isNightTimestamp: isNightTimestamp,
    toDMS: toDMS,
    formatHM: formatHM,
    getPressureColor: getPressureColor,
    getWindFillColor: getWindFillColor,
    mapPiecewise: mapPiecewise,
    parseMeteoResponse: parseMeteoResponse,
    renderMeteogram: renderMeteogram,
    applyTheme: applyTheme,
    updateReadout: updateReadout,
    applyResponse: applyResponse,
    loadMeteo: loadMeteo
  };

  if (typeof window !== 'undefined') {
    window.ICMMeteo = ICMMeteo;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ICMMeteo;
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', function () {
      setupInteractions();
      loadMeteo('czestochowa', 'um4_60');
    });
  }
})();
