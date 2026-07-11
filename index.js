require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const {
  checkAvailability,
  createAppointment,
  cancelAppointment,
  findPatientByIdentifier,
  getPatientAppointments,
} = require("./calendar");
const { getSystemPrompt, TOOLS, config } = require("./agent");
const db = require("./db");

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────
//  CONTEXTO DEL PACIENTE PARA CLAUDE
// ─────────────────────────────────────────────
function buildPatientContext(patient) {
  const { nombre, dni, obra_social, telefono } = patient;
  const completo = nombre && dni && obra_social;

  if (completo) {
    return `[DATOS DEL PACIENTE]
Nombre: ${nombre}
DNI: ${dni}
Obra social: ${obra_social}
Teléfono: ${telefono}
Estado: paciente existente — NO pedir estos datos nuevamente.`;
  }

  return `[DATOS DEL PACIENTE]
Nombre: ${nombre || "desconocido"}
DNI: ${dni || "pendiente"}
Obra social: ${obra_social || "pendiente"}
Teléfono: ${telefono}
Estado: paciente nuevo — faltan datos. Pedirlos de a uno durante la conversación.`;
}

// ─────────────────────────────────────────────
//  EJECUTOR DE TOOLS
// ─────────────────────────────────────────────
async function executeTool(name, input, telefono) {
  console.log(`[tool] ${name}`, JSON.stringify(input, null, 2));
  const patient = await db.getPatient(telefono);

  switch (name) {
    case "check_availability": {
      const slots = await checkAvailability(input);
      if (slots.length === 0) {
        return { disponible: false, mensaje: "No encontré turnos libres en ese período." };
      }
      return { disponible: true, slots };
    }

    case "create_appointment": {
      const inputEnriquecido = {
        ...input,
        paciente_dni:         input.paciente_dni        || patient?.dni,
        paciente_obra_social: input.paciente_obra_social || patient?.obra_social,
        paciente_nombre:      input.paciente_nombre      || patient?.nombre,
        paciente_telefono:    input.paciente_telefono    || telefono,
      };
      return await createAppointment(inputEnriquecido);
    }

    case "cancel_appointment": {
      return await cancelAppointment(input);
    }

    case "get_patient_appointments": {
      const turnos = await getPatientAppointments(telefono, patient?.dni);
      return { turnos };
    }

    case "save_patient_data": {
      const updated = await db.updatePatientData(telefono, {
        nombre:      input.nombre      || null,
        dni:         input.dni         || null,
        obra_social: input.obra_social || null,
      });
      console.log(`[paciente actualizado]`, updated);
      return { ok: true, guardado: updated };
    }

    case "flag_critical_issue": {
      console.error("🚨 URGENCIA DENTAL 🚨");
      console.error("Paciente:", input.paciente_nombre || patient?.nombre || "Desconocido");
      console.error("Teléfono:", telefono);
      console.error("Descripción:", input.descripcion);
      // TODO: notificar al doctor por WhatsApp
      return {
        ok: true,
        accion: `Alerta enviada al ${config.profesionales[0].nombre}. El paciente será contactado a la brevedad.`,
      };
    }

    default:
      return { error: `Tool desconocida: ${name}` };
  }
}

// ─────────────────────────────────────────────
//  DELAY HUMANO
// ─────────────────────────────────────────────
function humanDelay(text) {
  const palabras = text.split(" ").length;
  const ms = Math.min(1200 + palabras * 60, 3500);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────
//  LOOP PRINCIPAL DEL AGENTE
// ─────────────────────────────────────────────
async function runAgent(userMessage, telefono) {
  const patient = await db.getPatient(telefono);
  let claudeHistory = await db.getClaudeHistory(telefono);

  // Inyectar contexto del paciente al inicio de sesión
  if (claudeHistory.length === 0) {
    claudeHistory.push({ role: "user", content: buildPatientContext(patient) });
    claudeHistory.push({ role: "assistant", content: "Entendido, tengo los datos del paciente." });
  }

  claudeHistory.push({ role: "user", content: userMessage });

  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: getSystemPrompt(),
    tools: TOOLS,
    messages: claudeHistory,
  });

  while (response.stop_reason === "tool_use") {
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        const result = await executeTool(block.name, block.input, telefono);
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        };
      })
    );

    claudeHistory.push({ role: "assistant", content: response.content });
    claudeHistory.push({ role: "user", content: toolResults });

    response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: getSystemPrompt(),
      tools: TOOLS,
      messages: claudeHistory,
    });
  }

  const finalText = response.content.find((b) => b.type === "text")?.text || "No pude procesar eso.";
  claudeHistory.push({ role: "assistant", content: response.content });

  await db.saveClaudeHistory(telefono, claudeHistory);

  return finalText;
}

// ─────────────────────────────────────────────
//  ENDPOINTS
// ─────────────────────────────────────────────

// GET /session/:telefono
app.get("/session/:telefono", async (req, res) => {
  const { telefono } = req.params;

  // 1. Buscar en DB
  const patient = await db.getPatient(telefono);
  if (patient) {
    const displayHistory = await db.getMessages(telefono);
    return res.json({
      existe: true,
      nombre: patient.nombre,
      dni: patient.dni,
      obra_social: patient.obra_social,
      displayHistory,
      fuente: "db",
    });
  }

  // 2. Buscar en Google Calendar
  try {
    const encontrado = await findPatientByIdentifier(telefono, null);
    if (encontrado) {
      console.log(`[calendar lookup] paciente encontrado: ${telefono}`, encontrado);
      return res.json({
        existe: true,
        nombre: encontrado.nombre,
        dni: encontrado.dni,
        obra_social: encontrado.obra_social,
        displayHistory: [],
        fuente: "calendar",
      });
    }
  } catch (err) {
    console.error("[calendar lookup error]", err.message);
  }

  res.json({ existe: false });
});

// POST /session — crear o retomar sesión
app.post("/session", async (req, res) => {
  const { telefono, nombre } = req.body;
  if (!telefono) return res.status(400).json({ error: "Falta el teléfono" });

  // Ya existe en DB
  let patient = await db.getPatient(telefono);
  if (patient) {
    if (nombre && nombre !== patient.nombre) {
      await db.updatePatientData(telefono, { nombre });
      patient = await db.getPatient(telefono);
    }
    const displayHistory = await db.getMessages(telefono);
    return res.json({
      nueva: false,
      nombre: patient.nombre,
      dni: patient.dni,
      obra_social: patient.obra_social,
      displayHistory,
    });
  }

  // Buscar en Google Calendar
  let datosPrevios = null;
  try {
    datosPrevios = await findPatientByIdentifier(telefono, null);
    if (datosPrevios) console.log(`[sesión recuperada desde calendar] ${telefono}`, datosPrevios);
  } catch (err) {
    console.error("[calendar lookup error]", err.message);
  }

  // Crear en DB
  patient = await db.upsertPatient({
    telefono,
    nombre: datosPrevios?.nombre || nombre || "Paciente",
    dni: datosPrevios?.dni || null,
    obra_social: datosPrevios?.obra_social || null,
  });

  res.json({
    nueva: !datosPrevios,
    recuperado: !!datosPrevios,
    nombre: patient.nombre,
    dni: patient.dni,
    obra_social: patient.obra_social,
    displayHistory: [],
  });
});

// POST /chat
app.post("/chat", async (req, res) => {
  const { mensaje, telefono } = req.body;
  if (!mensaje || !telefono) return res.status(400).json({ error: "Faltan campos: mensaje y telefono" });

  const patient = await db.getPatient(telefono);
  if (!patient) return res.status(404).json({ error: "Sesión no encontrada. Llamá a POST /session primero." });

  const ahora = new Date().toISOString();
  await db.addMessage(telefono, "user", mensaje, ahora);

  // Si la conversación está pausada, no responder
  if (patient.modo === "humano") {
    return res.json({ reply: null, pausado: true });
  }

  try {
    const reply = await runAgent(mensaje, telefono);
    await humanDelay(reply);

    const tsReply = new Date().toISOString();
    await db.addMessage(telefono, "assistant", reply, tsReply);

    res.json({ reply, ts: tsReply });
  } catch (err) {
    console.error("[error]", err);
    res.status(500).json({ error: "Error interno del agente" });
  }
});

// DELETE /session/:telefono — borrar historial, mantener datos del paciente
app.delete("/session/:telefono", async (req, res) => {
  const { telefono } = req.params;
  await db.clearMessages(telefono);
  await db.clearClaudeHistory(telefono);
  res.json({ ok: true });
});

// GET /patients — todos los pacientes (para panel admin)
app.get("/patients", async (req, res) => {
  res.json(await db.getAllPatients());
});

// GET /patients/:telefono/messages — mensajes de un paciente (para panel admin)
app.get("/patients/:telefono/messages", async (req, res) => {
  res.json(await db.getMessages(req.params.telefono));
});

// POST /admin/pause/:telefono — pausar bot para una conversación
app.post("/admin/pause/:telefono", async (req, res) => {
  await db.setPatientMode(req.params.telefono, "humano");
  res.json({ ok: true });
});

// POST /admin/resume/:telefono — reanudar bot
app.post("/admin/resume/:telefono", async (req, res) => {
  await db.setPatientMode(req.params.telefono, "bot");
  // Limpiar historial de Claude para que arranque fresco
  await db.clearClaudeHistory(req.params.telefono);
  res.json({ ok: true });
});

// Health check
app.get("/health", (_, res) => res.json({ status: "ok" }));

// ─────────────────────────────────────────────
//  ARRANQUE — primero init DB, luego servidor
// ─────────────────────────────────────────────
db.initDB()
  .then(() => {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Backend corriendo en http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error("[db] Error al inicializar:", err);
    process.exit(1);
  });