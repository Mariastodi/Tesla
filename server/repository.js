import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { rootDir, dataDir, runtimeFile, production } from "./config.js";
import { teachersFromClasses, connectClassesToTeachers } from "./domain.js";

export function databaseErrorCode(error) {
  const code = String(error?.code || "");
  if (["28P01", "28000"].includes(code)) return "DB_AUTHENTICATION_FAILED";
  if (code === "3D000") return "DB_DATABASE_NOT_FOUND";
  if (code === "42P01") return "DB_TABLE_NOT_FOUND";
  if (code === "42703") return "DB_SCHEMA_MISMATCH";
  if (code === "42501") return "DB_PERMISSION_DENIED";
  if (
    [
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "EHOSTUNREACH",
      "57P03",
    ].includes(code)
  )
    return "DB_CONNECTION_FAILED";
  if (
    [
      "SELF_SIGNED_CERT_IN_CHAIN",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "CERT_HAS_EXPIRED",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ].includes(code)
  )
    return "DB_TLS_CERTIFICATE_FAILED";
  if (code === "53300") return "DB_CONNECTION_LIMIT";
  if (code === "53000") return "DB_RESOURCE_LIMIT";
  if (code === "XX000") return "DB_PROVIDER_INTERNAL_ERROR";
  if (code === "DATABASE_URL_INVALID") return "DB_URL_INVALID";
  if (code === "DATABASE_URL_MISSING") return "DB_URL_MISSING";
  if (code === "PRODUCTION_SECRETS_MISSING")
    return "PRODUCTION_SECRETS_MISSING";
  return "INTERNAL_ERROR";
}

export function databaseErrorDiagnostic(error) {
  if (String(error?.code || "") !== "XX000") return undefined;
  return String(error?.message || "")
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+):[^@\s]+@/gi, "$1:[redacted]@")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
}

function databaseConnectionString() {
  const value = process.env.DATABASE_URL;
  if (!value) return null;
  const invalidUrl = () => {
    console.error("Invalid PostgreSQL DATABASE_URL", {
      category: "DB_URL_INVALID",
    });
    return Object.assign(new Error("Invalid DATABASE_URL"), {
      code: "DATABASE_URL_INVALID",
    });
  };
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalidUrl();
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname)
    throw invalidUrl();
  // Apply TLS in pg's Pool options below. Remove sslmode from the URI because
  // pg-connection-string can otherwise replace the explicit SSL object with
  // its own defaults, which may reject Supabase's presented certificate chain.
  url.searchParams.delete("sslmode");
  return url.toString();
}

const connectionString = databaseConnectionString();
export const pool = connectionString
  ? new pg.Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      // A Vercel instance is short lived; keep its own pool small because
      // Supabase already pools serverless connections at the transaction layer.
      max: 1,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 10000,
      keepAlive: true,
    })
  : null;
pool?.on("error", (error) => {
  console.error("PostgreSQL idle connection error", {
    category: databaseErrorCode(error),
    code: error?.code || "UNKNOWN",
  });
});
export const transaction = new AsyncLocalStorage();
const database = () => transaction.getStore() || pool;
function jsonObject(value, fallback = null) {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return fallback;
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : fallback;
}
function jsonRecords(result, includeId = false) {
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  return rows
    .map((row) => {
      const record = jsonObject(row?.data);
      if (!record) return null;
      return includeId && record.id == null && row.id != null
        ? { ...record, id: row.id }
        : record;
    })
    .filter(Boolean);
}
function normalizeStore(store = {}) {
  const config = jsonObject(store.config, {});
  const turmas = Array.isArray(store.turmas)
    ? store.turmas.map((item) => jsonObject(item)).filter(Boolean)
    : [];
  let professores = Array.isArray(store.professores)
    ? store.professores.map((item) => jsonObject(item)).filter(Boolean)
    : [];
  if (!professores.length) professores = teachersFromClasses(turmas);
  const workflow = normalizeWorkflow(jsonObject(store, {}));
  return {
    ...workflow,
    config,
    turmas: connectClassesToTeachers(turmas, professores),
    professores,
    alunos: Array.isArray(store.alunos)
      ? store.alunos.map((item) => jsonObject(item)).filter(Boolean)
      : [],
    checkins: Array.isArray(store.checkins)
      ? store.checkins.map((item) => jsonObject(item)).filter(Boolean)
      : [],
  };
}
async function readSeed() {
  if (production)
    return {
      config: {
        escola: "Instituto Tecnológico Tesla",
        minimo: 75,
        tolAntes: 30,
        tolDepois: 60,
      },
      turmas: [],
      professores: [],
      alunos: [],
      checkins: [],
    };
  const [config, classes, students] = await Promise.all([
    fs
      .readFile(path.join(dataDir, "config.json"), "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === "ENOENT")
          return {
            escola: "Instituto Tecnológico Tesla",
            minimo: 75,
            tolAntes: 30,
            tolDepois: 60,
          };
        throw error;
      }),
    fs
      .readFile(path.join(dataDir, "turmas.json"), "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === "ENOENT") return {};
        throw error;
      }),
    fs
      .readFile(path.join(dataDir, "alunos.json"), "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === "ENOENT") return {};
        throw error;
      }),
  ]);
  const rawClasses = Object.entries(classes).map(([id, value]) => ({
    id,
    ...value,
  }));
  const professores = teachersFromClasses(rawClasses);
  return {
    config: { ...config, pin: "" },
    turmas: connectClassesToTeachers(rawClasses, professores),
    professores,
    alunos: Object.entries(students).map(([id, value]) => ({ id, ...value })),
    checkins: [],
  };
}

async function readFileStore() {
  try {
    const store = JSON.parse(await fs.readFile(runtimeFile, "utf8"));
    if (!store.professores)
      store.professores = teachersFromClasses(store.turmas);
    store.turmas = connectClassesToTeachers(store.turmas, store.professores);
    return normalizeWorkflow(store);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const seed = normalizeWorkflow(await readSeed());
    await writeFileStore(seed);
    return seed;
  }
}
async function writeFileStore(store) {
  await fs.mkdir(dataDir, { recursive: true });
  const temporary = `${runtimeFile}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(store, null, 2), {
    mode: 0o600,
  });
  await fs.rename(temporary, runtimeFile);
  return store;
}

const defaultTeacherWorkflow = {
  teacherAttendance: [],
  teacherSubstitutions: [],
  sheetSync: { revision: 0, syncedRevision: -1 },
};

async function setupPostgres() {
  const migrationDir = path.join(rootDir, "server/migrations");
  const migrations = (await fs.readdir(migrationDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrations) {
    const migration = await fs.readFile(path.join(migrationDir, name), "utf8");
    await pool.query(migration);
  }
  const seed = await readSeed();
  const hasConfig = await pool.query(
    "SELECT 1 FROM app_config WHERE id = 1",
  );
  await pool.query(
    "INSERT INTO app_config (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data || app_config.data",
    [seed.config],
  );
  if (hasConfig.rowCount === 0) {
    for (const item of seed.turmas)
      await pool.query(
        "INSERT INTO classes (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
        [item.id, item],
      );
    for (const item of seed.professores)
      await pool.query(
        "INSERT INTO teachers (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
        [item.id, item],
      );
    for (const item of seed.alunos)
      await pool.query(
        "INSERT INTO students (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
        [item.id, item],
      );
  }
  await pool.query(
    "INSERT INTO teacher_workflow (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data || teacher_workflow.data",
    [defaultTeacherWorkflow],
  );
}
export async function readStore() {
  if (!pool) return normalizeStore(await readFileStore());
  await repositoryReady;
  const [config, classes, teachers, students, checkins, workflow] =
    await Promise.all([
      database().query("SELECT data FROM app_config WHERE id = 1"),
      database().query("SELECT id, data FROM classes"),
      database().query("SELECT id, data FROM teachers"),
      database().query("SELECT id, data FROM students"),
      database().query("SELECT data FROM checkins ORDER BY created_at DESC"),
      database().query("SELECT data FROM teacher_workflow WHERE id = 1"),
    ]);
  const rawClasses = jsonRecords(classes, true);
  const storedTeachers = jsonRecords(teachers, true);
  const professores = storedTeachers.length
    ? storedTeachers
    : teachersFromClasses(rawClasses);
  const defaults = await readSeed();
  return normalizeStore({
    ...jsonObject(workflow?.rows?.[0]?.data, defaultTeacherWorkflow),
    config: {
      ...jsonObject(defaults.config, {}),
      ...jsonObject(config?.rows?.[0]?.data, {}),
    },
    turmas: connectClassesToTeachers(rawClasses, professores),
    professores,
    alunos: jsonRecords(students, true),
    checkins: jsonRecords(checkins),
  });
}
export async function writeStore(store) {
  normalizeWorkflow(store);
  store.sheetSync.revision += 1;
  if (!pool) return writeFileStore(store);
  const client = database();
  try {
    await client.query("UPDATE app_config SET data = $1 WHERE id = 1", [
      store.config,
    ]);
    await client.query("DELETE FROM classes WHERE NOT (id = ANY($1::text[]))", [
      store.turmas.map((item) => item.id),
    ]);
    for (const item of store.turmas)
      await client.query(
        "INSERT INTO classes (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
        [item.id, item],
      );
    for (const item of store.professores || [])
      await client.query(
        "INSERT INTO teachers (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
        [item.id, item],
      );
    for (const item of store.alunos)
      await client.query(
        "INSERT INTO students (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
        [item.id, item],
      );
    await saveWorkflow(store);
    return store;
  } catch (error) {
    throw error;
  }
}
export async function deleteTeacherRecord(id) {
  if (pool)
    await database().query("DELETE FROM teachers WHERE id = $1", [id]);
}
export async function deleteStudentRecord(id) {
  if (pool)
    await database().query("DELETE FROM students WHERE id = $1", [id]);
}
export async function addCheckin(store, checkin) {
  if (store.checkins.some((item) => item.id === checkin.id))
    return {
      created: false,
      checkin: store.checkins.find((item) => item.id === checkin.id),
    };
  store.checkins.unshift(checkin);
  if (pool)
    await database().query("INSERT INTO checkins (id, data) VALUES ($1, $2)", [
      checkin.id,
      checkin,
    ]);
  else await writeFileStore(store);
  return { created: true, checkin };
}

export const repositoryReady = pool ? setupPostgres() : Promise.resolve();
// The rejected promise remains awaitable by requests; this handler also avoids
// an unhandled-rejection warning before the first request observes it.
repositoryReady.catch(() => {});

function normalizeWorkflow(store) {
  store.teacherAttendance ||= [];
  store.teacherSubstitutions ||= [];
  store.sheetSync = { revision: 0, syncedRevision: -1, ...store.sheetSync };
  return store;
}
export async function saveWorkflow(store, changed = false) {
  normalizeWorkflow(store);
  if (changed) store.sheetSync.revision += 1;
  if (!pool) return writeFileStore(store);
  await database().query("UPDATE teacher_workflow SET data = $1 WHERE id = 1", [
    {
      teacherAttendance: store.teacherAttendance,
      teacherSubstitutions: store.teacherSubstitutions,
      sheetSync: store.sheetSync,
    },
  ]);
}
let localQueue = Promise.resolve();
export async function withStoreLock(action) {
  const execute = async () => {
    await repositoryReady;
    if (!pool) return action();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(74823901)");
      const value = await transaction.run(client, action);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };
  if (pool) return execute();
  const result = localQueue.then(execute, execute);
  localQueue = result.catch(() => {});
  return result;
}
