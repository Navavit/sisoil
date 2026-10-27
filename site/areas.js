// ชั้นพื้นที่: ขอบเขตจังหวัด/อำเภอ/ตำบล (COD-AB, CC BY-IGO) และการใช้ที่ดิน (Esri/Impact Observatory, CC BY 4.0)
// ใช้ตัวแปรร่วมจาก app.js: map, t, esc, $
const ADMIN_MIN_ZOOM = 9;     // อำเภอ
const TAMBON_MIN_ZOOM = 11;   // ตำบล
const LC_URL = "https://ic.imagery1.arcgis.com/arcgis/rest/services/Sentinel2_10m_LandCover/ImageServer/exportImage";
const LC_CLASSES = [
  ["#1a5bab", "lcWater"], ["#358221", "lcTrees"], ["#87d19e", "lcFlooded"], ["#ffdb5c", "lcCrops"],
  ["#ed022a", "lcBuilt"], ["#ede9e4", "lcBare"], ["#efcfa8", "lcRange"], ["#c8c8c8", "lcClouds"],
];
const LC_YEARS = [2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017];

let provinceData = null;
const provinceFiles = new Map();
const provinceLayer = L.geoJSON(null, {
  interactive: false, style: { color: "#5b4636", weight: 1.6, fill: false, opacity: .8 },
});
const amphoeLayer = L.geoJSON(null, { interactive: false, style: { color: "#5b4636", weight: 1, dashArray: "4 3", fill: false, opacity: .7 } });
const tambonLayer = L.geoJSON(null, { interactive: false, style: { color: "#7a6a5a", weight: .8, dashArray: "2 3", fill: false, opacity: .9 } });

// ---------- point in polygon ----------
function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function featureContains(f, lat, lon) {
  const b = f.bbox || (f.bbox = bboxOf(f.geometry));
  if (lon < b[0] || lat < b[1] || lon > b[2] || lat > b[3]) return false;
  const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
  return polys.some((rings) => rings.filter((r) => ringContains(r, lon, lat)).length % 2 === 1);
}
function bboxOf(g) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c) => (typeof c[0] === "number"
    ? (b[0] = Math.min(b[0], c[0]), b[1] = Math.min(b[1], c[1]), b[2] = Math.max(b[2], c[0]), b[3] = Math.max(b[3], c[1]))
    : c.forEach(walk));
  walk(g.coordinates);
  return b;
}

async function loadProvinces() {
  provinceData ??= fetch("data/ref/boundaries/province.geojson").then((r) => r.json());
  return provinceData;
}
function loadProvinceFile(code) {
  if (!provinceFiles.has(code)) provinceFiles.set(code, fetch(`data/ref/boundaries/${code}.json`).then((r) => r.json()).catch(() => null));
  return provinceFiles.get(code);
}

// หาจังหวัด อำเภอ ตำบล ที่พิกัดนี้ตกอยู่ (null ถ้าไม่อยู่บนบก)
async function areaAt(lat, lon) {
  const prov = (await loadProvinces()).features.find((f) => featureContains(f, lat, lon));
  if (!prov) return null;
  const fc = await loadProvinceFile(prov.properties.code);
  const find = (level) => fc?.features.find((f) => f.properties.level === level && featureContains(f, lat, lon))?.properties;
  return { province: prov.properties, amphoe: find(2), tambon: find(3) };
}
const areaName = (a) => (a ? (lang === "en" ? a.en : a.th) : "");

// ---------- แสดงขอบเขต ----------
async function showProvinces() {
  if (!provinceLayer.getLayers().length) provinceLayer.addData(await loadProvinces());
  map.addLayer(provinceLayer);
}

async function refreshAdmin() {
  if (!$("l-admin").checked) return;
  const z = map.getZoom();
  $("admin-info").textContent = z < ADMIN_MIN_ZOOM ? t("adminZoom") : "";
  if (z < ADMIN_MIN_ZOOM) {
    amphoeLayer.clearLayers();
    tambonLayer.clearLayers();
    return;
  }
  const view = map.getBounds();
  const provs = (await loadProvinces()).features.filter((f) => {
    const b = f.bbox || (f.bbox = bboxOf(f.geometry));
    return view.intersects([[b[1], b[0]], [b[3], b[2]]]);
  });
  const files = (await Promise.all(provs.map((f) => loadProvinceFile(f.properties.code)))).filter(Boolean);
  amphoeLayer.clearLayers();
  tambonLayer.clearLayers();
  for (const fc of files) {
    amphoeLayer.addData(fc.features.filter((f) => f.properties.level === 2));
    if (map.getZoom() >= TAMBON_MIN_ZOOM) tambonLayer.addData(fc.features.filter((f) => f.properties.level === 3));
  }
}

// ---------- การใช้ที่ดิน (ภาพจาก ArcGIS ImageServer ทีละ tile) ----------
const LandCoverLayer = L.TileLayer.extend({
  getTileUrl(c) {
    const size = 40075016.68557849 / 2 ** c.z, o = 20037508.342789244;
    const bbox = [c.x * size - o, o - (c.y + 1) * size, (c.x + 1) * size - o, o - c.y * size].join(",");
    const y = +$("lc-year").value;
    const time = `${Date.UTC(y, 0, 1)},${Date.UTC(y, 11, 31, 23, 59, 59)}`;
    const rule = encodeURIComponent(JSON.stringify({ rasterFunction: "Cartographic Renderer for Visualization and Analysis" }));
    return `${LC_URL}?bbox=${bbox}&bboxSR=3857&imageSR=3857&size=256,256&format=png&transparent=true&f=image&time=${time}&renderingRule=${rule}`;
  },
});
const landCover = new LandCoverLayer("", {
  opacity: .65, maxZoom: 18, attribution: "Land cover © Impact Observatory, Microsoft, Esri (CC BY 4.0)",
});

function renderAreasStatic() {
  $("lc-legend").innerHTML = LC_CLASSES.map(([c, k]) => `<li><i style="background:${c};border-radius:2px"></i>${esc(t(k))}</li>`).join("");
  if ($("l-admin").checked && map.getZoom() < ADMIN_MIN_ZOOM) $("admin-info").textContent = t("adminZoom");
}

$("lc-year").innerHTML = LC_YEARS.map((y) => `<option>${y}</option>`).join("");
$("l-prov").addEventListener("change", () => ($("l-prov").checked ? showProvinces() : map.removeLayer(provinceLayer)));
$("l-admin").addEventListener("change", () => {
  if ($("l-admin").checked) {
    map.addLayer(amphoeLayer).addLayer(tambonLayer);
    refreshAdmin();
  } else {
    map.removeLayer(amphoeLayer).removeLayer(tambonLayer);
    $("admin-info").textContent = "";
  }
});
map.on("moveend", refreshAdmin);
$("l-lc").addEventListener("change", () => {
  $("lc-opts").hidden = !$("l-lc").checked;
  if ($("l-lc").checked) map.addLayer(landCover); else map.removeLayer(landCover);
});
$("lc-year").addEventListener("change", () => landCover.redraw());
// เส้นขอบเขตอยู่ใต้จุดข้อมูล (SVG ของตัวเอง เพราะ canvas หลักของแผนที่อยู่ใน overlayPane)
map.createPane("areas").style.zIndex = 350;
const areaRenderer = L.svg({ pane: "areas" });
for (const l of [provinceLayer, amphoeLayer, tambonLayer]) Object.assign(l.options, { pane: "areas", renderer: areaRenderer });
renderAreasStatic();
if ($("l-prov").checked) showProvinces();
