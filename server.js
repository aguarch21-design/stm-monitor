const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const app = express();

app.use(cors());
app.use(express.json());

// Supabase config
const SUPABASE_URL = 'https://zqwhzzzahzvodrpduxkd.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

// Load STM data (controles + horarios)
let STM_DATA = null;
try {
  STM_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'stm_data.json'), 'utf8'));
  console.log('STM data loaded OK');
} catch(e) {
  console.log('STM data not found:', e.message);
}

// Haversine distance in meters
function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dlat = (lat2-lat1)*Math.PI/180;
  const dlon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dlat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dlon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Calculate delay for a bus
function calcDelay(linea, busLat, busLon) {
  if (!STM_DATA) return null;
  const ctrls = STM_DATA.controles[linea];
  if (!ctrls || !ctrls.length) return null;

  // Find nearest control point
  let nearest = null, minDist = Infinity;
  for (const c of ctrls) {
    const d = distM(busLat, busLon, c.la, c.lo);
    if (d < minDist) { minDist = d; nearest = c; }
  }
  if (minDist > 500) return null;

  // Get current time in Uruguay (UTC-3)
  const now = new Date();
  const nowSeg = ((now.getUTCHours() - 3 + 24) % 24) * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
  const wd = new Date(now.getTime() - 3*3600*1000).getUTCDay();
  const tipoDia = (wd === 0) ? '3' : (wd === 6) ? '2' : '1';

  const lineaHor = STM_DATA.horarios[linea];
  if (!lineaHor) return null;
  const dayHor = lineaHor[tipoDia];
  if (!dayHor) return null;
  const horas = dayHor[nearest.c];
  if (!horas || !horas.length) return null;

  const VENTANA = 30 * 60;
  const horasFiltradas = horas.filter(h => Math.abs(h - nowSeg) <= VENTANA);
  if (!horasFiltradas.length) return null;

  let closest = horasFiltradas[0], minDiff = Infinity;
  for (const h of horasFiltradas) {
    const diff = Math.abs(h - nowSeg);
    if (diff < minDiff) { minDiff = diff; closest = h; }
  }

  const atrasoSeg = nowSeg - closest;
  const hh = Math.floor(closest/3600).toString().padStart(2,'0');
  const mm = Math.floor((closest%3600)/60).toString().padStart(2,'0');

  return {
    atraso_seg: atrasoSeg,
    atraso_min: Math.round(atrasoSeg/60*10)/10,
    control: nearest.d,
    control_cod: nearest.c,
    dist_m: Math.round(minDist),
    hora_teorica: `${hh}:${mm}`
  };
}

// Classify bus
function classifyBus(feature) {
  const p = feature.properties;
  const fr = p.frecuencia;
  const coords = feature.geometry ? feature.geometry.coordinates : null;

  if (!fr || fr > 300000) return { cat: 'ng', atraso_min: null, control: null, hora_teorica: null };

  if (coords && p.linea && STM_DATA) {
    const delay = calcDelay(String(p.linea), coords[1], coords[0]);
    if (delay !== null) {
      const a = delay.atraso_min;
      let cat;
      if (Math.abs(a) <= 2) cat = 'ok';
      else if (a > 2) cat = 'late';
      else cat = 'early';
      return { cat, atraso_min: a, control: delay.control, control_cod: delay.control_cod, hora_teorica: delay.hora_teorica, dist_m: delay.dist_m };
    }
  }

  if (fr > 2*60*1000) return { cat: 'bad', atraso_min: null, control: null, hora_teorica: null };
  return { cat: 'ok', atraso_min: null, control: null, hora_teorica: null };
}

// Save snapshot to Supabase
async function saveToSupabase(buses) {
  if (!SUPABASE_KEY) return;
  try {
    const now = new Date().toISOString();
    const rows = buses.map(f => ({
      timestamp: now,
      coche: f.properties.codigoBus,
      linea: f.properties.linea,
      empresa: f.properties.empresa,
      estado: f.properties._cat,
      atraso_min: f.properties._atraso_min,
      control: f.properties._control,
      hora_teorica: f.properties._hora_teorica,
      lat: f.geometry ? f.geometry.coordinates[1] : null,
      lng: f.geometry ? f.geometry.coordinates[0] : null
    }));

    await fetch(`${SUPABASE_URL}/rest/v1/bus_snapshots`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(rows)
    });
  } catch(e) {
    console.log('Supabase error:', e.message);
  }
}

// Main API endpoint
app.post('/api/buses', async (req, res) => {
  try {
    const r = await fetch('http://www.montevideo.gub.uy/buses/rest/stm-online', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {})
    });
    const data = await r.json();

    if (data.features) {
      for (const f of data.features) {
        const info = classifyBus(f);
        f.properties._cat = info.cat;
        f.properties._atraso_min = info.atraso_min;
        f.properties._control = info.control;
        f.properties._hora_teorica = info.hora_teorica;
        f.properties._dist_m = info.dist_m;
      }
      // Save to Supabase async (no await - no block response)
      saveToSupabase(data.features);
    }

    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve HTML
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'reporte-buses-stm.html')));
app.get('/reporte-buses-stm.html', (req, res) => res.sendFile(path.join(__dirname, 'reporte-buses-stm.html')));

// Health check
app.get('/health', (req, res) => res.json({status: 'ok', time: new Date().toISOString()}));

app.listen(process.env.PORT || 3001, () => console.log('STM server running'));
