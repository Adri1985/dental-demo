const { google } = require("googleapis");

const CALENDAR_ID = process.env.CALENDAR_ID_DR_DIEGO;

function getAuthClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
}

/**
 * Busca eventos futuros que contengan un teléfono o DNI en la descripción.
 * Usado para reconstruir el perfil del paciente al reiniciar el backend.
 */
async function findPatientByIdentifier(telefono, dni) {
  const auth = getAuthClient();
  const calendar = google.calendar({ version: "v3", auth });

  const ahora = new Date();
  // Buscar desde hace 1 año para encontrar turnos pasados también
  const desde = new Date(ahora);
  desde.setFullYear(desde.getFullYear() - 1);

  const { data } = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: desde.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 100,
  });

  const eventos = data.items || [];

  for (const ev of eventos) {
    const desc = ev.description || "";
    const matchTel = telefono && desc.includes(`Teléfono: ${telefono}`);
    const matchDni = dni && desc.includes(`DNI: ${dni}`);

    if (matchTel || matchDni) {
      // Extraer datos del paciente de la descripción del evento
      const extraer = (campo) => {
        const match = desc.match(new RegExp(`${campo}: (.+)`));
        return match ? match[1].trim() : null;
      };

      return {
        nombre:      extraer("Paciente"),
        telefono:    extraer("Teléfono"),
        dni:         extraer("DNI"),
        obra_social: extraer("Obra social"),
      };
    }
  }

  return null; // no encontrado
}

/**
 * Busca turnos futuros de un paciente por teléfono o DNI.
 */
async function getPatientAppointments(telefono, dni) {
  const auth = getAuthClient();
  const calendar = google.calendar({ version: "v3", auth });

  const { data } = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: new Date().toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });

  const eventos = data.items || [];

  return eventos.filter((ev) => {
    const desc = ev.description || "";
    const matchTel = telefono && desc.includes(`Teléfono: ${telefono}`);
    const matchDni = dni && desc.includes(`DNI: ${dni}`);
    return matchTel || matchDni;
  }).map((ev) => ({
    event_id: ev.id,
    titulo: ev.summary,
    inicio: ev.start.dateTime,
    label: new Date(ev.start.dateTime).toLocaleString("es-AR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Argentina/Buenos_Aires",
    }),
  }));
}

/**
 * Busca slots libres en el calendario del Dr. Diego.
 * Usa Date en timezone Argentina via Intl para evitar bugs de offset.
 */
async function checkAvailability({ fecha_desde, fecha_hasta, duracion_minutos, excluir_event_id }) {
  const auth = getAuthClient();
  const calendar = google.calendar({ version: "v3", auth });

  // Ampliar rango al mes completo para no perder eventos
  const desdeDia = new Date(fecha_desde);
  desdeDia.setUTCHours(0, 0, 0, 0);
  const hastaDia = new Date(fecha_hasta);
  hastaDia.setUTCHours(23, 59, 59, 999);

  const { data } = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: desdeDia.toISOString(),
    timeMax: hastaDia.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  const eventos = (data.items || []).filter(ev => ev.id !== excluir_event_id);

  console.log(`[checkAvailability] ${eventos.length} eventos en rango:`);
  eventos.forEach(ev => {
    const s = new Date(ev.start.dateTime || ev.start.date);
    const e = new Date(ev.end.dateTime || ev.end.date);
    console.log(`  "${ev.summary}": ${s.toISOString()} → ${e.toISOString()}`);
  });

  // Helper: dado un Date UTC, devuelve {year, month, day, dow} en Argentina
  function arParts(dt) {
    const fmt = new Intl.DateTimeFormat("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric", month: "2-digit", day: "2-digit",
      weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(dt).map(p => [p.type, p.value]));
    return {
      year:  parseInt(parts.year),
      month: parseInt(parts.month) - 1, // 0-indexed
      day:   parseInt(parts.day),
      dow:   ["dom","lun","mar","mié","jue","vie","sáb"].indexOf(parts.weekday.toLowerCase().replace(".",""))
    };
  }

  // Helper: construir un Date UTC a partir de fecha AR (año, mes 0-idx, dia) y hora AR (h, m)
  function arToUTC(year, month0, day, hourAR, minAR) {
    // Argentina es UTC-3 fijo
    return new Date(Date.UTC(year, month0, day, hourAR + 3, minAR, 0, 0));
  }

  const slots = [];
  const ahora = new Date();

  // Iterar cada día del rango
  let cursor = new Date(desdeDia);
  cursor.setUTCHours(12, 0, 0, 0); // mediodía UTC para que en AR sea siempre el mismo día

  const hastaRef = new Date(hastaDia);
  hastaRef.setUTCHours(12, 0, 0, 0);

  while (cursor <= hastaRef) {
    const p = arParts(cursor);
    
    // Solo lunes (1) a viernes (5)
    if (p.dow >= 1 && p.dow <= 5) {
      // Franjas: 9:30-13:00 y 14:00-17:00 en hora AR
      const franjas = [
        { hIni: 9, mIni: 30, hFin: 13, mFin: 0 },
        { hIni: 14, mIni: 0, hFin: 17, mFin: 0 },
      ];

      for (const franja of franjas) {
        let slotStart = arToUTC(p.year, p.month, p.day, franja.hIni, franja.mIni);
        const franjaFin = arToUTC(p.year, p.month, p.day, franja.hFin, franja.mFin);

        while (slotStart < franjaFin) {
          const slotEnd = new Date(slotStart.getTime() + duracion_minutos * 60 * 1000);
          
          if (slotEnd > franjaFin) break;
          if (slotStart <= ahora) {
            slotStart = new Date(slotStart.getTime() + 30 * 60 * 1000);
            continue;
          }

          const hayConflicto = eventos.some(ev => {
            const evS = new Date(ev.start.dateTime || ev.start.date);
            const evE = new Date(ev.end.dateTime   || ev.end.date);
            const overlap = slotStart < evE && slotEnd > evS;
            if (overlap) console.log(`  [bloqueado] ${slotStart.toISOString()} por "${ev.summary}" (${evS.toISOString()}→${evE.toISOString()})`);
            return overlap;
          });

          if (!hayConflicto) {
            slots.push({
              inicio: slotStart.toISOString(),
              label: slotStart.toLocaleString("es-AR", {
                weekday: "long", day: "numeric", month: "long",
                hour: "2-digit", minute: "2-digit",
                timeZone: "America/Argentina/Buenos_Aires",
              }),
            });
          }

          slotStart = new Date(slotStart.getTime() + 30 * 60 * 1000);
        }
      }
    }

    // Avanzar al día siguiente (sumar 24hs exactas)
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }

  console.log(`[checkAvailability] slots libres: ${slots.map(s => s.label).join(", ")}`);
  return slots.slice(0, 6);
}

/**
 * Crea un evento con todos los datos del paciente en la descripción.
 * Esto permite reconstruir el perfil después de un reinicio.
 */
async function createAppointment({ paciente_nombre, paciente_telefono, paciente_dni, paciente_obra_social, fecha_hora, tipo_practica, duracion_minutos }) {
  const auth = getAuthClient();
  const calendar = google.calendar({ version: "v3", auth });

  const start = new Date(fecha_hora);
  const end = new Date(start.getTime() + duracion_minutos * 60000);

  // ── Verificación de conflicto justo antes de crear ──────────────
  // Consulta el calendario en tiempo real para evitar doble turno
  const { data: busyData } = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
  });

  const conflicto = (busyData.items || []).some((ev) => {
    const evStart = new Date(ev.start.dateTime || ev.start.date);
    const evEnd   = new Date(ev.end.dateTime   || ev.end.date);
    return start < evEnd && end > evStart;
  });

  if (conflicto) {
    return {
      ok: false,
      error: "El horario ya fue tomado por otro paciente mientras confirmabas. Buscá otro disponible.",
    };
  }
  // ────────────────────────────────────────────────────────────────

  // Descripción estructurada — los campos se usan para reconstruir el perfil
  const description = [
    `Paciente: ${paciente_nombre || ""}`,
    `Teléfono: ${paciente_telefono || ""}`,
    `DNI: ${paciente_dni || ""}`,
    `Obra social: ${paciente_obra_social || ""}`,
    `Práctica: ${tipo_practica}`,
  ].join("\n");

  const event = {
    summary: `${tipo_practica} — ${paciente_nombre}`,
    description,
    start: { dateTime: start.toISOString(), timeZone: "America/Argentina/Buenos_Aires" },
    end: { dateTime: end.toISOString(), timeZone: "America/Argentina/Buenos_Aires" },
  };

  const { data } = await calendar.events.insert({ calendarId: CALENDAR_ID, resource: event });

  return {
    ok: true,
    event_id: data.id,
    resumen: `Turno confirmado con el Dr. Diego el ${start.toLocaleString("es-AR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Argentina/Buenos_Aires",
    })}`,
  };
}

/**
 * Cancela un evento por ID.
 */
async function cancelAppointment({ event_id }) {
  const auth = getAuthClient();
  const calendar = google.calendar({ version: "v3", auth });
  await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: event_id });
  return { ok: true };
}

module.exports = {
  checkAvailability,
  createAppointment,
  cancelAppointment,
  findPatientByIdentifier,
  getPatientAppointments,
};