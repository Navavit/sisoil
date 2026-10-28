// ช่วงชั้นและสีของทุกค่า — ใช้ร่วมกันทั้งระบบ: สีจุดบนแผนที่, คำอธิบายสี, แผนที่ดิน raster (SoilGrids ผ่าน SLD
// และภาพจาก scripts/build_rasters.py ซึ่งอ่านไฟล์นี้) — เนื้อหาหลัง "const SCALES =" ต้องเป็น JSON
// bins = ขอบบนของแต่ละชั้น (ค่า < bins[0] ได้สีแรก), colors มากกว่า bins หนึ่งสี
// levels: ชื่อระดับ (th) ของแต่ละชั้น; ref "fert" = เกณฑ์ความอุดมสมบูรณ์ของดิน กองสำรวจดิน (2523)
// สี: ColorBrewer (Harrower & Brewer, 2003, The Cartographic Journal 40(1):27–37; colorbrewer2.org)
//     pH ใช้ Spectral 11 สี (แดง-เหลือง-เขียว-น้ำเงิน ใกล้แผ่นเทียบสี pH), ระดับต่ำ/ปานกลาง/สูง ใช้ RdYlGn
const SCALES = {
 "ph": {"unit": "", "bins": [3.5, 4.5, 5.1, 5.6, 6.1, 6.6, 7.4, 7.9, 8.5, 9.1], "colors": ["#9e0142", "#d53e4f", "#f46d43", "#fdae61", "#fee08b", "#ffffbf", "#e6f598", "#abdda4", "#66c2a5", "#3288bd", "#5e4fa2"], "levels": ["กรดรุนแรงที่สุด", "กรดรุนแรงมาก", "กรดจัดมาก", "กรดจัด", "กรดปานกลาง", "กรดเล็กน้อย", "เป็นกลาง", "ด่างเล็กน้อย", "ด่างปานกลาง", "ด่างจัด", "ด่างจัดมาก"], "palette": "ColorBrewer Spectral"},
 "ec": {"unit": "dS/m", "bins": [0.2, 0.5, 1, 2, 4], "colors": ["#fef0d9", "#fdd49e", "#fdbb84", "#fc8d59", "#e34a33", "#b30000"], "palette": "ColorBrewer OrRd"},
 "om": {"unit": "%", "bins": [1.5, 3.5], "colors": ["#fc8d59", "#ffffbf", "#91cf60"], "levels": ["ต่ำ", "ปานกลาง", "สูง"], "ref": "fert", "palette": "ColorBrewer RdYlGn"},
 "n": {"unit": "g/kg", "bins": [0.5, 1, 1.5, 2, 3], "colors": ["#edf8fb", "#ccece6", "#99d8c9", "#66c2a4", "#2ca25f", "#006d2c"], "palette": "ColorBrewer BuGn"},
 "p": {"unit": "mg/kg", "bins": [10, 25], "colors": ["#fc8d59", "#ffffbf", "#91cf60"], "levels": ["ต่ำ", "ปานกลาง", "สูง"], "ref": "fert", "palette": "ColorBrewer RdYlGn"},
 "k": {"unit": "mg/kg", "bins": [60, 90], "colors": ["#fc8d59", "#ffffbf", "#91cf60"], "levels": ["ต่ำ", "ปานกลาง", "สูง"], "ref": "fert", "palette": "ColorBrewer RdYlGn"},
 "clay": {"unit": "%", "bins": [10, 20, 30, 40, 60], "colors": ["#ffffd4", "#fee391", "#fec44f", "#fe9929", "#d95f0e", "#993404"], "palette": "ColorBrewer YlOrBr"},
 "silt": {"unit": "%", "bins": [10, 20, 30, 40, 60], "colors": ["#ffffd4", "#fee391", "#fec44f", "#fe9929", "#d95f0e", "#993404"], "palette": "ColorBrewer YlOrBr"},
 "sand": {"unit": "%", "bins": [20, 40, 60, 70, 85], "colors": ["#ffffd4", "#fee391", "#fec44f", "#fe9929", "#d95f0e", "#993404"], "palette": "ColorBrewer YlOrBr"},
 "cec": {"unit": "cmol/kg", "bins": [10, 20], "colors": ["#fc8d59", "#ffffbf", "#91cf60"], "levels": ["ต่ำ", "ปานกลาง", "สูง"], "ref": "fert", "palette": "ColorBrewer RdYlGn"},
 "gsoc": {"unit": "t/ha", "bins": [20, 40, 60, 80, 100], "colors": ["#ffffcc", "#d9f0a3", "#addd8e", "#78c679", "#31a354", "#006837"], "palette": "ColorBrewer YlGn"}
};
