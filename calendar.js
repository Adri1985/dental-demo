const { google } = require("googleapis");
const path = require("path");
const config = require(path.join(__dirname, "config/consultorio.json"));

// Las credenciales llegan desde el perfil de integración activo. Las env vars
// quedan solo como fallback para cuando todavía no hay ningún perfil cargado.
function resolverCreds(creds = {}) {
  const sa = creds.google_service_account_json || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const calendarId = creds.calendar_id || process.env.CALENDAR_ID_DR_DIEGO;
  if (!sa) throw new Error("No hay Service Account de Google configurada (ni en el perfil activo ni en env)");
  if (!calendarId) throw new Error("No hay Calendar ID configurado (ni en el perfil activo ni en env)");
  return { sa, calendarId };
}

function getAuthClient(sa) {
  const credentials = typeof sa === "string" ? JSON.parse(sa) : sa;
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
}

/**
 * Busca eventos futuros que contengan un teléfono o DNI en la descripción.
 * Usado para reconstruir el perfil del paciente al reiniciar el backend.
 */
async function findPatientByIdentifier(telefono, dni, creds) {
  const { sa, calendarId: CALENDAR_ID } = resolverCreds(creds);
  const auth = getAuthClient(sa);
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
async function getPatientAppointments(telefono, dni, creds) {
  const { sa, calendarId: CALENDAR_ID } = resolverCreds(creds);
  const auth = getAuthClient(sa);
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

// "09:30" → { h: 9, m: 30 }. Devuelve el fallback si el formato no sirve.
function parseHora(txt, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(txt || "").trim());
  if (!m) return fallback;
  const h = parseInt(m[1]), min = parseInt(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return fallback;
  return { h, m: min };
}

/**
 * Busca slots libres en el calendario del Dr. Diego.
 * Usa Date en timezone Argentina via Intl para evitar bugs de offset.
 */
async function checkAvailability({ fecha_desde, fecha_hasta, duracion_minutos, excluir_event_id, horarios, creds }) {
  const { sa, calendarId: CALENDAR_ID } = resolverCreds(creds);
  const auth = getAuthClient(sa);
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
    // Usar en-US para evitar problemas con builds de ICU mínimo en Linux que pueden
    // devolver nombres en inglés incluso con locale es-AR.
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric", month: "2-digit", day: "2-digit",
      weekday: "short",
    });
    const parts = Object.fromEntries(fmt.formatToParts(dt).map(p => [p.type, p.value]));
    return {
      year:  parseInt(parts.year),
      month: parseInt(parts.month) - 1, // 0-indexed
      day:   parseInt(parts.day),
      // en-US siempre devuelve "Sun","Mon","Tue","Wed","Thu","Fri","Sat" (estándar)
      dow:   ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(parts.weekday),
    };
  }

  // Helper: construir un Date UTC a partir de fecha AR (año, mes 0-idx, dia) y hora AR (h, m)
  function arToUTC(year, month0, day, hourAR, minAR) {
    // Argentina es UTC-3 fijo
    return new Date(Date.UTC(year, month0, day, hourAR + 3, minAR, 0, 0));
  }

  const slots = [];
  const ahora = new Date();
  const ahoraAR = ahora.toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour12: false });
  console.log(`[checkAvailability] ahora AR: ${ahoraAR} | duracion: ${duracion_minutos}min | rango: ${desdeDia.toISOString()} → ${hastaDia.toISOString()}`);
  console.log(`[checkAvailability] horarios: mañana ${horarios?.manana_desde||"09:30"}-${horarios?.manana_hasta||"13:00"}, tarde ${horarios?.tarde_desde||"14:00"}-${horarios?.tarde_hasta||"17:00"}`);

  // Iterar cada día del rango
  let cursor = new Date(desdeDia);
  cursor.setUTCHours(12, 0, 0, 0); // mediodía UTC para que en AR sea siempre el mismo día

  const hastaRef = new Date(hastaDia);
  hastaRef.setUTCHours(12, 0, 0, 0);

  while (cursor <= hastaRef) {
    const p = arParts(cursor);
    console.log(`[checkAvailability] día: ${p.year}-${String(p.month+1).padStart(2,'0')}-${String(p.day).padStart(2,'0')} dow=${p.dow}`);

    // Solo lunes (1) a viernes (5)
    if (p.dow >= 1 && p.dow <= 5) {
      // Franjas en hora AR, según la config del panel (fallback a 9:30-13:00 y 14:00-17:00)
      const mIni = parseHora(horarios?.manana_desde, { h: 9,  m: 30 });
      const mFin = parseHora(horarios?.manana_hasta, { h: 13, m: 0  });
      const tIni = parseHora(horarios?.tarde_desde,  { h: 14, m: 0  });
      const tFin = parseHora(horarios?.tarde_hasta,  { h: 17, m: 0  });

      const franjas = [
        { hIni: mIni.h, mIni: mIni.m, hFin: mFin.h, mFin: mFin.m },
        { hIni: tIni.h, mIni: tIni.m, hFin: tFin.h, mFin: tFin.m },
      ].filter(f => (f.hIni * 60 + f.mIni) < (f.hFin * 60 + f.mFin));

      console.log(`[checkAvailability] franjas activas (${franjas.length}): ${franjas.map(f => `${f.hIni}:${String(f.mIni).padStart(2,"0")}-${f.hFin}:${String(f.mFin).padStart(2,"0")} AR`).join(", ")}`);

      for (const franja of franjas) {
        let slotStart = arToUTC(p.year, p.month, p.day, franja.hIni, franja.mIni);
        const franjaFin = arToUTC(p.year, p.month, p.day, franja.hFin, franja.mFin);
        console.log(`[checkAvailability]   franja ${franja.hIni}:${String(franja.mIni).padStart(2,"0")} AR → UTC ${slotStart.toISOString()} | fin UTC ${franjaFin.toISOString()} | ahora UTC ${ahora.toISOString()}`);

        while (slotStart < franjaFin) {
          const slotEnd = new Date(slotStart.getTime() + duracion_minutos * 60 * 1000);

          if (slotEnd > franjaFin) break;
          if (slotStart <= ahora) {
            // slot ya pasó (hora AR pasada), se omite
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
  return slots.slice(0, 12);
}

/**
 * Crea un evento con todos los datos del paciente en la descripción.
 * Esto permite reconstruir el perfil después de un reinicio.
 */
async function createAppointment({ paciente_nombre, paciente_telefono, paciente_dni, paciente_obra_social, fecha_hora, tipo_practica, duracion_minutos, creds }) {
  const { sa, calendarId: CALENDAR_ID } = resolverCreds(creds);
  const auth = getAuthClient(sa);
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
async function cancelAppointment({ event_id, creds }) {
  const { sa, calendarId: CALENDAR_ID } = resolverCreds(creds);
  const auth = getAuthClient(sa);
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
