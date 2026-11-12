import { z } from "zod";
import { ValidationError } from "../../application/errors";

const uuid = z.uuid();
const token = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export function uuidParam(value: string, name: string): string {
  if (!uuid.safeParse(value).success)
    throw new ValidationError(`Invalid ${name}`, [{ path: name, message: "must be a UUID" }]);
  return value;
}

export function tokenParam(value: string, name: string): string {
  if (!token.safeParse(value).success)
    throw new ValidationError(`Invalid ${name}`, [{ path: name, message: "invalid identifier" }]);
  return value;
}

export function limitParam(value: string | undefined, def = 50, max = 200): number {
  if (value === undefined) return def;
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < 1 || n > max) {
    throw new ValidationError("Invalid limit", [{ path: "limit", message: `integer between 1 and ${max}` }]);
  }
  return n;
}
