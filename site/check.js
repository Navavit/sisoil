// ตรวจดินจากพิกัด: ค่าวัดจริงใกล้เคียง (LDD, ผลวิเคราะห์ดิน, WoSIS), ค่าประมาณจากแผนที่ดินโลก, บัตรดินดีของตำบล
// ใช้ตัวแปรร่วมจาก app.js: map, t, esc, num, day, val, phColor, $
const PH_CLASSES = [
  [3.5, "กรดรุนแรงที่สุด"], [4.5, "กรดรุนแรงมาก"], [5.1, "กรดจัดมาก"], [5.6, "กรดจัด"], [6.1, "กรดปานกลาง"],
  [6.6, "กรดเล็กน้อย"], [7.4, "เป็นกลาง"], [7.9, "ด่างเล็กน้อย"], [8.5, "ด่างปานกลาง"], [9.1, "ด่างจัด"], [99, "ด่างจัดมาก"],
];
const phClass = (v) => (v == null ? "" : PH_CLASSES.find(([max]) => v < max)[1]);
const SG_PROPS = [["phh2o", "pH"], ["soc", "SOC g/kg"], ["clay", "Clay %"], ["silt", "Silt %"], ["sand", "Sand %"], ["cec", "CEC"]];
const SG_DEPTHS = ["0-5cm", "5-15cm", "15-30cm"];
const GEE_LABELS = {
  olm_ph_0cm: "pH (OpenLandMap 0 cm)", sg_ph_0_5cm: "pH (SoilGrids 0–5 cm)",
  olm_oc_g_kg_0cm: "OC g/kg (OpenLandMap)", sg_soc_g_kg_0_5cm: "SOC g/kg (SoilGrids)",
  sg_clay_pct_0_5cm: "Clay % (SoilGrids)", sg_sand_pct_0_5cm: "Sand % (SoilGrids)",
  gsoc_t_ha_0_30cm: "SOC stock 0–30 cm t/ha (FAO GSOCmap)",
};

let checkIndex = null;
const cellCache = new Map();
let dindee = null;
let checkState = null;   // { lat, lon, radius, data, place, sg, sgError }
const pickLayer = L.layerGroup().addTo(map);
let picking = false;

function distKm(a, b, c, d) {
  const r = Math.PI / 180;
  const x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}
const km = (d) => (d < 1 ? `${Math.round(d * 1000)} ${t("m")}` : `${d.toFixed(1)} ${t("km")}`);
const fmt = (v, digits = 1) => (v == null ? "–" : (+v).toFixed(digits).replace(/\.0+$/, ""));
const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// เนื้อดินตามสามเหลี่ยม USDA จาก % ทราย ทรายแป้ง ดินเหนียว
function textureClass(sand, silt, clay) {
  if ([sand, silt, clay].some((v) => v == null)) return null;
  if (clay >= 40 && silt < 40 && sand <= 45) return "clay";
  if (clay >= 40 && silt >= 40) return "silty clay";
  if (clay >= 35 && sand > 45) return "sandy clay";
  if (clay >= 27 && sand <= 20) return "silty clay loam";
  if (clay >= 27 && sand <= 45) return "clay loam";
  if (clay >= 20 && silt < 28 && sand > 45) return "sandy clay loam";
  if (silt >= 80 && clay < 12) return "silt";
  if (silt >= 50) return "silt loam";
  if (clay >= 7 && silt >= 28 && sand <= 52) return "loam";
  if (silt + 1.5 * clay < 15) return "sand";
  if (silt + 2 * clay < 30) return "loamy sand";
  return "sandy loam";
}

async function loadCells(lat, lon, radiusKm) {
  checkIndex ??= await fetch("data/web/index.json").then((r) => r.json()).catch(() => ({ cells: [], gee_cols: [] }));
  const dLat = radiusKm / 111, dLon = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  const keys = [];
  for (let i = Math.floor((lat - dLat) * 2); i <= Math.floor((lat + dLat) * 2); i++)
    for (let j = Math.floor((lon - dLon) * 2); j <= Math.floor((lon + dLon) * 2); j++) keys.push(`${i}_${j}`);
  const have = new Set(checkIndex.cells);
  const cells = await Promise.all(keys.filter((k) => have.has(k)).map((k) => {
    if (!cellCache.has(k)) cellCache.set(k, fetch(`data/web/grid/${k}.json`).then((r) => r.json()).catch(() => null));
    return cellCache.get(k);
  }));
  const out = { ldd: [], osd: [], wosis: [], gee: [] };
  for (const c of cells.filter(Boolean)) for (const k in out) out[k].push(...c[k]);
  return out;
}

function nearby(rows, latIdx, lat, lon, radiusKm) {
  return rows.map((r) => ({ r, d: distKm(lat, lon, r[latIdx], r[latIdx + 1]) }))
    .filter((x) => x.d <= radiusKm).sort((a, b) => a.d - b.d);
}

async function soilGrids(lat, lon) {
  const q = new URLSearchParams({ lat, lon, value: "mean" });
  SG_PROPS.forEach(([p]) => q.append("property", p));
  SG_DEPTHS.forEach((d) => q.append("depth", d));
  const r = await fetch(`https://rest.isric.org/soilgrids/v2.0/properties/query?${q}`);
  if (!r.ok) throw new Error(`SoilGrids ${r.status}`);
  const j = await r.json();
  const out = {};
  for (const layer of j.properties.layers) {
    const f = layer.unit_measure.d_factor || 1;
    out[layer.name] = Object.fromEntries(layer.depths.map((d) => [d.label, d.values.mean == null ? null : d.values.mean / f]));
  }
  return out;
}

async function placeName(lat, lon) {
  const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=th&lat=${lat}&lon=${lon}`);
  return r.ok ? (await r.json()).address || {} : {};
}

// จับคู่ที่อยู่จาก OSM กับตำบลในบัตรดินดี (ตำบล → อำเภอ → จังหวัด)
function matchDindee(addr) {
  if (!dindee) return null;
  const clean = (s) => (s || "").replace(/^(จังหวัด|อำเภอ|เขต|ตำบล|แขวง|เทศบาลตำบล|เทศบาลเมือง|เทศบาลนคร)\s*/, "").trim();
  const prov = clean(addr.province || addr.state || (addr.city === "กรุงเทพมหานคร" ? "กรุงเทพมหานคร" : ""));
  const amp = clean(addr.county || addr.city_district || addr.district);
  const tambonNames = [addr.suburb, addr.quarter, addr.subdistrict, addr.municipality, addr.town, addr.village, addr.hamlet].map(clean).filter(Boolean);
  const keys = Object.keys(dindee);
  const pick = (pred) => keys.filter((k) => pred(k.split("|")));
  let level = "tambon", hit = pick(([p, a, tb]) => p === prov && a === amp && tambonNames.includes(tb));
  if (!hit.length) { level = "amphoe"; hit = pick(([p, a]) => p === prov && a === amp); }
  if (!hit.length) { level = "province"; hit = pick(([p]) => p === prov); }
  if (!hit.length) return null;
  const sum = { n: 0, ph: {}, n_: {}, p: {}, k: {}, from: null, to: null };
  for (const k of hit) {
    const x = dindee[k];
    sum.n += x.n;
    for (const f of ["ph", "n_", "p", "k"]) for (const [c, n] of Object.entries(x[f])) sum[f][c] = (sum[f][c] || 0) + n;
    if (x.from && (!sum.from || x.from < sum.from)) sum.from = x.from;
    if (x.to && (!sum.to || x.to > sum.to)) sum.to = x.to;
  }
  const [p, a, tb] = hit[0].split("|");
  return { ...sum, level, name: level === "tambon" ? `${tb}, ${a}, ${p}` : level === "amphoe" ? `${a}, ${p}` : p };
}

async function checkAt(lat, lon) {
  if (!isFinite(lat) || !isFinite(lon) || lat < 5 || lat > 21 || lon < 97 || lon > 106) {
    $("check-msg").textContent = t("checkOutside");
    return;
  }
  const radius = +$("check-radius").value;
  $("check-msg").textContent = t("checkLoading");
  $("check-lat").value = lat.toFixed(5);
  $("check-lon").value = lon.toFixed(5);
  try { history.replaceState(null, "", `?at=${lat.toFixed(5)},${lon.toFixed(5)}${location.hash}`); } catch (e) { /* ไม่เป็นไร */ }

  pickLayer.clearLayers();
  L.circle([lat, lon], { radius: radius * 1000, color: "#8a5a2b", weight: 1.5, fillOpacity: .05, interactive: false }).addTo(pickLayer);
  const pin = L.circleMarker([lat, lon], { radius: 8, color: "#ffffff", weight: 3, fillColor: "#8a5a2b", fillOpacity: 1 }).addTo(pickLayer);
  map.setView([lat, lon], Math.max(map.getZoom(), radius <= 5 ? 12 : 11));

  checkState = { lat, lon, radius, data: null, place: null, sg: null, sgError: null };
  const state = checkState;
  const [data] = await Promise.all([
    loadCells(lat, lon, Math.max(radius, 25)),
    dindee ? null : fetch("data/web/dindee.json").then((r) => r.json()).then((d) => { dindee = d; }).catch(() => { dindee = {}; }),
  ]);
  if (state !== checkState) return;
  state.data = data;
  renderCheck();
  pin.bindPopup(() => pinPopup()).openPopup();

  placeName(lat, lon).then((a) => { state.place = a; }).catch(() => { state.place = {}; })
    .finally(() => { if (state === checkState) renderCheck(); });
  soilGrids(lat, lon).then((sg) => { state.sg = sg; }).catch((e) => { state.sgError = e.message; })
    .finally(() => { if (state === checkState) { renderCheck(); pin.setPopupContent(pinPopup()); } });
}

function summary() {
  const { lat, lon, radius, data } = checkState;
  const osd = nearby(data.osd, 0, lat, lon, radius);
  const ldd = nearby(data.ldd, 1, lat, lon, radius);
  const wosis = nearby(data.wosis, 2, lat, lon, 25);
  const gee = nearby(data.gee, 0, lat, lon, 1);
  return { osd, ldd, wosis, gee, osdPh: median(osd.map((x) => x.r[5])) };
}

function pinPopup() {
  const { lat, lon, sg } = checkState;
  const s = summary();
  const ph = s.osdPh ?? sg?.phh2o?.["0-5cm"];
  return `<b>${t("checkTitle")}</b><br><span class="muted">${lat.toFixed(5)}, ${lon.toFixed(5)}</span>
    <table class="pop">
      <tr><td>pH</td><td><b>${fmt(ph)}</b> ${esc(val(phClass(ph)))} <span class="muted">(${s.osdPh != null ? t("checkFromNearby")(num(s.osd.length)) : "SoilGrids"})</span></td></tr>
    </table><a href="#check">${t("checkSeeBelow")}</a>`;
}

const bar = (counts) => {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return "–";
  const order = PH_CLASSES.map((x) => x[1]);
  return `<div class="bar">${Object.entries(counts).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([c, n]) => `<i style="flex:${n};background:${phColor(phMid(c))}" title="${esc(val(c))}: ${n}"></i>`).join("")}</div>`;
};
// ค่ากลางของระดับ pH ไว้ใช้เลือกสี
function phMid(c) {
  const i = PH_CLASSES.findIndex((x) => x[1] === c);
  if (i < 0) return null;
  const lo = i ? PH_CLASSES[i - 1][0] : 3;
  return (lo + Math.min(PH_CLASSES[i][0], 10)) / 2;
}
const topClasses = (counts, k = 3) => {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, k)
    .map(([c, n]) => `${esc(val(c))} ${Math.round((100 * n) / total)}%`).join(" · ") || "–";
};

function renderCheck() {
  if (!checkState?.data) return;
  const { lat, lon, radius, place, sg, sgError } = checkState;
  const s = summary();
  $("check-msg").textContent = "";
  const placeText = place ? [place.village, place.suburb || place.municipality || place.town, place.county || place.city_district, place.province || place.state].filter(Boolean).join(", ") : t("checkLoading");

  // 1) ค่าวัดจริงใกล้เคียง
  const osdCols = [["ph", 5, 1], ["ec", 6, 2], ["om", 7, 1], ["p", 8, 0], ["k", 9, 0]];
  const osdMed = osdCols.map(([, i, dg]) => fmt(median(s.osd.map((x) => x.r[i])), dg));
  const osdHtml = s.osd.length ? `
    <p>${t("checkOsdSummary")(num(s.osd.length), radius)}</p>
    <table class="mini"><tr><th></th><th>pH</th><th>EC dS/m</th><th>OM %</th><th>P mg/kg</th><th>K mg/kg</th></tr>
      <tr><td><b>${t("median")}</b></td>${osdMed.map((v) => `<td class="num"><b>${v}</b></td>`).join("")}</tr>
      ${s.osd.slice(0, 5).map(({ r, d }) => `<tr><td>${km(d)} <span class="muted">${day(r[3])}${r[4] > 1 ? ` (${r[4]}×)` : ""}</span></td>${osdCols.map(([, i, dg]) => `<td class="num">${fmt(r[i], dg)}</td>`).join("")}</tr>`).join("")}
    </table>
    <p class="muted small">pH ${fmt(median(s.osd.map((x) => x.r[5])))} = ${esc(val(phClass(median(s.osd.map((x) => x.r[5])))))}</p>`
    : `<p class="muted">${t("checkNone")(radius)}</p>`;
  const lddHtml = s.ldd.length ? `<table class="mini"><tr><th>${t("point")}</th><th>${t("checkDistance")}</th><th>${t("surveyDate")}</th><th>pH</th><th>OM · P · K</th><th>${t("texture")}</th></tr>
      ${s.ldd.slice(0, 5).map(({ r, d }) => `<tr><td class="num">#${r[0]}</td><td>${km(d)}</td><td>${day(r[3])}</td><td><i class="dot" style="background:${PH_COLOR[r[4]] || "#9e9e9e"}"></i> ${esc(val(r[4]))}</td><td>${esc(val(r[5]))} · ${esc(val(r[6]))} · ${esc(val(r[7]))}</td><td>${esc(r[8] || "–")}</td></tr>`).join("")}
    </table>` : `<p class="muted">${t("checkNone")(radius)}</p>`;
  const w = s.wosis[0];
  const wosisHtml = w ? `<p>${esc(w.r[1] || w.r[0])} · ${km(w.d)} · ${esc(w.r[4] || "–")}<br>
      pH ${fmt(w.r[5])} · OC ${fmt(w.r[6])} g/kg · Clay ${fmt(w.r[7])}% · Sand ${fmt(w.r[8])}% <span class="muted">(${t("topsoil")})</span></p>`
    : `<p class="muted">${t("checkNone")(25)}</p>`;

  // 2) ค่าประมาณจากแผนที่ดินโลก
  let sgHtml;
  const sgEmpty = sg && SG_PROPS.every(([p]) => SG_DEPTHS.every((d) => sg[p]?.[d] == null));
  if (sgEmpty) {
    sgHtml = `<p class="muted">${t("checkSgEmpty")}</p>`;
  } else if (sg) {
    const tex = textureClass(sg.sand?.["0-5cm"], sg.silt?.["0-5cm"], sg.clay?.["0-5cm"]);
    sgHtml = `<table class="mini"><tr><th>${t("depth")}</th>${SG_PROPS.map(([, l]) => `<th>${l}</th>`).join("")}</tr>
      ${SG_DEPTHS.map((d) => `<tr><td>${d}</td>${SG_PROPS.map(([p]) => `<td class="num">${fmt(sg[p]?.[d])}</td>`).join("")}</tr>`).join("")}
    </table>
    <p class="small">${tex ? `${t("checkTexture")}: <b>${esc(t("textures")[tex] || tex)}</b> (0–5 cm) · ` : ""}${sg.phh2o?.["0-5cm"] != null ? `pH ${fmt(sg.phh2o["0-5cm"])} = ${esc(val(phClass(sg.phh2o["0-5cm"])))}` : ""}</p>`;
  } else {
    sgHtml = `<p class="muted">${sgError ? `${t("checkSgError")} (${esc(sgError)})` : t("checkLoading")}</p>`;
  }
  const g = s.gee[0];
  const geeRows = g ? checkIndex.gee_cols.map((c, i) => (GEE_LABELS[c] && g.r[i + 2] != null ? `<tr><td>${GEE_LABELS[c]}</td><td class="num">${fmt(g.r[i + 2])}</td></tr>` : "")).join("") : "";
  const geeHtml = geeRows ? `<p class="small muted">${t("checkGee")(km(g.d))}</p><table class="mini">${geeRows}</table>` : "";

  // 3) บัตรดินดี
  const dd = place ? matchDindee(place) : null;
  const ddHtml = !place ? `<p class="muted">${t("checkLoading")}</p>` : dd ? `
    <p>${t("checkDindeeAt")(esc(dd.name), t("checkLevel")[dd.level], num(dd.n))}${dd.from ? ` <span class="muted">(${day(dd.from)} – ${day(dd.to)})</span>` : ""}</p>
    ${bar(dd.ph)}
    <table class="mini">
      <tr><td>pH</td><td>${topClasses(dd.ph)}</td></tr>
      <tr><td>N*</td><td>${topClasses(dd.n_)}</td></tr>
      <tr><td>P</td><td>${topClasses(dd.p)}</td></tr>
      <tr><td>K</td><td>${topClasses(dd.k)}</td></tr>
    </table><p class="muted small">${t("checkDindeeNote")}</p>` : `<p class="muted">${t("checkDindeeNone")}</p>`;

  $("check-result").innerHTML = `
    <p class="check-head"><b>${lat.toFixed(5)}, ${lon.toFixed(5)}</b> · ${esc(placeText)}
      · <a href="https://www.google.com/maps?q=${lat},${lon}" target="_blank" rel="noopener">Google Maps</a></p>
    <div class="check-grid">
      <div class="card"><h3>${t("checkMeasured")}</h3>
        <h4>${t("layerOsd")}</h4>${osdHtml}
        <h4>${t("layerLdd")}</h4>${lddHtml}
        <h4>${t("layerWosis")}</h4>${wosisHtml}
      </div>
      <div class="card"><h3>${t("checkModel")}</h3>
        <h4>SoilGrids 250 m <span class="muted small">(ISRIC, CC BY 4.0)</span></h4>${sgHtml}${geeHtml}
        <h3>${t("checkDindee")}</h3>${ddHtml}
      </div>
    </div>
    <p class="small">${t("checkSeries")} <a href="https://lddcatalog.ldd.go.th/dataset/ldd_11_01" target="_blank" rel="noopener">${t("checkSeriesMap")}</a>
      · <a href="https://lddcatalog.ldd.go.th/dataset/oss01" target="_blank" rel="noopener">${t("checkGroupMap")}</a>
      · <a href="http://iddindee.ldd.go.th/SoilSeries/home.html" target="_blank" rel="noopener">${t("checkSeriesDesc")}</a></p>
    <p class="muted small">${t("checkDisclaimer")}</p>`;
}

// ปุ่มบนแผนที่ (ปุ่มในแผงอยู่ใต้แผนที่ ต้องเลื่อนขึ้นมา)
const PickControl = L.Control.extend({
  options: { position: "topright" },
  onAdd() {
    const b = L.DomUtil.create("button", "map-pick");
    b.type = "button";
    b.id = "map-pick";
    L.DomEvent.disableClickPropagation(b);
    L.DomEvent.on(b, "click", () => setPicking(!picking));
    return b;
  },
});
map.addControl(new PickControl());
function labelPick() { $("map-pick").textContent = t(picking ? "checkPickHint" : "checkPick"); }
labelPick();

function setPicking(on) {
  picking = on;
  labelPick();
  for (const id of ["check-pick", "map-pick"]) $(id).setAttribute("aria-pressed", on);
  if (on && !map.getContainer().getBoundingClientRect().height) return;
  if (on) map.getContainer().scrollIntoView({ behavior: "smooth", block: "center" });
  map.getContainer().style.cursor = on ? "crosshair" : "";
  $("check-msg").textContent = on ? t("checkPickHint") : "";
}

map.on("click", (e) => {
  if (!picking) return;
  setPicking(false);
  checkAt(e.latlng.lat, e.latlng.lng);
  $("check").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("check-pick").addEventListener("click", () => setPicking(!picking));
$("check-go").addEventListener("click", () => {
  // รับ "lat, lon" ที่วางรวมในช่องเดียวได้
  const parts = $("check-lat").value.split(/[,\s]+/).filter(Boolean);
  const lat = parseFloat(parts[0]), lon = parseFloat(parts.length > 1 ? parts[1] : $("check-lon").value);
  checkAt(lat, lon);
});
for (const id of ["check-lat", "check-lon"]) $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") $("check-go").click(); });
$("check-me").addEventListener("click", () => {
  if (!navigator.geolocation) return ($("check-msg").textContent = t("checkNoGeo"));
  $("check-msg").textContent = t("checkLoading");
  navigator.geolocation.getCurrentPosition((p) => checkAt(p.coords.latitude, p.coords.longitude),
    () => { $("check-msg").textContent = t("checkNoGeo"); }, { enableHighAccuracy: true, timeout: 15000 });
});
$("check-radius").addEventListener("change", () => { if (checkState) checkAt(checkState.lat, checkState.lon); });

{
  const at = new URLSearchParams(location.search).get("at");
  if (at) {
    const [la, lo] = at.split(",").map(Number);
    checkAt(la, lo);
  }
}
