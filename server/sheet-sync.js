import crypto from "node:crypto";
import { readStore, saveWorkflow, withStoreLock } from "./repository.js";
import { buildTeacherReport } from "./teacher-reports.js";
import {
  syncGoogleSheet,
  sheetsConfigured,
  sheetsConfig,
} from "./google-sheets.js";

export function sheetStatus(store) {
  const config = sheetsConfig();

  return {
    configured: sheetsConfigured(config),
    url: config.url || null,
    pending:
      store.sheetSync.revision !== store.sheetSync.syncedRevision,
    lastSyncedAt: store.sheetSync.lastSyncedAt || null,
    lastError: store.sheetSync.lastError || null,
  };
}

export async function syncOnce({
  enabled = sheetsConfigured(),
  send = syncGoogleSheet,
  lock = withStoreLock,
  read = readStore,
  save = saveWorkflow,
  timestamp = Date.now(),
} = {}) {
  if (!enabled) return { state: "unconfigured" };

  const lease = crypto.randomUUID();

  const snapshot = await lock(async () => {
    const store = await read();

    if (
      store.sheetSync.leaseUntil > timestamp ||
      store.sheetSync.nextAttemptAt > timestamp
    ) {
      return null;
    }

    store.sheetSync.leaseId = lease;
    store.sheetSync.leaseUntil = timestamp + 300000;

    await save(store);

    return structuredClone(store);
  });

  if (!snapshot) return { state: "waiting" };

  try {
    const report = buildTeacherReport(snapshot);

    report.online = true;

    const historical = (snapshot.teacherAttendance || []).filter(
      (r) => r.data < report.range.from,
    );

    if (historical.length) {
      for (const r of historical) {
        const one = buildTeacherReport(
          {
            ...snapshot,
            teacherAttendance: [r],
            config: {
              ...snapshot.config,
              teacherAttendanceStart: null,
            },
          },
          {
            from: r.data,
            to: r.data,
          },
        );

        report.rows.push(...one.rows);
      }

      report.rows.sort((a, b) =>
        `${a.data}${a.horarioInicioPrevisto}`.localeCompare(
          `${b.data}${b.horarioInicioPrevisto}`,
        ),
      );
    }

    await send(snapshot, report);

    await lock(async () => {
      const store = await read();

      if (store.sheetSync.leaseId !== lease) return;

      Object.assign(store.sheetSync, {
        syncedRevision: snapshot.sheetSync.revision,
        lastSyncedAt: new Date(timestamp).toISOString(),
        lastError: null,
        attempts: 0,
        nextAttemptAt: timestamp + 60000,
        leaseUntil: 0,
      });

      await save(store);
    });

    console.info("Planilha sincronizada", {
      revision: snapshot.sheetSync.revision,
    });

    return {
      state: "synced",
    };
  } catch {
    await lock(async () => {
      const store = await read();

      if (store.sheetSync.leaseId !== lease) return;

      const attempts = (store.sheetSync.attempts || 0) + 1;

      Object.assign(store.sheetSync, {
        lastError:
          "Falha na sincronização. Os registros continuam salvos; uma nova tentativa será feita.",
        attempts,
        nextAttemptAt:
          timestamp +
          Math.min(
            900000,
            30000 * 2 ** Math.min(attempts, 5),
          ),
        leaseUntil: 0,
      });

      await save(store);
    });

    console.warn(
      "Falha na sincronização da planilha; nova tentativa agendada.",
    );

    return {
      state: "pending",
    };
  }
}

export function startSheetSync() {
  if (!sheetsConfigured()) return;

  const interval = Math.max(
    30000,
    Math.min(
      900000,
      Number(process.env.SHEET_SYNC_INTERVAL_MS) || 60000,
    ),
  );

  const run = () =>
    syncOnce().catch(() =>
      console.warn(
        "Sincronizador indisponível; aguardando próxima tentativa.",
      ),
    );

  run();

  const timer = setInterval(run, interval);

  timer.unref();
}