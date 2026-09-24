import { test } from "node:test";
import assert from "node:assert/strict";
import { syncOnce } from "../server/sheet-sync.js";
import { syncGoogleSheet } from "../server/google-sheets.js";

const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/test-script-id/exec";

const initial = () => ({
  config: {},
  professores: [],
  turmas: [],
  teacherAttendance: [],
  sheetSync: {
    revision: 1,
    syncedRevision: 0,
    leaseId: "",
    leaseUntil: 0,
    nextAttemptAt: 0,
    lastSyncedAt: null,
    lastError: null,
    attempts: 0,
  },
});

function dependencies() {
  let state = initial();
  let queue = Promise.resolve();

  return {
    read: async () => structuredClone(state),

    save: async (value) => {
      state = structuredClone(value);
    },

    lock: (fn) => {
      const result = queue.then(fn);
      queue = result.catch(() => {});
      return result;
    },

    enabled: true,
  };
}

test(
  "temporary integration failure persists a retry and preserves records",
  async () => {
    const deps = dependencies();
    const time = Date.now();
    let calls = 0;

    const send = async () => {
      calls++;

      if (calls === 1) {
        throw Error("unavailable");
      }
    };

    assert.equal(
      (
        await syncOnce({
          ...deps,
          send,
          timestamp: time,
        })
      ).state,
      "pending",
    );

    assert.equal(
      (await deps.read()).sheetSync.syncedRevision,
      0,
    );

    assert.equal(
      (
        await syncOnce({
          ...deps,
          send,
          timestamp: time + 1,
        })
      ).state,
      "waiting",
    );

    assert.equal(
      (
        await syncOnce({
          ...deps,
          send,
          timestamp: time + 120000,
        })
      ).state,
      "synced",
    );

    assert.equal(
      (await deps.read()).sheetSync.syncedRevision,
      1,
    );
  },
);

test(
  "writes during synchronization stay pending and concurrent workers share one lease",
  async () => {
    const deps = dependencies();

    let release;

    const blocked = new Promise((resolve) => {
      release = resolve;
    });

    let started;

    const ready = new Promise((resolve) => {
      started = resolve;
    });

    const first = syncOnce({
      ...deps,

      send: async () => {
        started();
        await blocked;
      },
    });

    await ready;

    assert.equal(
      (
        await syncOnce({
          ...deps,

          send: async () => {
            assert.fail("duplicate writer");
          },
        })
      ).state,
      "waiting",
    );

    const state = await deps.read();

    state.sheetSync.revision = 2;

    await deps.save(state);

    release();

    await first;

    const final = await deps.read();

    assert.equal(
      final.sheetSync.revision,
      2,
    );

    assert.equal(
      final.sheetSync.syncedRevision,
      1,
    );
  },
);

test(
  "Google Apps Script adapter sends workbook data atomically and does not export CPFs",
  async () => {
    const state = initial();

    state.professores = [
      {
        id: "test",
        nome: "=FORMULA()",
        cpfHash: "PRIVATE_HASH",
      },
    ];

    let calls = 0;
    let requestedUrl = null;
    let requestedOptions = null;

    const fetcher = async (url, options) => {
      calls++;
      requestedUrl = url;
      requestedOptions = options;

      return {
        ok: true,

        json: async () => ({
          success: true,
          message: "Tesla sincronizado com sucesso",
        }),
      };
    };

    const report = {
      range: {
        from: "2026-09-01",
        to: "2026-09-22",
      },

      rows: [],

      summary: [],
    };

    await syncGoogleSheet(
      state,
      report,
      {
        config: {
          url: APPS_SCRIPT_URL,
        },

        fetcher,
      },
    );

    assert.equal(calls, 1);

    assert.equal(
      requestedUrl,
      APPS_SCRIPT_URL,
    );

    assert.equal(
      requestedOptions.method,
      "POST",
    );

    assert.equal(
      requestedOptions.headers["Content-Type"],
      "application/json",
    );

    const body = JSON.parse(
      requestedOptions.body,
    );

    assert.equal(
      body.source,
      "Tesla",
    );

    assert.ok(
      typeof body.generatedAt === "string",
    );

    assert.ok(
      Array.isArray(body.tables),
    );

    assert.equal(
      body.tables.length,
      6,
    );

    assert.ok(
      body.tables.every(
        (table) =>
          typeof table.name === "string" &&
          Array.isArray(table.headers) &&
          Array.isArray(table.rows),
      ),
    );

    const serialized = JSON.stringify(body);

    assert.ok(
      serialized.includes("=FORMULA()"),
    );

    assert.ok(
      !serialized.includes("PRIVATE_HASH"),
    );

    assert.ok(
      !serialized.includes("cpfHash"),
    );

    assert.ok(
      !serialized.includes('"cpf"'),
    );
  },
);