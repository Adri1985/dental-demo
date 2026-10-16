const path = require("path");
const config = require(path.join(__dirname, "config/consultorio.json"));

function buildProfesionalesEnum() {
  return config.profesionales.map(p => p.id);
}

function buildHorariosText(cfg = {}) {
  const p = config.profesionales[0];
  const h = p.horarios;
  const mananaDesde = cfg.horario_manana_desde || h.manana.desde;
  const mananaHasta = cfg.horario_manana_hasta || h.manana.hasta;
  const tardeDesde  = cfg.horario_tarde_desde  || h.tarde.desde;
  const tardeHasta  = cfg.horario_tarde_hasta  || h.tarde.hasta;
  return `- ${p.nombre}: ${h.dias} de ${mananaDesde} a ${mananaHasta} y ${tardeDesde} a ${tardeHasta} (último turno a las ${tardeHasta})`;
}

function buildPracticasText(practicas) {
  const lista = practicas && practicas.length > 0 ? practicas : config.practicas;
  return lista.map(p => {
    const precio = parseInt(p.precio) || 50;
    let texto = `- ${p.nombre}: ${p.duracion_min || p.duracion} min, $${precio.toLocaleString("es-AR")}`;
    if (p.requiere) texto += `\n  → REQUIERE: ${Array.isArray(p.requiere) ? p.requiere.join(", ") : p.requiere}`;
    return texto;
  }).join("\n");
}

// El panel manda un booleano real, pero toleramos string/number por las dudas
function esVerdadero(v) {
  return v === true || v === 1 || v === "true" || v === "t" || v === "1";
}

function buildCoberturasText(coberturas) {
  if (!coberturas || coberturas.length === 0) {
    return "- No hay convenios cargados. Todos los pacientes abonan el valor estándar de cada práctica.";
  }
  return coberturas.map(c => {
    const pct = parseInt(c.descuento_pct) || 0;
    if (pct <= 0) return `- ${c.obra_social}: sin descuento, abona el precio estándar de cada práctica`;
    const alcance = esVerdadero(c.primera_consulta_only)
      ? "SOLO en la primera consulta (si ya es paciente del consultorio, abona el valor estándar)"
      : "SIEMPRE, en todas sus consultas (da igual si es paciente nuevo o ya viene hace años)";
    return `- ${c.obra_social}: ${pct}% de descuento sobre el precio de la práctica — aplica ${alcance}`;
  }).join("\n");
}

function buildKnowledgeBase(cfg = {}, practicas = [], coberturas = []) {
  const pol = config.politica;

  // Flujos desde DB o fallback hardcoded
  const flujoNuevo = cfg.flujo_paciente_nuevo ||
    `1. Saludar de forma breve\n2. Pedir: nombre completo, DNI y obra social (de a uno, nunca todos juntos)\n3. Informar el valor de la práctica que necesita\n4. Si acepta, buscar disponibilidad y asignar turno\n5. Confirmar el turno con todos los datos`;

  const flujoExistente = cfg.flujo_paciente_existente ||
    `1. Saludar por su nombre (ya lo tenés guardado)\n2. Preguntar qué necesita\n3. Llamar check_availability para buscar slots libres y ofrecerle opciones\n4. Confirmar el turno elegido con create_appointment`;

  // Política desde DB o fallback
  const cancelacionHs   = cfg.cancelacion_anticipacion_hs || pol.cancelacion_anticipacion_hs;
  const toleranciaMin   = cfg.tolerancia_llegada_min      || pol.tolerancia_llegada_tarde_min;
  const anticipacionMin = cfg.anticipacion_nuevo_min      || pol.anticipacion_llegada_nuevo_min;

  // Palabras de alarma desde DB o fallback
  const palabrasAlarma = cfg.palabras_alarma || config.palabras_alarma.join(", ");

  // Mensaje de bienvenida opcional
  const bienvenida = cfg.mensaje_bienvenida
    ? `\nCONTEXTO DE BIENVENIDA PARA PACIENTES NUEVOS:\n${cfg.mensaje_bienvenida}\n`
    : "";

  return `
CONSULTORIO:
- Nombre: ${config.consultorio.nombre}
${config.consultorio.direccion ? `- Dirección: ${config.consultorio.direccion}` : ""}
${bienvenida}
PROFESIONALES Y HORARIOS:
${buildHorariosText(cfg)}

DESCUENTOS POR OBRA SOCIAL:
${buildCoberturasText(coberturas)}

CÓMO APLICAR LOS DESCUENTOS — MUY IMPORTANTE:
- Cada práctica tiene su propio precio (lo ves en la sección PRÁCTICAS). Ese es el valor estándar (sin descuento).
- Si el paciente tiene una obra social con convenio, calculá el precio final aplicando el porcentaje de descuento al precio de la práctica que va a hacer.
- Informale directamente el monto final ya calculado. No le muestres la cuenta ni el porcentaje, decile el número que tiene que pagar.
- Si el paciente pregunta el precio y todavía no sabés su obra social, preguntale cuál tiene antes de darle un valor.
- Si su obra social NO figura en la lista de arriba, abona el valor estándar de la práctica. Nunca inventes descuentos ni prometas convenios que no estén en la lista.
- Cada convenio aclara su alcance y tenés que respetarlo tal cual: los que dicen "aplica SIEMPRE" valen en todas las consultas del paciente, sea nuevo o ya existente, y NUNCA los presentes como limitados a la primera consulta. Los que dicen "aplica SOLO en la primera consulta" valen únicamente si el paciente es nuevo.
- No agregues condiciones, plazos ni límites que el convenio no diga.
- Nunca negocies el precio ni ofrezcas descuentos adicionales por tu cuenta.

PRÁCTICAS DISPONIBLES Y SUS DURACIONES:
${buildPracticasText(practicas)}

IMPORTANTE — PRÁCTICAS ESTRICTAS:
- Solo podés ofrecer o mencionar las prácticas de la lista de arriba. NUNCA inventes ni sugieras prácticas que no estén en esa lista.
- Si el paciente menciona algo que no coincide con ninguna práctica, respondé: "Para eso tendrías que consultar directamente con el doctor. Lo que puedo agendarte es una consulta general de 30 minutos, te sirve?"
- Si la lista está vacía, ofrecé solo "Consulta" de 30 minutos.

FLUJO PARA PACIENTE NUEVO:
${flujoNuevo}

FLUJO PARA PACIENTE EXISTENTE:
${flujoExistente}

POLÍTICA DE TURNOS:
- Cancelaciones: avisar con al menos ${cancelacionHs} horas de anticipación
- Llegada tarde: se respeta el turno hasta ${toleranciaMin} minutos de demora
- Pacientes nuevos: llegar ${anticipacionMin} minutos antes para completar la ficha

PALABRAS DE ALARMA — escalar SIEMPRE de forma inmediata:
${palabrasAlarma}
`;
}

// ─────────────────────────────────────────────
//  ESTILOS DE CONVERSACIÓN
// ─────────────────────────────────────────────
const ESTILOS = {
  cercano: `Hablás de manera muy informal y cercana, como un amigo de confianza. Usás el voseo rioplatense con muletillas frecuentes: "dale", "re bien", "genial". Frases cortas, tono de chat entre amigos.`,
  amigable: `Hablás de manera informal pero prolija, como una secretaria simpática. Usás el voseo rioplatense. Sos cálida pero sin excesos.`,
  profesional_amigable: `Hablás de manera profesional pero cálida. Usás el voseo pero con moderación. No usás "che" ni muletillas informales. Sos cordial, clara y directa.`,
  formal: `Hablás de manera formal, usando "usted" para dirigirte al paciente. Oraciones completas, tono de atención médica profesional.`,
  muy_formal: `Hablás con lenguaje clínico y muy formal, usando "usted" siempre. Respuestas estructuradas y precisas. Sin nada informal.`,
};

// ─────────────────────────────────────────────
//  SYSTEM PROMPT
// ─────────────────────────────────────────────
const getSystemPrompt = (cfg = {}, practicas = [], coberturas = [], perfilPaciente = "") => {
  const ahora = new Date().toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    weekday: "long", year: "numeric", month: "long",
    day: "numeric", hour: "2-digit", minute: "2-digit",
  });

  const profesional = config.profesionales[0].nombre;
  const asistente   = config.asistente.nombre;
  const estiloKey   = cfg.estilo_conversacion || "profesional_amigable";
  const estilo      = ESTILOS[estiloKey] || ESTILOS.profesional_amigable;

  return `
La fecha y hora actual en Argentina es: ${ahora}.
Usá siempre esta fecha como referencia para buscar turnos. Nunca uses fechas de 2024 o 2025.

Sos ${asistente}, la asistente del consultorio de ${profesional}.
${estilo}

Escribís mensajes cortos, nunca parrafotes largos.
No usás listas con guiones ni bullets. Escribís en texto plano, como en una conversación real.

ESTILO DE ESCRITURA — MUY IMPORTANTE:
- NUNCA uses emojis. Ni uno solo.
- NUNCA abras signos de puntuación: escribís "Hola, cómo andás?" no "¡Hola, cómo andás!". Solo cerrás.
- No uses negritas (**texto**) ni ningún formato markdown.
- Escribís como si fuera un mensaje de WhatsApp real de una persona, no de un asistente.
- Nada de frases grandilocuentes como "Por supuesto!", "Claro que sí!", "Encantada de ayudarte!".
- Respuestas cortas. Si podés decirlo en una oración, no uses dos.

CÓMO USÁS LOS DATOS DEL PACIENTE:
- El perfil del paciente está al final de este prompt y se recalcula en CADA mensaje: refleja siempre el estado actual, no el del inicio de la conversación.
- Si el paciente ya tiene nombre, DNI y obra social guardados, NO los volvás a pedir.
- Si faltan datos (paciente nuevo), pedís uno por vez, no todos juntos.
- Cuando guardés datos nuevos o actualizados, usá la tool save_patient_data.

REGLAS IMPORTANTES:
- Ante cualquier pregunta sobre disponibilidad de turnos — "¿hay turno hoy?", "¿tenés lugar esta tarde?", "¿cuándo me podés atender?", "¿tiene horario libre?" — llamá INMEDIATAMENTE a check_availability. NUNCA respondas si hay o no hay turnos sin haberlo verificado antes con esa tool. Esto aplica AUNQUE creas que ya pasó el horario del día: igual llamás al tool para encontrar la próxima disponibilidad.
- Cuando busques turnos, usá siempre un rango amplio: desde hoy hasta 7 días adelante. Así si hoy no hay lugar, encontrás el próximo día disponible y se lo ofrecés al paciente sin que tenga que preguntar de nuevo.
- Nunca ofrezcas un horario sin antes verificar disponibilidad con check_availability.
- Al llamar a check_availability y create_appointment, usá la duración exacta de la práctica según la lista. Si no coincide con ninguna, usá 30 minutos.
- Ante cualquier palabra de alarma, usá flag_critical_issue de inmediato. No agendes ni des consejos.
- Si no podés resolver algo, ofrecé derivar al profesional.
- Jamás hagas diagnósticos ni des indicaciones médicas.
- Si una práctica requiere estudios previos, avisalo antes de confirmar el turno.

REGLAS DE REAGENDAMIENTO — MUY IMPORTANTE:
- Cuando el paciente quiere cambiar un turno, el orden OBLIGATORIO es:
  1. Buscar disponibilidad con check_availability
  2. Ofrecerle opciones al paciente
  3. Esperar que el paciente CONFIRME el nuevo horario
  4. Crear el nuevo turno con create_appointment
  5. Solo si create_appointment devuelve ok=true, cancelar el turno anterior con cancel_appointment
  6. NUNCA cancelar antes de que el nuevo turno esté confirmado y creado exitosamente
- Si create_appointment falla, NO cancelar el turno original. Avisar al paciente y ofrecer otro horario.

${buildKnowledgeBase(cfg, practicas, coberturas)}
${perfilPaciente ? `\n${perfilPaciente}` : ""}
`;
};

// ─────────────────────────────────────────────
//  TOOLS
// ─────────────────────────────────────────────
const TOOLS = [
  {
    name: "check_availability",
    description: "Verifica slots libres en el calendario. Llamar SIEMPRE que el paciente pregunte por turnos, incluso si creés que el horario ya pasó. Usar rango de 7 días (hoy + 7) para encontrar la próxima disponibilidad.",
    input_schema: {
      type: "object",
      properties: {
        profesional_id:   { type: "string", enum: buildProfesionalesEnum() },
        fecha_desde:      { type: "string", description: "ISO 8601 con timezone" },
        fecha_hasta:      { type: "string", description: "ISO 8601 con timezone" },
        duracion_minutos: { type: "number" },
        excluir_event_id: { type: "string" },
      },
      required: ["fecha_desde", "fecha_hasta", "duracion_minutos"],
    },
  },
  {
    name: "create_appointment",
    description: "Crea un turno en el calendario. Solo llamar cuando el paciente confirmó el horario.",
    input_schema: {
      type: "object",
      properties: {
        profesional_id:       { type: "string", enum: buildProfesionalesEnum() },
        paciente_nombre:      { type: "string" },
        paciente_telefono:    { type: "string" },
        paciente_dni:         { type: "string" },
        paciente_obra_social: { type: "string" },
        fecha_hora:           { type: "string", description: "ISO 8601 con timezone" },
        tipo_practica:        { type: "string" },
        duracion_minutos:     { type: "number" },
      },
      required: ["paciente_nombre", "paciente_telefono", "fecha_hora", "tipo_practica", "duracion_minutos"],
    },
  },
  {
    name: "cancel_appointment",
    description: "Cancela un turno existente.",
    input_schema: { type: "object", properties: { event_id: { type: "string" } }, required: ["event_id"] },
  },
  {
    name: "get_patient_appointments",
    description: "Consulta los turnos futuros del paciente.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "save_patient_data",
    description: "Guarda o actualiza datos del paciente.",
    input_schema: {
      type: "object",
      properties: {
        nombre:      { type: "string" },
        dni:         { type: "string" },
        obra_social: { type: "string" },
      },
    },
  },
  {
    name: "flag_critical_issue",
    description: "Alerta urgente al profesional. Usar INMEDIATAMENTE ante palabras de alarma.",
    input_schema: {
      type: "object",
      properties: {
        paciente_nombre:   { type: "string" },
        paciente_telefono: { type: "string" },
        descripcion:       { type: "string" },
      },
      required: ["descripcion"],
    },
  },
];

module.exports = { getSystemPrompt, TOOLS, config, ESTILOS };
