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
  if (code === "53300") return "DB_CONNECTION_LIMIT";
  if (code === "53000") return "DB_RESOURCE_LIMIT";
  if (code === "DATABASE_URL_INVALID") return "DB_URL_INVALID";
  if (code === "DATABASE_URL_MISSING") return "DB_URL_MISSING";
  if (code === "PRODUCTION_SECRETS_MISSING")
    return "PRODUCTION_SECRETS_MISSING";
  return "INTERNAL_ERROR";
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
  // Supabase's shared transaction pooler requires TLS. Do not permit a
  // production DATABASE_URL to silently fall back to an unencrypted socket.
  if (
    !["require", "verify-ca", "verify-full"].includes(
      url.searchParams.get("sslmode"),
    )
  )
    url.searchParams.set("sslmode", "require");
  return url.toString();
}

const connectionString = databaseConnectionString();
export const pool = connectionString
  ? new pg.Pool({
      connectionString,
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

async function setupPostgres() {
  const migrationDir = path.join(rootDir, "server/migrations");
  const migrations = (await fs.readdir(migrationDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrations) {
    const migration = await fs.readFile(path.join(migrationDir, name), "utf8");
    await pool.query(migration);
  }
  const count = await pool.query(
    "SELECT count(*)::int AS count FROM app_config",
  );
  if (count.rows[0].count === 0) {
    const seed = await readSeed();
    await pool.query("INSERT INTO app_config (id, data) VALUES (1, $1)", [
      seed.config,
    ]);
    for (const item of seed.turmas)
      await pool.query("INSERT INTO classes (id, data) VALUES ($1, $2)", [
        item.id,
        item,
      ]);
    for (const item of seed.professores)
      await pool.query("INSERT INTO teachers (id, data) VALUES ($1, $2)", [
        item.id,
        item,
      ]);
    for (const item of seed.alunos)
      await pool.query("INSERT INTO students (id, data) VALUES ($1, $2)", [
        item.id,
        item,
      ]);
  }
}
export async function readStore() {
  if (!pool) return readFileStore();
  const [config, classes, teachers, students, checkins, workflow] =
    await Promise.all([
      database().query("SELECT data FROM app_config WHERE id = 1"),
      database().query("SELECT id, data FROM classes"),
      database().query("SELECT id, data FROM teachers"),
      database().query("SELECT id, data FROM students"),
      database().query("SELECT data FROM checkins ORDER BY created_at DESC"),
      database().query("SELECT data FROM teacher_workflow WHERE id = 1"),
    ]);
  const rawClasses = classes.rows.map((row) => row.data);
  const professores = teachers.rows.length
    ? teachers.rows.map((row) => row.data)
    : teachersFromClasses(rawClasses);
  return {
    ...normalizeWorkflow(workflow.rows[0]?.data || {}),
    config: config.rows[0]?.data || {},
    turmas: connectClassesToTeachers(rawClasses, professores),
    professores,
    alunos: students.rows.map((row) => row.data),
    checkins: checkins.rows.map((row) => row.data),
  };
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
