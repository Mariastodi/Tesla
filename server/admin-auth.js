import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const pattern = /^scrypt\$32768\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{64})$/;

export function validPinHash(value) {
  return typeof value === "string" && pattern.test(value);
}

export async function hashPin(pin) {
  if (typeof pin !== "string" || pin.length < 8 || pin.length > 128)
    throw new Error("O código deve ter entre 8 e 128 caracteres.");
  const salt = randomBytes(16).toString("hex");
  const key = await derive(pin, Buffer.from(salt, "hex"), 32, options);
  return `scrypt$32768$8$1$${salt}$${key.toString("hex")}`;
}

export async function verifyPin(pin, encoded) {
  if (typeof pin !== "string" || pin.length < 8 || pin.length > 128)
    return false;
  const match = typeof encoded === "string" && encoded.match(pattern);
  if (!match) return false;
  const key = await derive(pin, Buffer.from(match[1], "hex"), 32, options);
  return timingSafeEqual(key, Buffer.from(match[2], "hex"));
}
