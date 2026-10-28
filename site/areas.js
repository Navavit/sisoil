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
// [id, map, layer, ชื่อ th, ชื่อ en, ช่วงชั้นใน SCALES, ตัวคูณจากค่าดิบของ ISRIC เป็นหน่วยของช่วงชั้น]
const SOILGRIDS = [
  ["sg_ph", "phh2o", "phh2o_0-5cm_mean", "pH ดินผิว 0–5 cm (SoilGrids 250 m)", "Topsoil pH 0–5 cm (SoilGrids 250 m)", "ph", 0.1],
  ["sg_om", "soc", "soc_0-5cm_mean", "อินทรียวัตถุ (OM) 0–5 cm จาก SOC (SoilGrids)", "Organic matter 0–5 cm from SOC (SoilGrids)", "om", 0.01724],   // dg/kg → OM % (× 1.724)
  ["sg_clay", "clay", "clay_0-5cm_mean", "ดินเหนียว 0–5 cm (SoilGrids)", "Clay 0–5 cm (SoilGrids)", "clay", 0.1],
  ["sg_n", "nitrogen", "nitrogen_0-5cm_mean", "ไนโตรเจน 0–5 cm (SoilGrids)", "Nitrogen 0–5 cm (SoilGrids)", "n", 0.01],
  ["sg_cec", "cec", "cec_0-5cm_mean", "CEC 0–5 cm (SoilGrids)", "CEC 0–5 cm (SoilGrids)", "cec", 0.1],
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

// สไตล์ SLD ให้ WMS ของ ISRIC วาดด้วยช่วงชั้นและสีเดียวกับจุด (สีของแต่ละรายการใช้ตั้งแต่ค่านั้นถึงรายการถัดไป)
function sgSld(sg) {
  const { bins, colors } = SCALES[sg[5]];
  const entries = colors.map((c, i) => [c, i ? bins[i - 1] / sg[6] : 0]).concat([[colors[colors.length - 1], 1e7]]);
  return `<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld"><NamedLayer><Name>${sg[2]}</Name><UserStyle><FeatureTypeStyle><Rule><RasterSymbolizer><ColorMap type="intervals">` +
    entries.map(([c, q]) => `<ColorMapEntry color="${c}" quantity="${+q.toFixed(3)}"/>`).join("") +
    "</ColorMap></RasterSymbolizer></Rule></FeatureTypeStyle></UserStyle></NamedLayer></StyledLayerDescriptor>";
}
const scaleList = (key) => `<ul class="legend">${scaleItems(key).map(([c, l]) => `<li><i style="background:${c}"></i>${esc(l)}</li>`).join("")}</ul>` +
  (refNote(key) ? `<p>${refNote(key)}</p>` : "") + `<p>${paletteNote(key)}</p>`;

function rasterLegend() {
  const id = $("raster").value, sg = SOILGRIDS.find((r) => r[0] === id), im = rasterMeta.find((r) => r.id === id);
  const parts = [];
  if (rasterLayer && sg) {
    parts.push(`<section><b>${esc(lang === "en" ? sg[4] : sg[3])}</b>
      ${scaleList(sg[5])}<p>ISRIC SoilGrids 2.0 · CC BY 4.0 · ${t("rasterEstimate")}</p></section>`);
  } else if (rasterLayer && im) {
    parts.push(`<section><b>${esc(lang === "en" ? im.en : im.th)}</b>
      ${scaleList(im.scale)}<p>${esc(im.source)} · ${esc(im.license)} · ${t("rasterEstimate")}</p></section>`);
  }
  if (rasterLayer && rasterScale(id) === colorVar) parts[0] = parts[0].replace("</section>", `<p>${t("rasterLinked")}</p></section>`);
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
      sld_body: sgSld(sg),
      attribution: "SoilGrids © ISRIC (CC BY 4.0)",
    });
  } else if (im) {
    rasterLayer = L.imageOverlay(`data/ref/rasters/${im.file}`, im.bounds, { opacity, pane: "rasters", attribution: `${im.source} (${im.license})` });
  }
  if (rasterLayer) map.addLayer(rasterLayer);
  $("raster-opts").hidden = !rasterLayer;
  $("raster-note").textContent = "";
  // สีของจุดใช้ค่าเดียวกับ raster (ถ้าจุดมีค่านั้น) ให้อ่านเทียบกันได้
  const key = rasterScale(id);
  if (key && COLOR_VARS[key] && key !== colorVar) setColorVar(key, true);
  else restyle();
  rasterLegend();
}
const rasterScale = (id) => SOILGRIDS.find((r) => r[0] === id)?.[5] || rasterMeta.find((r) => r.id === id)?.scale;

// เปลี่ยนสีของจุดแล้ว raster ที่เปิดอยู่เปลี่ยนเป็นค่าเดียวกัน (แหล่งเดิมก่อน) ถ้าไม่มีให้ปิด
function syncRaster(v) {
  const cur = $("raster").value;
  if (!rasterLayer || rasterScale(cur) === v) return;
  const ids = [...SOILGRIDS.map((r) => r[0]), ...rasterMeta.map((r) => r.id)].filter((id) => rasterScale(id) === v);
  const next = ids.find((id) => id.split("_")[0] === cur.split("_")[0]) || ids[0] || "";
  $("raster").value = next;
  setRaster();
  if (!next) $("raster-note").textContent = t("rasterNoMatch")(t("vars")[v]);
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
