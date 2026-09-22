import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPin, verifyPin, validPinHash } from "../server/admin-auth.js";

test("salted hashes accept an eight-digit PIN and reject other credentials", async () => {
  const pin = "87654321";
  const first = await hashPin(pin);
  const second = await hashPin(pin);
  assert.notEqual(first, second);
  assert.equal(validPinHash(first), true);
  assert.equal(await verifyPin(pin, first), true);
  assert.equal(await verifyPin("87654320", first), false);
  assert.equal(await verifyPin(undefined, first), false);
  assert.equal(await verifyPin("x".repeat(129), first), false);
  assert.equal(await verifyPin(pin, "malformed"), false);
  assert.equal(
    await verifyPin(pin, first.replace("32768", "999999999")),
    false,
  );
  await assert.rejects(hashPin("1234567"));
});
