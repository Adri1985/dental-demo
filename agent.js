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
    let texto = `- ${p.nombre}: ${p.duracion_min || p.duracion} minutos`;
    if (p.requiere) texto += `\n  → REQUIERE: ${Array.isArray(p.requiere) ? p.requiere.join(", ") : p.requiere}`;
    return texto;
  }).join("\n");
}

function buildKnowledgeBase(cfg = {}, practicas = []) {
  const precio = config.precio_consulta.toLocaleString("es-AR");
  const pol = config.politica;

  // Flujos desde DB o fallback hardcoded
  const flujoNuevo = cfg.flujo_paciente_nuevo ||
    `1. Saludar de forma breve\n2. Pedir: nombre completo, DNI y obra social (de a uno, nunca todos juntos)\n3. Informar el valor de la consulta ($${precio})\n4. Si acepta, buscar disponibilidad y asignar turno\n5. Confirmar el turno con todos los datos`;

  const flujoExistente = cfg.flujo_paciente_existente ||
    `1. Saludar por su nombre (ya lo tenés guardado)\n2. Preguntar qué necesita\n3. Buscar disponibilidad y asignar turno\n4. Confirmar`;

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

VALOR DE CONSULTA:
- Consulta estándar: $${precio} pesos
- Si el paciente pregunta el precio, informá este valor
- Tras informar el valor, preguntar si está de acuerdo para continuar con el turno

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
const getSystemPrompt = (cfg = {}, practicas = []) => {
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
- Al inicio de cada conversación recibís el perfil del paciente en el primer mensaje del sistema.
- Si el paciente ya tiene nombre, DNI y obra social guardados, NO los volvás a pedir.
- Si faltan datos (paciente nuevo), pedís uno por vez, no todos juntos.
- Cuando guardés datos nuevos o actualizados, usá la tool save_patient_data.

REGLAS IMPORTANTES:
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

${buildKnowledgeBase(cfg, practicas)}
`;
};

// ─────────────────────────────────────────────
//  TOOLS
// ─────────────────────────────────────────────
const TOOLS = [
  {
    name: "check_availability",
    description: "Verifica slots disponibles en el calendario. Llamar siempre antes de ofrecer un horario.",
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
