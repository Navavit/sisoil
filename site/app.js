// แผนที่และตารางจุดสำรวจดิน (อ่านไฟล์ JSON ที่ระบบอัปเดตอัตโนมัติสร้างไว้)
const PH_ORDER = [
  ["กรดรุนแรงมากที่สุด", "#7f0000"], ["กรดรุนแรงมาก", "#b30000"], ["กรดจัดมาก", "#d7301f"],
  ["กรดจัด", "#ef6548"], ["กรดปานกลาง", "#fc8d59"], ["กรดเล็กน้อย", "#fdbb84"],
  ["เป็นกลาง", "#9ccc65"], ["ด่างเล็กน้อย", "#6baed6"], ["ด่างปานกลาง", "#3182bd"],
  ["ด่างจัด", "#08519c"], ["Other", "#9e9e9e"],
];
const PH_COLOR = Object.fromEntries(PH_ORDER);
const LEVEL_ORDER = ["ต่ำมาก", "ต่ำ", "ปานกลาง", "สูง", "สูงมาก", "Other"];
const TABLE_LIMIT = 300;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let lang = pickLang();
let points = [];
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
  maxZoom: 18, attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);
const cluster = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 50 });
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
  return points.filter((p) => {
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
const osdLayer = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 40 });
let osdMeta = null;
let osdSites = [];
const OSD_PARAMS = [["ph", "pH", ""], ["ec_ds_m", "EC", "dS/m"], ["om_pct", "OM", "%"], ["p_mg_kg", "P", "mg/kg"], ["k_mg_kg", "K", "mg/kg"]];

function phColor(v) {
  if (v == null) return "#9e9e9e";
  const stops = [[4.5, "#b30000"], [5.0, "#d7301f"], [5.5, "#ef6548"], [6.0, "#fc8d59"], [6.5, "#fdbb84"],
    [7.3, "#9ccc65"], [7.8, "#6baed6"], [8.4, "#3182bd"], [99, "#08519c"]];
  return stops.find(([max]) => v < max)[1];
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
  osdSites = await fetch(`data/osd/sites_${year}.json`).then((r) => r.json()).catch(() => []);
  osdLayer.addLayers(osdSites.filter((s) => s.lat != null).map((s) => L.circleMarker([s.lat, s.lon], {
    radius: 5, weight: 1.5, color: "#ffffff", fillOpacity: .95, fillColor: phColor(s.ph),
  }).bindPopup(() => osdPopup(s))));
  $("osd-info").textContent = t("osdInfo")(num(osdSites.length), year);
}

async function initOsd() {
  osdMeta = await fetch("data/osd/meta.json").then((r) => r.json()).catch(() => null);
  const years = osdMeta?.years || [];
  $("osd-year").innerHTML = [...years].reverse().map((y) => `<option>${y}</option>`).join("");
  $("dl-osd-years").innerHTML = years.map((y) => `<a href="data/osd/measurements_${y}.csv.gz" download>${y}</a>`).join(" ");
  $("l-osd").disabled = $("osd-year").disabled = !years.length;
}

// ---------- ชั้น soil profile (WoSIS) ----------
const wosisLayer = L.layerGroup();
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
  wosisProfiles.filter((s) => s.lat != null && !s.duplicate_of).forEach((s) => L.circleMarker([s.lat, s.lon], {
    radius: 7, weight: 2, color: "#3a2a1a", fillOpacity: .9, fillColor: phColor(s.ph_h2o_0_30),
  }).bindPopup(() => wosisPopup(s), { maxWidth: 420 }).addTo(wosisLayer));
  $("wosis-info").textContent = t("wosisInfo")(num(wosisProfiles.filter((s) => !s.duplicate_of).length));
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

  const years = points.map((p) => +(p.date || "").slice(0, 4)).filter(Boolean);
  const range = years.length ? `${Math.min(...years)}–${Math.max(...years)}` : "–";
  const items = [
    [num(meta.total), t("statTotal")],
    [num(points.filter((p) => p.lat != null).length), t("statCoord")],
    [num(points.filter((p) => p.coord_source === "utm").length), t("statUtm")],
    [num(meta.provinces), t("statProv")],
    [range, t("statRange")],
    [num(points.filter((p) => (p.qa_flags || []).length).length), t("statFlagged")],
    [num(meta.details_pending), t("statPending")],
  ];
  $("stats").innerHTML = items.map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join("");
  $("updated").textContent = day(meta.updated_at);

  fillSelect("f-province", new Set(points.map((p) => p.provinceName).filter(Boolean)), null, (v) => v);
  fillSelect("f-ph", new Set(points.map((p) => p.ph).filter(Boolean)), PH_ORDER.map((x) => x[0]));
  for (const k of ["om", "p", "k"]) fillSelect(`f-${k}`, new Set(points.map((p) => p[k]).filter(Boolean)), LEVEL_ORDER);
  const qaSel = $("f-qa"), qaCur = qaSel.value;
  const counts = {};
  points.forEach((p) => (p.qa_flags || []).forEach((f) => { counts[f] = (counts[f] || 0) + 1; }));
  qaSel.innerHTML = `<option value="">${t("qaAll")}</option><option value="_clean">${t("qaClean")}</option>` +
    `<option value="_coords">${t("qaGoodCoords")}</option>` +
    Object.keys(t("qaFlags")).filter((f) => counts[f]).map((f) => `<option value="${f}">⚑ ${esc(t("qaFlags")[f])} (${num(counts[f])})</option>`).join("");
  qaSel.value = qaCur;
  $("legend").innerHTML = PH_ORDER.map(([l, c]) => `<li><i style="background:${c}"></i>${esc(val(l))}</li>`).join("");

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
  if (wosisProfiles.length) $("wosis-info").textContent = t("wosisInfo")(num(wosisProfiles.filter((s) => !s.duplicate_of).length));
  renderCheck();
  labelPick();
}

async function load() {
  const [pts, m, lg] = await Promise.all([
    fetch("data/ldd/points.json").then((r) => r.json()),
    fetch("data/meta.json").then((r) => r.json()),
    fetch("data/changelog.json").then((r) => r.json()).catch(() => []),
  ]);
  meta = m;
  log = lg;
  // ชื่อจังหวัดจากรายละเอียด หรือส่วนท้ายของ location
  points = pts.map((p) => ({ ...p, provinceName: p.province || (p.location || "").split(",").pop().trim() }));
  for (const p of points) {
    // พิกัดที่รู้ว่าผิดที่ (เช่น ตกทะเล) ไม่วางบนแผนที่ แต่ยังอยู่ในตาราง
    if (p.lat == null || (p.qa_flags || []).includes("far_from_province")) continue;
    const mk = L.circleMarker([p.lat, p.lon], {
      radius: 6, weight: 1, color: "#00000055", fillOpacity: .9,
      fillColor: PH_COLOR[p.ph] || "#9e9e9e", dashArray: p.coord_source === "utm" ? "2 2" : null,
    }).bindPopup(() => popup(p));
    markers.set(p.id, mk);
  }
  renderStatic();
  render();
  await initOsd();
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
