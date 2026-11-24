// Genera dashboard/index.html (autocontenido e interactivo) a partir de logs/ejecuciones.jsonl.
//   npm run dashboard   → luego abre dashboard/index.html con doble clic
import fs from "node:fs";
import path from "node:path";

const entrada = process.env.LOG_PATH || "logs/ejecuciones.jsonl";
if (!fs.existsSync(entrada)) {
  console.error(`No existe ${entrada}. Primero ejecuta: npm run evaluar`);
  process.exit(1);
}
const lineas = fs.readFileSync(entrada, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const cal = new Map(lineas.filter((l) => l.evento === "calificacion").map((l) => [l.turno_id, l]));
const filas = lineas.filter((l) => l.evento === "turno").map((t) => ({ ...t, ...(cal.get(t.turno_id) ?? {}), calificado: cal.has(t.turno_id) }));

const HTML = String.raw`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard de observabilidad · Asistente Académico Duoc UC</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
:root{--bg:#f6f8fb;--card:#fff;--tx:#1d2733;--mut:#667085;--bd:#dfe5ec;--az:#1F4E79;--ok:#2e7d32;--mal:#c62828;--nar:#e07b00}
@media (prefers-color-scheme:dark){:root{--bg:#10151c;--card:#18202a;--tx:#e6ebf1;--mut:#9aa7b6;--bd:#2a3644;--az:#6fa8dc;--ok:#66bb6a;--mal:#ef5350;--nar:#ffa94d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.45 system-ui,Segoe UI,Arial,sans-serif;padding:16px}
h1{font-size:20px;margin:0 0 2px}.sub{color:var(--mut);margin-bottom:12px}
.filtros{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:14px}
select,label{font:inherit;color:var(--tx)}select{background:var(--card);border:1px solid var(--bd);border-radius:6px;padding:5px 8px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}
.kpi,.panel{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:12px}
.kpi b{display:block;font-size:24px;color:var(--az)}.kpi span{color:var(--mut);font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px;margin-bottom:14px}
.panel h2{font-size:14px;margin:0 0 8px}.panel canvas{max-height:260px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--bd);vertical-align:top}
th{color:var(--mut);font-weight:600;font-size:12px}tr.f{cursor:pointer}tr.f:hover{background:var(--bg)}
.ok{color:var(--ok);font-weight:600}.mal{color:var(--mal);font-weight:600}
pre{white-space:pre-wrap;background:var(--bg);border:1px solid var(--bd);border-radius:6px;padding:8px;margin:6px 0 0}
.nota{color:var(--mut);font-size:12px;margin-top:8px}
</style></head><body>
<h1>Observabilidad del Asistente Académico Duoc UC</h1>
<div class="sub" id="sub"></div>
<div class="filtros">
  <label>Tipo de caso <select id="fTipo"></select></label>
  <label>Caso <select id="fCaso"></select></label>
  <label><input type="checkbox" id="fMalos"> ver solo turnos fallidos o con errores</label>
</div>
<div class="kpis" id="kpis"></div>
<div class="grid">
  <div class="panel"><h2>Latencia promedio por nodo (ms)</h2><canvas id="cNodos"></canvas></div>
  <div class="panel"><h2>Latencia por turno (ms)</h2><canvas id="cLat"></canvas></div>
  <div class="panel"><h2>Precisión por tipo de caso (%)</h2><canvas id="cTipo"></canvas></div>
  <div class="panel"><h2>Errores y decisiones adaptativas (% de turnos)</h2><canvas id="cErr"></canvas></div>
  <div class="panel"><h2>Tokens por turno</h2><canvas id="cTok"></canvas></div>
</div>
<div class="panel"><h2>Turnos fallidos o con errores (clic para ver la respuesta)</h2><table id="tabla"></table>
<div class="nota">Las preguntas y respuestas se guardan con RUT, correos y teléfonos enmascarados, y el usuario va seudonimizado.</div></div>
<script>
const DATOS = __DATOS__;
const $ = (id) => document.getElementById(id);
const prom = (v) => { v = v.filter(Number.isFinite); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : null; };
const pct = (v) => v==null ? "n/d" : (v*100).toFixed(1)+"%";
const perc = (v,p) => { v = v.filter(Number.isFinite).sort((a,b)=>a-b); return v.length ? v[Math.min(v.length-1,Math.max(0,Math.ceil(p/100*v.length)-1))] : null; };
const fechas = (t) => [...new Set((String(t||"").match(/\b\d{2}-\d{2}-\d{4}\b/g)||[]))].sort().join("|");
const tipoDe = (d) => d.tipo || (d.meta && d.meta.tipo) || "uso real";
const casoDe = (d) => d.caso || (d.meta && d.meta.caso) || "(sin caso)";
const color = () => getComputedStyle(document.documentElement).getPropertyValue("--az").trim();
const charts = {};
function dibujar(id, cfg){ if(charts[id]) charts[id].destroy(); charts[id] = new Chart($(id), cfg); }

function poblar(sel, valores, etiqueta){ sel.innerHTML = '<option value="">'+etiqueta+'</option>' + valores.map(v=>'<option>'+v+'</option>').join(""); }
poblar($("fTipo"), [...new Set(DATOS.map(tipoDe))].sort(), "Todos");
poblar($("fCaso"), [...new Set(DATOS.map(casoDe))].sort(), "Todos");
["fTipo","fCaso","fMalos"].forEach(id => $(id).addEventListener("change", render));

function render(){
  const ft = $("fTipo").value, fc = $("fCaso").value, malos = $("fMalos").checked;
  const malo = (d) => d.ok===false || d.errores.length>0;
  const D = DATOS.filter(d => (!ft || tipoDe(d)===ft) && (!fc || casoDe(d)===fc) && (!malos || malo(d)));
  const cals = D.filter(d => d.calificado), n = D.length || 1;
  $("sub").textContent = D.length + " turnos · modelo " + (D[0] ? D[0].modelo : "n/d") + " · generado el " + new Date(__GENERADO__).toLocaleString("es-CL");

  const porCaso = {}; cals.forEach(d => (porCaso[casoDe(d)] ||= []).push(d));
  const cons = Object.values(porCaso).filter(a => a.length>1).map(a => { const c={}; a.forEach(d=>{const k=fechas(d.respuesta); c[k]=(c[k]||0)+1}); return Math.max(...Object.values(c))/a.length; });
  const lat = D.map(d => d.latencia_ms);
  const tasa = (f) => D.filter(f).length / n;
  const kpis = [
    ["Precisión", cals.length ? pct(cals.filter(d=>d.ok).length/cals.length) : "n/d", "respuestas correctas"],
    ["Consistencia", cons.length ? pct(prom(cons)) : "n/d", "misma respuesta en repeticiones"],
    ["Fechas inventadas", cals.filter(d=>(d.fechas_inventadas||[]).length).length, "respuestas con fechas inexistentes"],
    ["Latencia p50", Math.round(perc(lat,50)||0)+" ms", "mediana por turno"],
    ["Latencia p95", Math.round(perc(lat,95)||0)+" ms", "peor 5% de los turnos"],
    ["Tokens por turno", Math.round(prom(D.map(d=>d.llm.tokens_in+d.llm.tokens_out))||0), "entrada + salida"],
    ["Llamadas LLM por turno", (prom(D.map(d=>d.llm.llamadas))||0).toFixed(2), "planificador + ejecutor"],
    ["Turnos con error", pct(tasa(d=>d.errores.length>0)), "fallos de API o herramientas"]
  ];
  $("kpis").innerHTML = kpis.map(k => '<div class="kpi"><b>'+k[1]+'</b>'+k[0]+'<br><span>'+k[2]+'</span></div>').join("");

  const acum = {}; D.forEach(d => d.nodos.forEach(x => (acum[x.nodo] ||= []).push(x.ms)));
  const nodos = Object.entries(acum).map(([k,v]) => [k, prom(v)]).sort((a,b)=>b[1]-a[1]);
  dibujar("cNodos", {type:"bar", data:{labels:nodos.map(x=>x[0]), datasets:[{label:"ms", data:nodos.map(x=>+x[1].toFixed(1)), backgroundColor:color()}]}, options:{indexAxis:"y", plugins:{legend:{display:false}}, scales:{y:{ticks:{autoSkip:false}}}}});
  dibujar("cLat", {type:"bar", data:{labels:D.map((_,i)=>i+1), datasets:[{label:"ms", data:lat, backgroundColor:D.map(d=>d.errores.length||d.ok===false?"#c62828":color())}]}, options:{plugins:{legend:{display:false}}, scales:{x:{title:{display:true,text:"turno"}}}}});
  const tipos = {}; cals.forEach(d => (tipos[tipoDe(d)] ||= []).push(d.ok?1:0));
  dibujar("cTipo", {type:"bar", data:{labels:Object.keys(tipos).map(k=>k+" ("+(prom(tipos[k])*100).toFixed(0)+"%, n="+tipos[k].length+")"), datasets:[{label:"%", data:Object.values(tipos).map(v=>+(prom(v)*100).toFixed(1)), backgroundColor:color()}]}, options:{plugins:{legend:{display:false}}, scales:{y:{min:0,max:100},x:{ticks:{autoSkip:false}}}}});
  const e = [["Errores",tasa(d=>d.errores.length>0)],["Bloqueos verificador",tasa(d=>d.bloqueos_verificador>0)],["Mensaje seguro",tasa(d=>d.mensaje_seguro)],["Replanificación",tasa(d=>d.replans>0)],["Aclaración",tasa(d=>d.aclaracion)]];
  dibujar("cErr", {type:"bar", data:{labels:e.map(x=>x[0]), datasets:[{label:"%", data:e.map(x=>+(x[1]*100).toFixed(1)), backgroundColor:["#c62828","#e07b00","#e07b00",color(),color()]}]}, options:{plugins:{legend:{display:false}}, scales:{y:{min:0,max:100}}}});
  dibujar("cTok", {type:"bar", data:{labels:D.map((_,i)=>i+1), datasets:[{label:"entrada", data:D.map(d=>d.llm.tokens_in), backgroundColor:color()},{label:"salida", data:D.map(d=>d.llm.tokens_out), backgroundColor:"#e07b00"}]}, options:{scales:{x:{stacked:true,title:{display:true,text:"turno"}},y:{stacked:true}}}});

  const T = D.filter(malo);
  $("tabla").innerHTML = '<tr><th>Caso</th><th>Rep.</th><th>Resultado</th><th>Motivo</th><th>Latencia</th></tr>' + (T.length ? T.map((d,i) =>
    '<tr class="f" data-i="'+i+'"><td>'+casoDe(d)+'</td><td>'+((d.meta&&d.meta.rep)||"")+'</td><td class="mal">'+(d.errores.length?"error":"incorrecta")+'</td><td>'+(d.motivo||d.errores.join("; "))+'</td><td>'+Math.round(d.latencia_ms)+' ms</td></tr>').join("") : '<tr><td colspan="5" class="ok">Sin turnos fallidos con el filtro actual.</td></tr>');
  document.querySelectorAll("tr.f").forEach(tr => tr.addEventListener("click", () => {
    const d = T[+tr.dataset.i], sig = tr.nextElementSibling;
    if (sig && sig.classList.contains("det")) { sig.remove(); return; }
    tr.insertAdjacentHTML("afterend", '<tr class="det"><td colspan="5"><b>Pregunta:</b><pre>'+(d.pregunta||"")+'</pre><b>Respuesta:</b><pre>'+(d.respuesta||"(sin respuesta)")+'</pre></td></tr>');
  }));
}
render();
</script></body></html>`;

const salida = "dashboard/index.html";
fs.mkdirSync(path.dirname(salida), { recursive: true });
const seguro = (o) => JSON.stringify(o).replace(/</g, "\\u003c");
fs.writeFileSync(salida, HTML.replace("__DATOS__", () => seguro(filas)).replace("__GENERADO__", () => JSON.stringify(new Date().toISOString())));
console.log(`Dashboard generado con ${filas.length} turnos → ${salida}\nÁbrelo con doble clic en el navegador.`);