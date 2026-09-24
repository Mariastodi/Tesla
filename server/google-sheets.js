import { workbookTables } from "./teacher-reports.js";

export function sheetsConfig(env = process.env) {
  return {
    url: env.GOOGLE_APPS_SCRIPT_URL || "",
    token: env.GOOGLE_APPS_SCRIPT_TOKEN || "",
  };
}

export function sheetsConfigured(config = sheetsConfig()) {
  return Boolean(
      config.url &&
      config.token &&
      /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(
        config.url,
      ),
  );
}

export async function syncGoogleSheet(
  store,
  report,
  { config = sheetsConfig(), fetcher = fetch } = {},
) {
  if (!sheetsConfigured(config)) {
    throw new Error("Integração com Google Apps Script não configurada.");
  }

  const tables = workbookTables(store, report);

  const response = await fetcher(config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source: "Tesla",
      generatedAt: new Date().toISOString(),
      token: config.token,
      tables,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(
      `Sincronização da planilha: HTTP ${response.status}`,
    );
  }

  let result;

  try {
    result = await response.json();
  } catch {
    throw new Error(
      "Resposta inválida do Google Apps Script.",
    );
  }

  if (!result.success) {
    throw new Error(
      result.message ||
        "Google Apps Script recusou a sincronização.",
    );
  }
}
