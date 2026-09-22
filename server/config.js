import "dotenv/config";
import path from "node:path";
import { hashPin, validPinHash } from "./admin-auth.js";
import { fileURLToPath } from "node:url";
process.env.TZ = "America/Fortaleza";
export const rootDir = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);
export const dataDir = path.resolve(
  process.env.DATA_DIR || path.join(rootDir, "dados"),
);
export const runtimeFile = path.join(dataDir, "runtime.json");
export const salt = process.env.CPF_SALT || "presenca-tesla-local-salt";
const configuredHash = process.env.ADMIN_PIN_HASH || "";
const legacyPin = process.env.ADMIN_PIN || "";
if (configuredHash && !validPinHash(configuredHash))
  throw new Error(
    "ADMIN_PIN_HASH inválido. Gere um hash com npm run hash:pin.",
  );
export const adminPinHash =
  configuredHash || (legacyPin ? await hashPin(legacyPin) : "");
export const production = process.env.NODE_ENV === "production";
if (
  production &&
  (!process.env.DATABASE_URL ||
    salt.length < 32 ||
    (!configuredHash && legacyPin.length < 12))
)
  throw new Error(
    "Produção exige DATABASE_URL, CPF_SALT (32 caracteres) e ADMIN_PIN_HASH (ou ADMIN_PIN legado de 12 caracteres).",
  );
