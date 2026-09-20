const USE_DB = !!process.env.DATABASE_URL;
console.log(`[db] modo: ${USE_DB ? "PostgreSQL" : "memoria"}`);

const store = { patients: {}, messages: {}, claudeHistory: {}, config: {} };

let pool = null;
if (USE_DB) {
  const { Pool } = require("pg");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes("render.com") ? { rejectUnauthorized: false } : false,
  });
}

// ─────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────
async function initDB() {
  if (!USE_DB) {
    console.log("[db] corriendo en memoria");
    // Defaults de config en memoria
    store.config = {
      horario_manana_desde: "09:30",
      horario_manana_hasta: "13:00",
      horario_tarde_desde:  "14:00",
      horario_tarde_hasta:  "17:00",
      estilo_conversacion:  "profesional_amigable",
      bot_whatsapp_number:  "15551445115",
    };
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS patients (
      telefono      TEXT PRIMARY KEY,
      nombre        TEXT,
      dni           TEXT,
      obra_social   TEXT,
      modo          TEXT DEFAULT 'bot',
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id            SERIAL PRIMARY KEY,
      telefono      TEXT NOT NULL REFERENCES patients(telefono),
      role          TEXT NOT NULL,
      text          TEXT NOT NULL,
      ts            TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_messages_telefono ON messages(telefono);
    CREATE TABLE IF NOT EXISTS claude_history (
      telefono      TEXT PRIMARY KEY REFERENCES patients(telefono),
      history       JSONB NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS consultorio_config (
      clave      TEXT PRIMARY KEY,
      valor      TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    INSERT INTO consultorio_config (clave, valor) VALUES
      ('horario_manana_desde', '09:30'),
      ('horario_manana_hasta', '13:00'),
      ('horario_tarde_desde',  '14:00'),
      ('horario_tarde_hasta',  '17:00'),
      ('estilo_conversacion',  'profesional_amigable'),
      ('bot_whatsapp_number',  '15551445115')
    ON CONFLICT (clave) DO NOTHING;
  `);
  console.log("[db] tablas listas (PostgreSQL)");
}

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
async function getConfig() {
  if (!USE_DB) return { ...store.config };
  const { rows } = await pool.query("SELECT clave, valor FROM consultorio_config");
  return Object.fromEntries(rows.map(r => [r.clave, r.valor]));
}

async function setConfig(clave, valor) {
  if (!USE_DB) {
    store.config[clave] = valor;
    return;
  }
  await pool.query(
    `INSERT INTO consultorio_config (clave, valor, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`,
    [clave, valor]
  );
}

// ─────────────────────────────────────────────
//  PATIENTS
// ─────────────────────────────────────────────
async function getPatient(telefono) {
  if (!USE_DB) return store.patients[telefono] || null;
  const { rows } = await pool.query("SELECT * FROM patients WHERE telefono = $1", [telefono]);
  return rows[0] || null;
}

async function upsertPatient({ telefono, nombre, dni, obra_social }) {
  if (!USE_DB) {
    const now = new Date().toISOString();
    const existing = store.patients[telefono];
    store.patients[telefono] = {
      telefono,
      nombre:      nombre      || existing?.nombre      || null,
      dni:         dni         || existing?.dni         || null,
      obra_social: obra_social || existing?.obra_social || null,
      modo:        existing?.modo || "bot",
      created_at:  existing?.created_at || now,
      updated_at:  now,
    };
    return store.patients[telefono];
  }
  const { rows } = await pool.query(`
    INSERT INTO patients (telefono, nombre, dni, obra_social)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (telefono) DO UPDATE SET
      nombre      = COALESCE(EXCLUDED.nombre, patients.nombre),
      dni         = COALESCE(EXCLUDED.dni, patients.dni),
      obra_social = COALESCE(EXCLUDED.obra_social, patients.obra_social),
      updated_at  = NOW()
    RETURNING *
  `, [telefono, nombre || null, dni || null, obra_social || null]);
  return rows[0];
}

async function updatePatientData(telefono, { nombre, dni, obra_social }) {
  if (!USE_DB) {
    const p = store.patients[telefono];
    if (!p) return null;
    if (nombre)      p.nombre      = nombre;
    if (dni)         p.dni         = dni;
    if (obra_social) p.obra_social = obra_social;
    p.updated_at = new Date().toISOString();
    return p;
  }
  const { rows } = await pool.query(`
    UPDATE patients SET
      nombre      = COALESCE($1, nombre),
      dni         = COALESCE($2, dni),
      obra_social = COALESCE($3, obra_social),
      updated_at  = NOW()
    WHERE telefono = $4 RETURNING *
  `, [nombre || null, dni || null, obra_social || null, telefono]);
  return rows[0];
}

async function setPatientMode(telefono, modo) {
  if (!USE_DB) {
    if (store.patients[telefono]) { store.patients[telefono].modo = modo; }
    return;
  }
  await pool.query("UPDATE patients SET modo = $1, updated_at = NOW() WHERE telefono = $2", [modo, telefono]);
}

async function getAllPatients() {
  if (!USE_DB) {
    return Object.values(store.patients).map(p => ({
      ...p, total_mensajes: (store.messages[p.telefono] || []).length,
    })).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  }
  const { rows } = await pool.query(`
    SELECT p.*, COUNT(m.id)::int AS total_mensajes
    FROM patients p LEFT JOIN messages m ON m.telefono = p.telefono
    GROUP BY p.telefono ORDER BY p.updated_at DESC
  `);
  return rows;
}

// ─────────────────────────────────────────────
//  MESSAGES
// ─────────────────────────────────────────────
async function addMessage(telefono, role, text, ts) {
  if (!USE_DB) {
    if (!store.messages[telefono]) store.messages[telefono] = [];
    store.messages[telefono].push({ role, text, ts: ts || new Date().toISOString() });
    return;
  }
  await pool.query("INSERT INTO messages (telefono, role, text, ts) VALUES ($1, $2, $3, $4)",
    [telefono, role, text, ts || new Date().toISOString()]);
}

async function getMessages(telefono) {
  if (!USE_DB) return store.messages[telefono] || [];
  const { rows } = await pool.query(
    "SELECT role, text, ts FROM messages WHERE telefono = $1 ORDER BY id ASC", [telefono]);
  return rows;
}

async function clearMessages(telefono) {
  if (!USE_DB) { store.messages[telefono] = []; return; }
  await pool.query("DELETE FROM messages WHERE telefono = $1", [telefono]);
}

// ─────────────────────────────────────────────
//  CLAUDE HISTORY
// ─────────────────────────────────────────────
async function getClaudeHistory(telefono) {
  if (!USE_DB) return store.claudeHistory[telefono] || [];
  const { rows } = await pool.query("SELECT history FROM claude_history WHERE telefono = $1", [telefono]);
  return rows[0]?.history || [];
}

async function saveClaudeHistory(telefono, history) {
  if (!USE_DB) { store.claudeHistory[telefono] = history; return; }
  await pool.query(`
    INSERT INTO claude_history (telefono, history) VALUES ($1, $2)
    ON CONFLICT (telefono) DO UPDATE SET history = EXCLUDED.history
  `, [telefono, JSON.stringify(history)]);
}

async function clearClaudeHistory(telefono) {
  if (!USE_DB) { store.claudeHistory[telefono] = []; return; }
  await pool.query("DELETE FROM claude_history WHERE telefono = $1", [telefono]);
}

module.exports = {
  initDB, getConfig, setConfig,
  getPatient, upsertPatient, updatePatientData, setPatientMode, getAllPatients,
  addMessage, getMessages, clearMessages,
  getClaudeHistory, saveClaudeHistory, clearClaudeHistory,
};
