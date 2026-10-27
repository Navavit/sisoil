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

// ---------- แผนที่ดิน (raster): SoilGrids ผ่าน WMS ของ ISRIC, อื่น ๆ เป็นภาพจาก Earth Engine (build_rasters.py) ----------
// [id, map, layer, ชื่อ th, ชื่อ en, คำอธิบายหน่วยของแถบสี th, en]
const SOILGRIDS = [
  ["sg_ph", "phh2o", "phh2o_0-5cm_mean", "pH ดินผิว 0–5 cm (SoilGrids 250 m)", "Topsoil pH 0–5 cm (SoilGrids 250 m)", "ค่าในแถบสี ÷ 10 = pH", "legend value ÷ 10 = pH"],
  ["sg_soc", "soc", "soc_0-5cm_mean", "อินทรีย์คาร์บอน 0–5 cm (SoilGrids)", "Organic carbon 0–5 cm (SoilGrids)", "ค่าในแถบสี ÷ 10 = g/kg", "legend value ÷ 10 = g/kg"],
  ["sg_clay", "clay", "clay_0-5cm_mean", "ดินเหนียว 0–5 cm (SoilGrids)", "Clay 0–5 cm (SoilGrids)", "ค่าในแถบสี ÷ 10 = %", "legend value ÷ 10 = %"],
  ["sg_n", "nitrogen", "nitrogen_0-5cm_mean", "ไนโตรเจน 0–5 cm (SoilGrids)", "Nitrogen 0–5 cm (SoilGrids)", "ค่าในแถบสี ÷ 100 = g/kg", "legend value ÷ 100 = g/kg"],
  ["sg_cec", "cec", "cec_0-5cm_mean", "CEC 0–5 cm (SoilGrids)", "CEC 0–5 cm (SoilGrids)", "ค่าในแถบสี ÷ 10 = cmol/kg", "legend value ÷ 10 = cmol/kg"],
];
const SG_WMS = "https://maps.isric.org/mapserv?map=/map/";
let rasterMeta = [];
let rasterLayer = null;

async function initRasters() {
  rasterMeta = await fetch("data/ref/rasters/rasters.json").then((r) => r.json()).catch(() => []);
  fillRasterSelect();
}
function fillRasterSelect() {
  const sel = $("raster"), cur = sel.value;
  sel.innerHTML = `<option value="">${t("rasterNone")}</option>` +
    SOILGRIDS.map((r) => `<option value="${r[0]}">${esc(lang === "en" ? r[4] : r[3])}</option>`).join("") +
    rasterMeta.map((r) => `<option value="${r.id}">${esc(lang === "en" ? r.en : r.th)}</option>`).join("");
  sel.value = cur;
  rasterLegend();
}
function rasterLegend() {
  const id = $("raster").value, sg = SOILGRIDS.find((r) => r[0] === id), im = rasterMeta.find((r) => r.id === id);
  $("raster-legend").innerHTML = sg
    ? `<img alt="" src="${SG_WMS}${sg[1]}.map&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetLegendGraphic&LAYER=${sg[2]}&FORMAT=image/png&SLD_VERSION=1.1.0"><p>${esc(lang === "en" ? sg[6] : sg[5])}</p>
       <p>ISRIC SoilGrids 2.0 · CC BY 4.0 · ${t("rasterEstimate")}</p>`
    : im ? `<div class="ramp" style="background:linear-gradient(to right,${im.palette.join(",")})"></div>
       <div class="ramp-labels"><span>${im.min}</span><span>${im.unit}</span><span>${im.max}+</span></div>
       <p>${esc(im.source)} · ${esc(im.license)} · ${t("rasterEstimate")}</p>` : "";
}
function setRaster() {
  if (rasterLayer) map.removeLayer(rasterLayer);
  rasterLayer = null;
  const id = $("raster").value, opacity = +$("raster-opacity").value;
  const sg = SOILGRIDS.find((r) => r[0] === id), im = rasterMeta.find((r) => r.id === id);
  if (sg) {
    rasterLayer = L.tileLayer.wms(`${SG_WMS}${sg[1]}.map`, {
      layers: sg[2], format: "image/png", transparent: true, version: "1.3.0", opacity, pane: "rasters",
      attribution: "SoilGrids © ISRIC (CC BY 4.0)",
    });
  } else if (im) {
    rasterLayer = L.imageOverlay(`data/ref/rasters/${im.file}`, im.bounds, { opacity, pane: "rasters", attribution: `${im.source} (${im.license})` });
  }
  if (rasterLayer) map.addLayer(rasterLayer);
  $("raster-opts").hidden = !rasterLayer;
  rasterLegend();
}
$("raster").addEventListener("change", setRaster);
$("raster-opacity").addEventListener("input", () => rasterLayer?.setOpacity(+$("raster-opacity").value));

function renderAreasStatic() {
  if (rasterMeta.length || $("raster").options.length) fillRasterSelect();
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
map.createPane("rasters").style.zIndex = 300;   // แผนที่ดินอยู่ใต้เส้นขอบเขตและจุด
const areaRenderer = L.svg({ pane: "areas" });
for (const l of [provinceLayer, amphoeLayer, tambonLayer]) Object.assign(l.options, { pane: "areas", renderer: areaRenderer });
renderAreasStatic();
initRasters();
if ($("l-prov").checked) showProvinces();
