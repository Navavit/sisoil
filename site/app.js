// แผนที่และตารางจุดสำรวจดิน (อ่านไฟล์ JSON ที่ระบบอัปเดตอัตโนมัติสร้างไว้)
// ระดับ pH ของจุดสำรวจภาคสนามใช้สีเดียวกับ SCALES.ph (scales.js); ต้นทางสะกด "กรดรุนแรงมากที่สุด" = "กรดรุนแรงที่สุด"
const PH_ORDER = [...SCALES.ph.levels.map((l, i) => [l, SCALES.ph.colors[i]]), ["กรดรุนแรงมากที่สุด", SCALES.ph.colors[0]], ["Other", "#9e9e9e"]];
const PH_COLOR = Object.fromEntries(PH_ORDER);
const LEVEL_ORDER = ["ต่ำมาก", "ต่ำ", "ปานกลาง", "สูง", "สูงมาก", "Other"];
const TABLE_LIMIT = 300;
// ข้อมูลที่ไม่มั่นใจตำแหน่ง ไม่แสดงบนเว็บ (ยังเก็บไว้ในข้อมูลหลังบ้าน) — ต้องตรงกับ HIDE_ON_MAP ใน scripts/admin.py
const HIDE_ON_MAP = ["no_coords", "outside_thailand", "off_land", "far_from_province", "no_location", "duplicate",
  "shared_coords", "multi_sample", "amphoe_mismatch", "date_future"];
const confident = (flags) => !(flags || []).some((f) => HIDE_ON_MAP.includes(f));

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let lang = pickLang();
let points = [];
let shown = [];   // จุด LDD ที่มั่นใจตำแหน่ง
let meta = {};
let log = [];
const markers = new Map();

function pickLang() {
  const q = new URLSearchParams(location.search).get("lang");
  if (q === "th" || q === "en") return q;
  try {
    const saved = localStorage.getItem("lang");
    if (saved === "th" || saved === "en") return saved;
  } catch (e) { /* storage อาจถูกปิด */ }
  return (navigator.language || "").startsWith("th") ? "th" : "en";
}

const t = (key) => I18N[lang][key] ?? key;
const val = (v) => (lang === "en" ? VALUE_EN[v] ?? v : v) ?? "";
const num = (n) => (n ?? 0).toLocaleString(lang === "th" ? "th-TH" : "en-GB");
const day = (d) => {
  if (!d) return "–";
  const x = new Date(d);
  return isNaN(x) ? d : x.toLocaleDateString(lang === "th" ? "th-TH" : "en-GB", { day: "numeric", month: "short", year: "numeric" });
};

const map = L.map("map", { preferCanvas: true }).setView([13.2, 101], 6);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18, attribution: "&copy; OpenStreetMap contributors", className: "basemap",   // สีเทาจาง (style.css) ให้จุดและขอบเขตเด่น
}).addTo(map);
const cluster = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 50, iconCreateFunction: (c) => clusterIcon(c) });
map.addLayer(cluster);

function popup(p) {
  const place = [p.subdistrict, p.district, p.province].filter(Boolean).join(", ") || p.location;
  return `<b>${t("point")} #${p.id}</b><br>${esc(place)}
    <table class="pop">
      <tr><td>${t("surveyDate")}</td><td><b>${day(p.date)}</b></td></tr>
      <tr><td>${t("firstSeen")}</td><td>${day(p.first_seen)}</td></tr>
      <tr><td>${t("lastSeen")}</td><td>${day(p.last_seen)}</td></tr>
      <tr><td>${t("detailFetched")}</td><td>${day(p.detail_fetched_at)}</td></tr>
      <tr><td>pH</td><td>${esc(val(p.ph))}</td></tr>
      <tr><td>OM · P · K</td><td>${esc(val(p.om))} · ${esc(val(p.p))} · ${esc(val(p.k))}</td></tr>
      <tr><td>${t("textureFieldLab")}</td><td>${esc(p.texture_field || "–")} / ${esc(p.texture_lab || "–")}</td></tr>
      ${(p.qa_flags || []).length ? `<tr><td>${t("qa")}</td><td class="flags">${p.qa_flags.map((f) => `<span>${esc(t("qaFlags")[f] || f)}</span>`).join(" ")}</td></tr>` : ""}
    </table>
    <span class="muted">${p.coord_source === "utm" ? t("coordUtm") : t("coordLdd")}</span>`;
}

function fillSelect(id, values, order, label = val) {
  const sel = $(id);
  const current = sel.value;
  const sorted = order
    ? [...values].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
    : [...values].sort();
  sel.innerHTML = `<option value="">${t("all")}</option>` +
    sorted.map((v) => `<option value="${esc(v)}">${esc(label(v))}</option>`).join("");
  sel.value = current;
}

function filtered() {
  const f = {
    province: $("f-province").value, ph: $("f-ph").value, om: $("f-om").value,
    p: $("f-p").value, k: $("f-k").value,
    from: +$("f-from").value || 0, to: +$("f-to").value || 9999,
    qa: $("f-qa").value, onlyNew: $("f-new").checked, q: $("q").value.trim().toUpperCase(),
  };
  const latestRun = log.length ? log[log.length - 1].date : null;
  return shown.filter((p) => {
    const y = +(p.date || "").slice(0, 4);
    return (!f.province || p.provinceName === f.province)
      && (!f.ph || p.ph === f.ph) && (!f.om || p.om === f.om)
      && (!f.p || p.p === f.p) && (!f.k || p.k === f.k)
      && (!y || (y >= f.from && y <= f.to))
      && (!f.onlyNew || p.first_seen === latestRun)
      && qaMatch(p.qa_flags || [], f.qa)
      && (!f.q || (p.location || "").toUpperCase().includes(f.q));
  });
}

// ธงที่ทำให้พิกัดไม่น่าเชื่อถือ
const BAD_COORD = ["no_coords", "utm_zone_fixed", "far_from_province", "duplicate"];
function qaMatch(flags, q) {
  if (!q) return true;
  if (q === "_clean") return flags.length === 0;
  if (q === "_coords") return !flags.some((f) => BAD_COORD.includes(f));
  return flags.includes(q);
}

// ---------- ชั้นผลวิเคราะห์ดิน (osd) ----------
const osdLayer = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 40, iconCreateFunction: (c) => clusterIcon(c) });
let osdMeta = null;
let wosisMeta = null;
let osdSites = [];
const OSD_PARAMS = [["ph", "pH", ""], ["ec_ds_m", "EC", "dS/m"], ["om_pct", "OM", "%"], ["p_mg_kg", "P", "mg/kg"], ["k_mg_kg", "K", "mg/kg"]];

// ช่วงชั้นและสีมาจาก SCALES (scales.js) ซึ่งแผนที่ดิน raster ใช้ชุดเดียวกัน
function classIndex(key, v) {
  const i = SCALES[key].bins.findIndex((b) => v < b);
  return i < 0 ? SCALES[key].bins.length : i;
}
const scaleColor = (key, v) => (v == null ? null : SCALES[key].colors[classIndex(key, v)]);
const phColor = (v) => scaleColor("ph", v) || "#9e9e9e";
// [สี, ข้อความ] ของแต่ละชั้น สำหรับคำอธิบายสี
function scaleItems(key) {
  const { bins, colors, levels, unit } = SCALES[key];
  return colors.map((c, i) => {
    const lo = bins[i - 1], hi = bins[i];
    const range = key === "ph"
      ? (lo == null ? `< ${hi}` : hi == null ? `≥ ${lo}` : `${lo}–${(hi - 0.1).toFixed(1)}`)
      : (lo == null ? `< ${hi}` : hi == null ? `> ${lo}` : `${lo}–${hi}`);
    const label = key === "ph" ? `pH ${range}` : `${range} ${unit}`;
    return [c, levels ? (key === "ph" ? `${label} ${val(levels[i])}` : `${val(levels[i])} ${label}`) : label];
  });
}
const FERT_REF = "http://oss101.ldd.go.th/osr_data%26service/OSR_PDF/TB_SSK_Distribute/D_SSK567.pdf";
const refNote = (key) => (SCALES[key].ref === "fert"
  ? `${esc(t("fertRef"))} <a href="${FERT_REF}" target="_blank" rel="noopener">${esc(t("fertRefLink"))}</a>` : "");
// อ้างอิงชุดสี (ColorBrewer)
const paletteNote = (key) => `${esc(t("paletteRef"))}: <a href="https://colorbrewer2.org/" target="_blank" rel="noopener">${esc(SCALES[key].palette)}</a> (Harrower & Brewer, 2003)`;

// ---------- ระบายสีจุดตามค่าที่เลือก ----------
const NO_DATA = "#b8b2a7";
// ค่าของแต่ละแหล่งสำหรับแต่ละตัวแปร (ช่วงชั้นอยู่ใน SCALES) — แหล่งที่ไม่มีค่านี้ไม่มี getter (แสดงเป็นสีจาง)
const COLOR_VARS = {
  ph: { osd: (s) => s.ph, wosis: (s) => s.ph_h2o_0_30, ldd: "ph" },
  ec: { osd: (s) => s.ec_ds_m, wosis: (s) => s.ec_ds_m_0_30 },
  om: { osd: (s) => s.om_pct, wosis: (s) => (s.orgc_g_kg_0_30 == null ? null : s.orgc_g_kg_0_30 * 0.1724), ldd: "om" },   // OM ≈ OC × 1.724
  n: { wosis: (s) => s.n_g_kg_0_30 },
  p: { osd: (s) => s.p_mg_kg, ldd: "p" },
  k: { osd: (s) => s.k_mg_kg, ldd: "k" },
  clay: { wosis: (s) => s.clay_pct_0_30 },
  silt: { wosis: (s) => s.silt_pct_0_30 },
  sand: { wosis: (s) => s.sand_pct_0_30 },
  cec: { wosis: (s) => s.cec_cmol_kg_0_30 },
};
// ระดับของจุดสำรวจภาคสนาม (5 ระดับ) รวมเป็น 3 ระดับตามเกณฑ์ความอุดมสมบูรณ์
const FERT3 = SCALES.om.colors;
const LEVEL_COLORS = { "ต่ำมาก": FERT3[0], "ต่ำ": FERT3[0], "ปานกลาง": FERT3[1], "สูง": FERT3[2], "สูงมาก": FERT3[2] };
let colorVar = "ph";

function colorFor(source, rec) {
  const def = COLOR_VARS[colorVar];
  if (source === "ldd") {   // จุดสำรวจภาคสนามมีแค่ระดับ
    if (!def.ldd) return null;
    return (def.ldd === "ph" ? PH_COLOR[rec.ph] : LEVEL_COLORS[rec[def.ldd]]) || null;
  }
  return scaleColor(colorVar, def[source]?.(rec));
}
// ขอบจุด: เมื่อเปิดแผนที่ดิน raster (สีชุดเดียวกัน) ใช้ขอบเข้มให้จุดไม่กลืนกับพื้นหลัง
const OUTLINE = { osd: "#ffffff", wosis: "#3a2a1a", ldd: "#00000055" };
const OUTLINE_ON_RASTER = { osd: "#1b1b1b", wosis: "#000000", ldd: "#1b1b1b" };
function styleFor(source, rec) {
  const c = colorFor(source, rec);
  const onRaster = typeof rasterLayer !== "undefined" && rasterLayer;
  return { fillColor: c || NO_DATA, fillOpacity: c ? .92 : .25, opacity: c ? 1 : .25,
    color: (onRaster ? OUTLINE_ON_RASTER : OUTLINE)[source] };
}

// สีของกลุ่มจุด = สีที่พบมากที่สุดในกลุ่ม (ไม่นับจุดที่ไม่มีค่า)
function clusterIcon(c) {
  const counts = {};
  for (const m of c.getAllChildMarkers()) {
    const f = m.options.fillColor;
    if (f !== NO_DATA) counts[f] = (counts[f] || 0) + 1;
  }
  const color = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || NO_DATA;
  const n = c.getChildCount(), size = n < 10 ? 30 : n < 100 ? 36 : 42;
  return L.divIcon({ html: `<div style="background:${color}"><span>${n}</span></div>`, className: "pt-cluster", iconSize: [size, size] });
}
function restyle() {
  for (const m of markers.values()) m.setStyle(styleFor("ldd", m.rec));
  osdLayer.eachLayer((m) => m.setStyle(styleFor("osd", m.rec)));
  wosisLayer.eachLayer((m) => m.setStyle(styleFor("wosis", m.rec)));
  cluster.refreshClusters();
  osdLayer.refreshClusters();
  renderLegend();
}
function renderLegend() {
  const def = COLOR_VARS[colorVar];
  const sel = $("color-by"), cur = colorVar;
  sel.innerHTML = Object.keys(COLOR_VARS).map((k) => `<option value="${k}">${esc(t("vars")[k])}</option>`).join("");
  sel.value = cur;
  const items = scaleItems(colorVar);
  const sources = ["wosis", "osd", "ldd"].filter((s) => def[s]).map((s) => t({ wosis: "layerWosis", osd: "layerOsd", ldd: "layerLdd" }[s]));
  $("legend").innerHTML = items.map(([c, l]) => `<li><i style="background:${c}"></i>${esc(l)}</li>`).join("") +
    `<li><i style="background:${NO_DATA};opacity:.5"></i>${esc(t("noValue"))}</li>` +
    `<li class="muted small">${esc(t("varSources")(sources.join(", ")))}${colorVar === "om" ? ` · ${esc(t("omNote"))}` : ""}</li>` +
    (refNote(colorVar) ? `<li class="muted small">${refNote(colorVar)}</li>` : "") +
    `<li class="muted small">${paletteNote(colorVar)}</li>`;
}

function osdPopup(s) {
  const place = [s.district, s.amphur, s.province].filter(Boolean).join(", ");
  const rows = OSD_PARAMS.map(([k, label, unit]) => {
    if (s[k] == null) return `<tr><td>${label}</td><td>–</td></tr>`;
    const range = s[k + "_min"] != null ? ` <span class="muted">(${s[k + "_min"]}–${s[k + "_max"]}, n=${s[k + "_n"]})</span>` : "";
    return `<tr><td>${label}</td><td><b>${s[k]}</b> ${unit}${range}</td></tr>`;
  }).join("");
  const flags = (s.qa_flags || []).length ? `<tr><td>${t("qa")}</td><td class="flags">${s.qa_flags.map((f) => `<span>${esc(f)}</span>`).join(" ")}</td></tr>` : "";
  return `<b>${t("osdSite")}</b><br>${esc(place)}
    <table class="pop">
      <tr><td>${t("analysisDate")}</td><td><b>${day(s.date)}</b></td></tr>
      <tr><td>${t("firstSeen")}</td><td>${day(s.first_seen)}</td></tr>
      <tr><td>${t("samples")}</td><td>${s.n_samples}${s.n_samples > 1 ? ` (${t("median")})` : ""}</td></tr>
      ${rows}${flags}
    </table>`;
}

async function loadOsdYear(year) {
  osdLayer.clearLayers();
  osdSites = (await fetch(`data/osd/sites_${year}.json`).then((r) => r.json()).catch(() => [])).filter((s) => confident(s.qa_flags));
  osdLayer.addLayers(osdSites.filter((s) => s.lat != null).map((s) => Object.assign(L.circleMarker([s.lat, s.lon], {
    radius: 5, weight: 1.5, ...styleFor("osd", s),
  }).bindPopup(() => osdPopup(s)), { rec: s })));
  $("osd-info").textContent = t("osdInfo")(num(osdSites.length), year);
}

async function initOsd() {
  const years = osdMeta?.years || [];
  $("osd-year").innerHTML = [...years].reverse().map((y) => `<option>${y}</option>`).join("");
  $("l-osd").disabled = $("osd-year").disabled = !years.length;
}

// ---------- ชั้น soil profile (WoSIS) ----------
const wosisLayer = L.layerGroup();
map.createPane("wosis").style.zIndex = 650;   // อยู่เหนือกลุ่มจุดของชั้นอื่น
let wosisProfiles = [];
const WOSIS_COLS = [["ph_h2o", "pH"], ["orgc_g_kg", "OC g/kg"], ["clay_pct", "Clay %"], ["sand_pct", "Sand %"], ["cec_cmol_kg", "CEC"]];

function wosisPopup(s) {
  const head = WOSIS_COLS.map(([, l]) => `<th>${l}</th>`).join("");
  const cell = (v) => `<td class="num">${v ?? "–"}</td>`;
  const rows = s.layers.map((ly) => `<tr><td>${ly.u ?? "?"}–${ly.l ?? "?"}${ly.name ? ` <span class="muted">${esc(ly.name)}</span>` : ""}</td>${WOSIS_COLS.map(([k]) => cell(ly[k])).join("")}</tr>`).join("");
  const top = `<tr><td><b>${t("topsoil")}</b></td>${WOSIS_COLS.map(([k]) => cell(s[k + "_0_30"])).join("")}</tr>`;
  return `<b>${t("wosisProfile")}</b> ${esc(s.code || s.id)}
    <table class="pop">
      <tr><td>${t("surveyYear")}</td><td><b>${esc(s.date || "–")}</b></td></tr>
      <tr><td>${t("dataset")}</td><td>${esc(s.dataset)} · ${esc(s.licence || "")}</td></tr>
      ${s.ldd_match ? `<tr><td>LDD</td><td>${t("nearLdd")(s.ldd_match.id, s.ldd_match.distance_m)}</td></tr>` : ""}
      ${s.wrb_group || s.usda_order ? `<tr><td>WRB / USDA</td><td>${esc(s.wrb_group || "–")} / ${esc(s.usda_order || "–")}</td></tr>` : ""}
      ${(s.qa_flags || []).length ? `<tr><td>${t("qa")}</td><td class="flags">${s.qa_flags.map((f) => `<span>${esc(f)}</span>`).join(" ")}</td></tr>` : ""}
    </table>
    ${s.layers.length ? `<table class="pop depth"><tr><th>${t("depth")}</th>${head}</tr>${top}${rows}</table>` : ""}`;
}

async function loadWosis() {
  wosisProfiles = await fetch("data/wosis/profiles.json").then((r) => r.json()).catch(() => []);
  wosisLayer.clearLayers();
  // profile ที่ซ้ำกับอีก profile ใน WoSIS ไม่วางบนแผนที่ (ดู duplicate_of)
  wosisProfiles = wosisProfiles.filter((s) => s.lat != null && !s.duplicate_of && confident(s.qa_flags));
  wosisProfiles.forEach((s) => Object.assign(L.circleMarker([s.lat, s.lon], {
    radius: 7, weight: 2, pane: "wosis", ...styleFor("wosis", s),
  }).bindPopup(() => wosisPopup(s), { maxWidth: 420 }), { rec: s }).addTo(wosisLayer));
  $("wosis-info").textContent = t("wosisInfo")(num(wosisProfiles.length));
}

function render() {
  const rows = filtered();
  cluster.clearLayers();
  if (!$("l-ldd").checked) return renderTable(rows);
  cluster.addLayers(rows.filter((p) => markers.has(p.id)).map((p) => markers.get(p.id)));

  renderTable(rows);
}

function renderTable(rows) {
  const withCoord = rows.filter((p) => p.lat != null).length;
  $("count").textContent = t("count")(num(rows.length), num(withCoord));
  $("rows").innerHTML = rows.slice(0, TABLE_LIMIT).map((p) => `
    <tr class="${markers.has(p.id) ? "clickable" : ""}" data-id="${p.id}">
      <td class="num">${p.id}</td><td>${day(p.date)}</td><td class="muted">${day(p.first_seen)}</td>
      <td>${esc(p.location)}</td>
      <td><i class="dot" style="background:${PH_COLOR[p.ph] || "#9e9e9e"}"></i> ${esc(val(p.ph))}</td>
      <td>${esc(val(p.om))}</td><td>${esc(val(p.p))}</td><td>${esc(val(p.k))}</td>
      <td>${esc(p.texture_field || "")}</td>
      <td class="num">${p.lat != null ? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}${p.coord_source === "utm" ? "*" : ""}${markers.has(p.id) ? "" : ` <span title="${esc(t("qaFlags").far_from_province)}">⚑</span>`}` : "–"}</td>
    </tr>`).join("");
  $("more").textContent = rows.length > TABLE_LIMIT ? t("more")(num(TABLE_LIMIT), num(rows.length)) : "";
}

function renderStatic() {
  document.documentElement.lang = lang;
  document.title = t("title");
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll("[data-lang]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.lang === lang));

  const hiddenLdd = points.length - shown.length;
  const items = [
    [num(wosisMeta?.unique_profiles ?? 0), t("statWosis")],
    [num(osdMeta?.sites_on_map ?? 0), t("statOsd")(num(osdMeta?.sites ?? 0))],
    [num(osdMeta?.measurements ?? 0), t("statMeasurements")],
    [num(shown.length), t("statLdd")(num(points.length))],
    [num((osdMeta ? osdMeta.sites - (osdMeta.sites_on_map ?? osdMeta.sites) : 0) + hiddenLdd), t("statHidden")],
  ];
  $("stats").innerHTML = items.map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join("");
  $("ldd-info").textContent = t("lddInfo")(num(shown.length), num(points.length));
  $("hidden-note").textContent = hiddenLdd ? t("hiddenNote")(num(hiddenLdd)) : "";
  $("updated").textContent = day([meta.updated_at, osdMeta?.updated_at].filter(Boolean).sort().pop());

  fillSelect("f-province", new Set(shown.map((p) => p.provinceName).filter(Boolean)), null, (v) => v);
  fillSelect("f-ph", new Set(shown.map((p) => p.ph).filter(Boolean)), PH_ORDER.map((x) => x[0]));
  for (const k of ["om", "p", "k"]) fillSelect(`f-${k}`, new Set(shown.map((p) => p[k]).filter(Boolean)), LEVEL_ORDER);
  const qaSel = $("f-qa"), qaCur = qaSel.value;
  const counts = {};
  shown.forEach((p) => (p.qa_flags || []).forEach((f) => { counts[f] = (counts[f] || 0) + 1; }));
  qaSel.innerHTML = `<option value="">${t("qaAll")}</option><option value="_clean">${t("qaClean")}</option>` +
    `<option value="_coords">${t("qaGoodCoords")}</option>` +
    Object.keys(t("qaFlags")).filter((f) => counts[f]).map((f) => `<option value="${f}">⚑ ${esc(t("qaFlags")[f])} (${num(counts[f])})</option>`).join("");
  qaSel.value = qaCur;
  renderLegend();

  $("log").innerHTML = [...log].reverse().map((e) => `
    <tr><td>${day(e.date)}</td><td class="num">${num(e.total)}</td><td class="num">+${num(e.added)}</td>
    <td class="num">−${num(e.removed)}</td><td class="num">${num(e.modified)}</td><td class="num">${num(e.details_pending)}</td></tr>`).join("");
}

function setLang(l) {
  lang = l;
  try { localStorage.setItem("lang", l); } catch (e) { /* ไม่เป็นไร */ }
  map.closePopup();
  renderStatic();
  render();
  if (osdSites.length) $("osd-info").textContent = t("osdInfo")(num(osdSites.length), $("osd-year").value);
  if (wosisProfiles.length) $("wosis-info").textContent = t("wosisInfo")(num(wosisProfiles.length));
  renderCheck();
  labelPick();
  renderAreasStatic();
}

async function load() {
  const [pts, m, lg, om, wm] = await Promise.all([
    fetch("data/ldd/points.json").then((r) => r.json()),
    fetch("data/meta.json").then((r) => r.json()),
    fetch("data/changelog.json").then((r) => r.json()).catch(() => []),
    fetch("data/osd/meta.json").then((r) => r.json()).catch(() => null),
    fetch("data/wosis/meta.json").then((r) => r.json()).catch(() => null),
  ]);
  meta = m;
  log = lg;
  osdMeta = om;
  wosisMeta = wm;
  // ชื่อจังหวัดจากรายละเอียด หรือส่วนท้ายของ location
  points = pts.map((p) => ({ ...p, provinceName: p.province || (p.location || "").split(",").pop().trim() }));
  shown = points.filter((p) => confident(p.qa_flags));
  for (const p of shown) {
    const mk = Object.assign(L.circleMarker([p.lat, p.lon], {
      radius: 6, weight: 1, ...styleFor("ldd", p), dashArray: p.coord_source === "utm" ? "2 2" : null,
    }).bindPopup(() => popup(p)), { rec: p });
    markers.set(p.id, mk);
  }
  renderStatic();
  render();
  await initOsd();
  // แหล่งที่เป็นค่าวัดจริงเปิดไว้ก่อน (WoSIS เชื่อถือได้มากที่สุด)
  if ($("l-wosis").checked) {
    await loadWosis();
    map.addLayer(wosisLayer);
  }
  if ($("l-osd").checked && $("osd-year").value) {
    await loadOsdYear($("osd-year").value);
    map.addLayer(osdLayer);
  }
}

for (const id of ["f-province", "f-ph", "f-om", "f-p", "f-k", "f-from", "f-to", "f-qa", "f-new"]) $(id).addEventListener("change", render);
$("q").addEventListener("input", () => { clearTimeout(window._qt); window._qt = setTimeout(render, 250); });
$("f-reset").addEventListener("click", () => {
  for (const id of ["f-province", "f-ph", "f-om", "f-p", "f-k", "f-from", "f-to", "f-qa", "q"]) $(id).value = "";
  $("f-new").checked = false;
  render();
});
$("rows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-id]");
  const mk = tr && markers.get(+tr.dataset.id);
  if (mk) cluster.zoomToShowLayer(mk, () => mk.openPopup());
});
document.querySelectorAll("[data-lang]").forEach((b) => b.addEventListener("click", () => setLang(b.dataset.lang)));
$("l-ldd").addEventListener("change", render);
$("color-by").addEventListener("change", () => { colorVar = $("color-by").value; restyle(); });
$("l-osd").addEventListener("change", async () => {
  if ($("l-osd").checked) {
    if (!osdSites.length) await loadOsdYear($("osd-year").value);
    map.addLayer(osdLayer);
  } else {
    map.removeLayer(osdLayer);
  }
});
$("osd-year").addEventListener("change", () => loadOsdYear($("osd-year").value));
$("l-wosis").addEventListener("change", async () => {
  if ($("l-wosis").checked) {
    if (!wosisProfiles.length) await loadWosis();
    map.addLayer(wosisLayer);
  } else {
    map.removeLayer(wosisLayer);
  }
});

renderStatic();
load().catch((err) => {
  $("stats").innerHTML = `<div class="stat">${t("loadError")}: ${esc(err.message)}</div>`;
});
