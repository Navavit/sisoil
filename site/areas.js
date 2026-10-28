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
  interactive: false, style: { color: "#3d2b1f", weight: 2, fill: false, opacity: .9 },
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
// [id, map, layer, ชื่อ th, ชื่อ en, ตัวหารเป็นหน่วยจริง, หน่วย]
const SOILGRIDS = [
  ["sg_ph", "phh2o", "phh2o_0-5cm_mean", "pH ดินผิว 0–5 cm (SoilGrids 250 m)", "Topsoil pH 0–5 cm (SoilGrids 250 m)", 10, "pH"],
  ["sg_soc", "soc", "soc_0-5cm_mean", "อินทรีย์คาร์บอน 0–5 cm (SoilGrids)", "Organic carbon 0–5 cm (SoilGrids)", 10, "g/kg"],
  ["sg_clay", "clay", "clay_0-5cm_mean", "ดินเหนียว 0–5 cm (SoilGrids)", "Clay 0–5 cm (SoilGrids)", 10, "%"],
  ["sg_n", "nitrogen", "nitrogen_0-5cm_mean", "ไนโตรเจน 0–5 cm (SoilGrids)", "Nitrogen 0–5 cm (SoilGrids)", 100, "g/kg"],
  ["sg_cec", "cec", "cec_0-5cm_mean", "CEC 0–5 cm (SoilGrids)", "CEC 0–5 cm (SoilGrids)", 10, "cmol/kg"],
];
const SG_WMS = "https://maps.isric.org/mapserv?map=/map/";
// สีและค่าขอบจากภาพ legend ของ ISRIC (GetLegendGraphic) — ใช้วาดแถบสีให้อ่านง่าย
const SG_LEGEND = {"phh2o": {"colors": ["#f0f63d", "#ebe51a", "#a5db36", "#81d255", "#54b93a", "#39b32f", "#359d3b", "#2c9840", "#34b07a", "#28b6b5", "#0fccd9"], "labels": [34, 48, 51, 52, 54, 55, 56, 57, 58, 59, 60, 61, 62, 64, 65, 67, 68, 70, 72, 73, 75, 76, 77, 79, 79, 80, 81, 82, 83, 92]}, "soc": {"colors": ["#fbf9f9", "#ede7e5", "#dfd4d1", "#d2c2bd", "#c4afa9", "#b69d95", "#a98a82", "#9b786e", "#8d655a", "#7f5246", "#724032"], "labels": [6, 27, 38, 43, 53, 64, 85, 106, 127, 142, 163, 184, 210, 236, 268, 299, 330, 362, 398, 445, 492, 560, 633, 727, 832, 962, 1114, 1312, 1521, 1839, 2174, 4471]}, "clay": {"colors": ["#f2dac1", "#e7c4a0", "#dcae80", "#d19860", "#c5894d", "#b97e44", "#ac743b", "#9f6832", "#935e29", "#875320", "#7a4917", "#764615"], "labels": [7, 32, 58, 83, 109, 134, 160, 185, 211, 236, 262, 288, 313, 339, 364, 390, 415, 441, 466, 492, 517, 543, 569, 594, 620, 645, 671, 696, 722, 747, 773, 799]}, "nitrogen": {"colors": ["#f7fcf5", "#eaf7e6", "#d7f0d1", "#bee6b8", "#a2da9c", "#81ca80", "#5cb96a", "#3aa458", "#248c46", "#14853c", "#057f33", "#007d30"], "labels": [42, 80, 119, 157, 196, 234, 273, 311, 350, 388, 427, 466, 504, 543, 581, 620, 658, 697, 735, 774, 812, 851, 890, 928, 967, 1005, 1044, 1082, 1121, 1159, 1198, 1237]}, "cec": {"colors": ["#edf8fb", "#d7e8f2", "#c0d7e9", "#adc4df", "#9eafd3", "#8f9ac8", "#8b81bc", "#8968b0", "#8e50aa", "#a837b4", "#c11fbe", "#ca17c2"], "labels": [11, 95, 111, 122, 130, 137, 145, 153, 161, 170, 179, 189, 199, 209, 219, 229, 239, 249, 258, 270, 282, 296, 313, 337, 359, 380, 404, 431, 465, 505, 570, 852]}};
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
// ---------- คำอธิบายสีบนแผนที่ (แผนที่ดิน raster และการใช้ที่ดิน) ----------
const MapLegend = L.Control.extend({
  options: { position: "bottomleft" },
  onAdd() {
    const d = L.DomUtil.create("div", "map-legend");
    d.id = "map-legend";
    d.hidden = true;
    L.DomEvent.disableClickPropagation(d);
    L.DomEvent.disableScrollPropagation(d);
    return d;
  },
});
map.addControl(new MapLegend());
let legendOpen = true;

// แถบสี + ค่า 5 ตำแหน่ง (ช่วงค่าของ SoilGrids ไม่เป็นเส้นตรง จึงอ่านค่าจากตำแหน่งในรายการขอบ)
function sgRamp(sg) {
  const { colors, labels } = SG_LEGEND[sg[1]];
  const ticks = [0, .25, .5, .75, 1].map((f) => +(labels[Math.round(f * (labels.length - 1))] / sg[5]).toFixed(sg[5] >= 100 ? 2 : 1));
  return `<div class="ramp" style="background:linear-gradient(to right,${colors.join(",")})"></div>
    <div class="ramp-labels">${ticks.map((v) => `<span>${v}</span>`).join("")}</div><p>${t("unit")}: ${sg[6]}</p>`;
}

function rasterLegend() {
  const id = $("raster").value, sg = SOILGRIDS.find((r) => r[0] === id), im = rasterMeta.find((r) => r.id === id);
  const parts = [];
  if (rasterLayer && sg) {
    parts.push(`<section><b>${esc(lang === "en" ? sg[4] : sg[3])}</b>
      ${sgRamp(sg)}<p>ISRIC SoilGrids 2.0 · CC BY 4.0 · ${t("rasterEstimate")}</p></section>`);
  } else if (rasterLayer && im) {
    parts.push(`<section><b>${esc(lang === "en" ? im.en : im.th)}</b>
      <div class="ramp" style="background:linear-gradient(to right,${im.palette.join(",")})"></div>
      <div class="ramp-labels"><span>${im.min}</span><span>${im.unit}</span><span>${im.max}+</span></div>
      <p>${esc(im.source)} · ${esc(im.license)} · ${t("rasterEstimate")}</p></section>`);
  }
  if ($("l-lc").checked) {
    parts.push(`<section><b>${t("layerLandcover")} · ${$("lc-year").value}</b><ul class="legend lc">
      ${LC_CLASSES.map(([c, k]) => `<li><i style="background:${c};border-radius:2px"></i>${esc(t(k))}</li>`).join("")}</ul></section>`);
  }
  const box = $("map-legend");
  box.hidden = !parts.length;
  box.innerHTML = parts.length ? `<details ${legendOpen ? "open" : ""}><summary>${t("mapLegend")}</summary>${parts.join("")}</details>` : "";
  box.querySelector("details")?.addEventListener("toggle", (e) => { legendOpen = e.target.open; });
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
  rasterLegend();
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
  rasterLegend();
});
$("lc-year").addEventListener("change", () => { landCover.redraw(); rasterLegend(); });
// สถานะการโหลดภาพการใช้ที่ดิน (บริการภายนอก อาจช้า)
let lcErrors = 0;
landCover.on("loading", () => { lcErrors = 0; $("lc-status").textContent = t("loadingLayer"); });
landCover.on("tileerror", () => { lcErrors++; });
landCover.on("load", () => { $("lc-status").textContent = lcErrors ? t("layerError") : ""; });
landCover.on("remove", () => { $("lc-status").textContent = ""; });
// เส้นขอบเขตอยู่ใต้จุดข้อมูล (SVG ของตัวเอง เพราะ canvas หลักของแผนที่อยู่ใน overlayPane)
map.createPane("areas").style.zIndex = 350;
map.createPane("rasters").style.zIndex = 300;   // แผนที่ดินอยู่ใต้เส้นขอบเขตและจุด
const areaRenderer = L.svg({ pane: "areas" });
for (const l of [provinceLayer, amphoeLayer, tambonLayer]) Object.assign(l.options, { pane: "areas", renderer: areaRenderer });
renderAreasStatic();
initRasters();
if ($("l-prov").checked) showProvinces();
