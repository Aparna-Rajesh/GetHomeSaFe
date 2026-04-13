// GetHomeSaFe — main app

const MAP_CENTER = [37.7900, -122.4320];
const MAP_ZOOM = 13;
const AVAILABLE_YEARS = ['2024', '2023', '2022'];

// ---------------------------------------------------------------------------
// Color scale — vivid against dark map tiles
// Low counts are translucent so they don't read as alarming
// ---------------------------------------------------------------------------
function getStyle(count) {
  if (!count || count === 0) return { opacity: 0, weight: 0 };
  if (count <= 2)  return { color: '#ffe033', opacity: 0.25, weight: 3 }; // barely there
  if (count <= 5)  return { color: '#ffaa00', opacity: 0.55, weight: 4 }; // worth knowing
  if (count <= 10) return { color: '#ff4400', opacity: 0.80, weight: 5 }; // elevated
  return              { color: '#cc0000', opacity: 1.00, weight: 7 };     // avoid
}

function formatHour(h) {
  if (h === 0)  return '12:00 am';
  if (h < 12)   return `${h}:00 am`;
  if (h === 12) return '12:00 pm';
  return `${h - 12}:00 pm`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentHour = new Date().getHours();
let crimeLayerVisible = true;
let hearsayLayerVisible = true;
let yearDataCache = {};      // { '2024': geojson, '2023': geojson, ... }
let activeYears = new Set(['2024']);    // default to most recent; others load on demand
let mergedCounts = null;     // Float32Array[numSegments * 24] averaged across active years
let baseGeoJSON = null;      // GeoJSON structure used for rendering (from first loaded year)
let crimeLayer = null;
let hearsayData = null;
let hearsayLayer = null;

// ---------------------------------------------------------------------------
// Map — dark CartoDB tiles so crime colors really pop
// Hearsay pane sits below the default overlay pane (400) so crime always reads on top
// ---------------------------------------------------------------------------
const map = L.map('map', {
  center: MAP_CENTER,
  zoom: MAP_ZOOM,
  zoomControl: true,
}).addLayer(
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors © CARTO',
  })
);

// Hearsay renders below crime data
map.createPane('hearsayPane').style.zIndex = 350;

// ---------------------------------------------------------------------------
// Loading overlay
// ---------------------------------------------------------------------------
function showLoading(msg) {
  let el = document.getElementById('loading');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loading';
    el.innerHTML = `<div class="spinner"></div><p></p>`;
    document.body.appendChild(el);
  }
  el.querySelector('p').textContent = msg;
  el.style.display = 'flex';
}

function hideLoading() {
  const el = document.getElementById('loading');
  if (el) el.style.display = 'none';
}

// ---------------------------------------------------------------------------
// Multi-year data loading & merging
// ---------------------------------------------------------------------------
async function fetchYear(year) {
  if (yearDataCache[year]) return yearDataCache[year];
  const resp = await fetch(`streets_${year}.geojson`);
  if (!resp.ok) {
    console.warn(`No data for ${year} — run the pipeline to generate streets_${year}.geojson`);
    return null;
  }
  const data = await resp.json();
  yearDataCache[year] = data;
  return data;
}

async function loadActiveYears() {
  const toLoad = [...activeYears].filter(y => !yearDataCache[y]);
  if (toLoad.length === 0) {
    rebuildMerged();
    return;
  }
  showLoading(`Loading crime data…`);
  try {
    await Promise.all(toLoad.map(y => fetchYear(y)));
  } finally {
    hideLoading();
  }
  rebuildMerged();
}

// Average counts across all active years, per segment per hour
function rebuildMerged() {
  const years = [...activeYears].filter(y => yearDataCache[y] != null);
  if (years.length === 0) {
    mergedCounts = null;
    baseGeoJSON = null;
    return;
  }

  // Use first available year as the base structure
  baseGeoJSON = yearDataCache[years[0]];
  const numSegments = baseGeoJSON.features.length;
  mergedCounts = new Array(numSegments).fill(null).map(() => new Array(24).fill(0));

  years.forEach(year => {
    const features = yearDataCache[year].features;
    for (let i = 0; i < Math.min(numSegments, features.length); i++) {
      const counts = features[i].properties.counts;
      if (!Array.isArray(counts)) continue;
      for (let h = 0; h < 24; h++) {
        mergedCounts[i][h] += (counts[h] || 0);
      }
    }
  });

  // Average and stamp directly onto each feature for easy lookup in style()
  const n = years.length;
  for (let i = 0; i < numSegments; i++) {
    for (let h = 0; h < 24; h++) {
      mergedCounts[i][h] = mergedCounts[i][h] / n;
    }
    baseGeoJSON.features[i].properties._merged = mergedCounts[i];
  }
}

// ---------------------------------------------------------------------------
// Crime layer rendering
// ---------------------------------------------------------------------------
function styleSegment(feature) {
  const merged = feature.properties._merged;
  const count = merged ? (merged[currentHour] || 0) : 0;
  return getStyle(count);
}

function renderCrimeLayer() {
  if (crimeLayer) { map.removeLayer(crimeLayer); crimeLayer = null; }
  if (!baseGeoJSON || !crimeLayerVisible) return;

  crimeLayer = L.geoJSON(baseGeoJSON, {
    style: styleSegment,
    onEachFeature(feature, layer) {
      const merged = feature.properties._merged;
      const count = merged ? Math.round(merged[currentHour] || 0) : 0;
      const rawName = feature.properties.name;
      const name = Array.isArray(rawName) ? rawName[0] : (rawName || 'Unnamed street');
      layer.bindPopup(`<b>${name}</b><br>${count} incident${count !== 1 ? 's' : ''} at ${formatHour(currentHour)}`);
    },
  }).addTo(map);
}

function refreshCrimeColors() {
  if (!crimeLayer) return;
  crimeLayer.setStyle(styleSegment);
  crimeLayer.eachLayer(layer => {
    const f = layer.feature;
    if (!f) return;
    const merged = f.properties._merged;
    const count = merged ? Math.round(merged[currentHour] || 0) : 0;
    const name = f.properties.name || 'Unnamed street';
    layer.setPopupContent(`<b>${name}</b><br>${count} incident${count !== 1 ? 's' : ''} at ${formatHour(currentHour)}`);
  });
}

// ---------------------------------------------------------------------------
// Hearsay layer
// ---------------------------------------------------------------------------
async function loadHearsayData() {
  if (hearsayData) return;
  const resp = await fetch('hearsay.json');
  hearsayData = await resp.json();
}

// Normalise a street name for matching: lowercase, expand abbreviations
function normaliseName(raw) {
  if (!raw) return '';
  const s = Array.isArray(raw) ? raw[0] : raw;
  return s.toLowerCase()
    .replace(/\bst\b/g, 'street')
    .replace(/\bave?\b/g, 'avenue')
    .replace(/\bblvd\b/g, 'boulevard')
    .replace(/\bdr\b/g, 'drive')
    .replace(/\bln\b/g, 'lane')
    .trim();
}

function renderHearsayLayer() {
  if (hearsayLayer) { map.removeLayer(hearsayLayer); hearsayLayer = null; }
  if (!hearsayData || !hearsayLayerVisible || !baseGeoJSON) return;

  const activeEntries = hearsayData.filter(e => e.hours.includes(currentHour));
  if (activeEntries.length === 0) return;

  hearsayLayer = L.layerGroup();
  activeEntries.forEach(entry => {
    const needle = normaliseName(entry.street);
    const matches = baseGeoJSON.features.filter(f =>
      normaliseName(f.properties.name).includes(needle)
    );
    matches.forEach(feature => {
      L.geoJSON(feature, {
        style: { color: '#ffb347', weight: 3, opacity: 0.45, dashArray: '6 5', pane: 'hearsayPane' },
      })
        .bindPopup(`<b>${entry.street}</b><br><i>${entry.note}</i>`)
        .addTo(hearsayLayer);
    });
  });

  hearsayLayer.addTo(map);
}

// ---------------------------------------------------------------------------
// Time scrubber
// ---------------------------------------------------------------------------
const slider = document.getElementById('time-slider');
const hourLabel = document.getElementById('selected-hour-label');
const nowBtn = document.getElementById('now-btn');
const currentTimeDisplay = document.getElementById('current-time-display');

function updateHour(h) {
  currentHour = h;
  slider.value = h;
  hourLabel.textContent = formatHour(h);
  refreshCrimeColors();
  renderHearsayLayer();
}

slider.addEventListener('input', () => updateHour(parseInt(slider.value)));
nowBtn.addEventListener('click', () => updateHour(new Date().getHours()));

function updateClock() {
  const now = new Date();
  const h = now.getHours(), m = String(now.getMinutes()).padStart(2, '0');
  const ampm = h < 12 ? 'am' : 'pm';
  currentTimeDisplay.textContent = `${h % 12 || 12}:${m} ${ampm}`;
}
updateClock();
setInterval(updateClock, 30000);

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
const toggleCrime = document.getElementById('toggle-crime');
const crimeExpandBtn = document.getElementById('crime-expand-btn');
const yearCheckboxesEl = document.getElementById('year-checkboxes');
const yearCbs = document.querySelectorAll('.year-cb');
const toggleHearsay = document.getElementById('toggle-hearsay');

const legend = document.getElementById('legend');

// Master crime toggle
toggleCrime.addEventListener('change', async () => {
  crimeLayerVisible = toggleCrime.checked;
  legend.classList.toggle('hidden', !crimeLayerVisible);
  if (crimeLayerVisible) {
    await loadActiveYears();
    renderCrimeLayer();
  } else {
    if (crimeLayer) { map.removeLayer(crimeLayer); crimeLayer = null; }
  }
});

// Expand/collapse year sub-checkboxes
crimeExpandBtn.addEventListener('click', () => {
  const isOpen = !yearCheckboxesEl.classList.contains('hidden');
  yearCheckboxesEl.classList.toggle('hidden', isOpen);
  crimeExpandBtn.classList.toggle('open', !isOpen);
});

// Individual year checkboxes
yearCbs.forEach(cb => {
  cb.addEventListener('change', async () => {
    activeYears = new Set([...yearCbs].filter(c => c.checked).map(c => c.value));

    // Keep master checkbox in sync
    toggleCrime.indeterminate = activeYears.size > 0 && activeYears.size < AVAILABLE_YEARS.length;
    toggleCrime.checked = activeYears.size > 0;
    crimeLayerVisible = activeYears.size > 0;

    if (crimeLayerVisible) {
      await loadActiveYears();
      renderCrimeLayer();
    } else {
      if (crimeLayer) { map.removeLayer(crimeLayer); crimeLayer = null; }
    }
  });
});

// Hearsay toggle
toggleHearsay.addEventListener('change', async () => {
  hearsayLayerVisible = toggleHearsay.checked;
  if (hearsayLayerVisible) {
    await loadHearsayData();
    // Hearsay needs crime GeoJSON for street geometry
    if (!baseGeoJSON) await loadActiveYears();
  }
  renderHearsayLayer();
});

// ---------------------------------------------------------------------------
// Init — load both layers on startup
// ---------------------------------------------------------------------------
updateHour(currentHour);
legend.classList.remove('hidden');
(async () => {
  await loadActiveYears();
  await loadHearsayData();
  renderCrimeLayer();
  renderHearsayLayer();
})();
