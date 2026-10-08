// Herramientas del agente (LangChain tools con esquema zod).
// Capacidades: CONSULTA (calendario, hitos), ESCRITURA (agenda .md/.ics), MEMORIA (perfil).
import fs from "node:fs";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { proximosHitos } from "../calendario.js";
import { hoyActual, parseFecha, toISO } from "../lib/fechas.js";
import { PerfilStore } from "../memory/perfilStore.js";
import { crearRecuperadorPorDefecto } from "../retrieval/recuperador.js";

const Modalidad = z.enum(["base", "presencial", "online", ""]);

export function crearHerramientas({
  store = new PerfilStore(),
  carpetaSalidas = process.env.SALIDAS_PATH || "salidas",
  recuperador = crearRecuperadorPorDefecto()
} = {}) {
  const usuarioDe = (config) => config?.configurable?.usuario_id ?? config?.configurable?.thread_id ?? "usuario-local";

  const buscar_calendario_duoc = tool(
    async ({ query, modalidad }) => JSON.stringify(await recuperador.buscar({ query, modalidad: modalidad ?? "" })),
    {
      name: "buscar_calendario_duoc",
      description:
        "Busca fechas verificadas de los calendarios académicos 2026 de Duoc UC (base/presencial y online) con recuperación " +
        "semántica: entiende sinónimos y lenguaje coloquial ('dejar un ramo' = retiro de asignaturas). " +
        "Devuelve cada actividad con inicio, término, modalidad, fuente y su ESTADO respecto de hoy " +
        "(finalizada / en_curso / por_comenzar) y los días restantes. Úsala para toda pregunta de fechas, " +
        "matrícula, clases, semana cero, inscripción, retiro, suspensión, apelación, exámenes, cierres y feriados.",
      schema: z.object({
        query: z.string().describe("Pregunta completa del estudiante; en seguimientos incluye el tema anterior."),
        modalidad: Modalidad.optional().describe("base/presencial, online, o vacío si no se conoce.")
      })
    }
  );

  const proximos_hitos = tool(
    async ({ modalidad, dias }) => JSON.stringify(proximosHitos({ modalidad: modalidad ?? "", dias: dias ?? 30 })),
    {
      name: "proximos_hitos",
      description:
        "Lista las actividades académicas que comienzan o terminan en los próximos N días (por defecto 30). " +
        "Úsala para '¿qué se viene?', '¿qué plazos tengo cerca?' o recordatorios proactivos.",
      schema: z.object({
        modalidad: Modalidad.optional(),
        dias: z.number().int().min(1).max(365).optional().describe("Ventana en días (1-365).")
      })
    }
  );

  const guardar_preferencias_estudiante = tool(
    async (datos, config) => {
      const perfil = store.guardar(usuarioDe(config), {
        ...datos,
        modalidad: datos.modalidad === "presencial" ? "base" : datos.modalidad
      });
      return JSON.stringify({ guardado: true, perfil });
    },
    {
      name: "guardar_preferencias_estudiante",
      description:
        "Guarda en la memoria de largo plazo datos que el estudiante declara de sí mismo (modalidad, carrera, sede, " +
        "jornada, nombre). Úsala SOLO cuando el estudiante lo diga explícitamente, para no volver a preguntárselo.",
      schema: z.object({
        modalidad: z.enum(["base", "presencial", "online"]).optional(),
        carrera: z.string().optional(),
        sede: z.string().optional(),
        jornada: z.string().optional(),
        nombre: z.string().optional()
      })
    }
  );

  const generar_agenda_personal = tool(
    async ({ consultas, modalidad, formato }, config) => {
      const usuario = usuarioDe(config);
      const hoy = hoyActual();
      const vistos = new Set();
      const items = [];
      for (const q of consultas) {
        for (const r of (await recuperador.buscar({ query: q, modalidad: modalidad ?? "", hoy })).resultados.slice(0, 3)) {
          const k = `${r.modalidad}|${r.actividad}`;
          if (!vistos.has(k) && r.estado !== "finalizada") {
            vistos.add(k);
            items.push(r);
          }
        }
      }
      if (!items.length) return JSON.stringify({ generado: false, motivo: "No hay actividades vigentes para esas consultas." });

      fs.mkdirSync(carpetaSalidas, { recursive: true });
      const base = path.join(carpetaSalidas, `agenda-${usuario}-${toISO(hoy)}`);
      let archivo;
      if (formato === "ics") {
        archivo = `${base}.ics`;
        fs.writeFileSync(archivo, construirICS(items), "utf8");
      } else {
        archivo = `${base}.md`;
        fs.writeFileSync(archivo, construirMD(items, toISO(hoy)), "utf8");
      }
      return JSON.stringify({
        generado: true,
        archivo,
        formato: formato === "ics" ? "ics" : "md",
        actividades: items.map(({ actividad, inicio, termino, modalidad: m, estado }) => ({ actividad, inicio, termino, modalidad: m, estado }))
      });
    },
    {
      name: "generar_agenda_personal",
      description:
        "ESCRIBE un archivo con la agenda personal del estudiante (solo actividades vigentes o futuras) a partir de una " +
        "lista de temas. Formato 'md' (lista legible) o 'ics' (importable en Google Calendar/Outlook).",
      schema: z.object({
        consultas: z.array(z.string()).min(1).max(8).describe("Temas, p. ej. ['retiro de asignaturas', 'exámenes']."),
        modalidad: Modalidad.optional(),
        formato: z.enum(["md", "ics"]).optional()
      })
    }
  );

  return [buscar_calendario_duoc, proximos_hitos, guardar_preferencias_estudiante, generar_agenda_personal];
}

function construirMD(items, hoyISO) {
  const filas = items
    .map((i) => `- **${i.actividad}** (${i.modalidad}): ${i.inicio} → ${i.termino} — _${i.estado.replace("_", " ")}_`)
    .join("\n");
  return `# Mi agenda académica Duoc UC\n\n_Generada el ${hoyISO}. Fuente: calendarios académicos 2026. Proyecto académico, no oficial._\n\n${filas}\n`;
}

function construirICS(items) {
  const dt = (f) => toISO(parseFecha(f)).replaceAll("-", "");
  const fin = (f) => {
    const d = parseFecha(f);
    d.setUTCDate(d.getUTCDate() + 1); // DTEND de eventos de día completo es exclusivo
    return toISO(d).replaceAll("-", "");
  };
  const eventos = items.map(
    (i, n) =>
      `BEGIN:VEVENT\r\nUID:duoc-${n}-${dt(i.inicio)}@asistente-duoc\r\nDTSTAMP:${new Date().toISOString().replace(/[-:]|\.\d{3}/g, "")}\r\n` +
      `DTSTART;VALUE=DATE:${dt(i.inicio)}\r\nDTEND;VALUE=DATE:${fin(i.termino)}\r\nSUMMARY:${i.actividad}\r\n` +
      `DESCRIPTION:Modalidad ${i.modalidad}. Fuente: ${i.fuente}\r\nEND:VEVENT`
  );
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Asistente Academico DUOC//ES\r\n${eventos.join("\r\n")}\r\nEND:VCALENDAR\r\n`;
}
