import { eq } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { appUser } from "./db/schema.js";
import type { AgentDb } from "./mcp/agentDb.js";
import { COUNTRIES, isCountryCode, type Region, regionOf } from "./region.js";

/**
 * Which user a command or process acts for: TIDYSUM_USER_ID if set, otherwise the only user.
 * A fresh install has exactly one ("Owner", created by the migration).
 */
export async function resolveUserId(db: Db, env = process.env): Promise<string> {
  const wanted = env.TIDYSUM_USER_ID;
  if (wanted) {
    const [row] = await db.select({ id: appUser.id }).from(appUser).where(eq(appUser.id, wanted));
    if (!row) throw new Error(`TIDYSUM_USER_ID ${wanted} is not a user`);
    return row.id;
  }
  const rows = await db.select({ id: appUser.id }).from(appUser).limit(2);
  const [only] = rows;
  if (!only) throw new Error("no users; run `tidysum migrate` first");
  if (rows.length > 1) throw new Error("more than one user; set TIDYSUM_USER_ID");
  return only.id;
}

/**
 * `investing` turns on allocation checks and securities proposals. Only for someone managing
 * their own money until Tidysum is a registered adviser (docs/decisions/0002).
 */
export async function createUser(
  db: Db,
  displayName: string,
  investing = false,
  country = "US",
): Promise<string> {
  const [row] = await db
    .insert(appUser)
    .values({ displayName, investingEnabled: investing, country: parseCountry(country) })
    .returning({ id: appUser.id });
  if (!row) throw new Error("user insert returned no row");
  return row.id;
}

/** An ISO country code Tidysum knows ("ca" or "CA"), or an error listing them. */
export function parseCountry(input: string): string {
  const code = input.trim().toUpperCase();
  if (!isCountryCode(code)) {
    throw new Error(
      `${input} is not a country Tidysum knows; use one of ${Object.keys(COUNTRIES).join(", ")}`,
    );
  }
  return code;
}

/** The user's country and home currency, on an owner connection. */
export async function readRegion(db: Db, userId: string): Promise<Region> {
  const [row] = await db
    .select({ country: appUser.country })
    .from(appUser)
    .where(eq(appUser.id, userId));
  return regionOf(row?.country);
}

/** The session user's country and home currency, on an agent connection (row-level security). */
export async function readAgentRegion(db: AgentDb): Promise<Region> {
  const { rows } = await db.query<{ country: string }>("select country from app_user");
  return regionOf(rows[0]?.country);
}

/** Moves a user to another country: their currency and the advice they get follow it. */
export async function setCountry(db: Db, userId: string, country: string): Promise<Region> {
  const code = parseCountry(country);
  await db.update(appUser).set({ country: code }).where(eq(appUser.id, userId));
  return regionOf(code);
}

/**
 * A phone number as E.164, or undefined if it isn't one. Ten digits, or eleven starting with 1,
 * are taken as US/Canada (+1), Tidysum's only Plaid country; anything else needs its "+".
 */
export function normalizePhone(input: string): string | undefined {
  const trimmed = input.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return undefined;
  const digits = trimmed.replace(/\D/g, "");
  let e164: string;
  if (trimmed.startsWith("+")) e164 = `+${digits}`;
  else if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) e164 = `+${digits}`;
  else return undefined;
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) return undefined;
  // A North American number is +1 and ten digits, the first of them 2-9.
  if (e164.startsWith("+1") && !/^\+1[2-9]\d{9}$/.test(e164)) return undefined;
  return e164;
}

export async function readPhone(db: Db, userId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ phoneNumber: appUser.phoneNumber })
    .from(appUser)
    .where(eq(appUser.id, userId));
  return row?.phoneNumber ?? undefined;
}

/** Saves (or with null, forgets) the number Plaid Link pre-fills. */
export async function setPhone(db: Db, userId: string, phone: string | null): Promise<void> {
  await db.update(appUser).set({ phoneNumber: phone }).where(eq(appUser.id, userId));
}

/**
 * Whether the Investments page shows money amounts. A display choice, so it moves no money and
 * needs no proposal; agents read it and keep to percentages while it is off.
 */
export async function setShowInvestmentAmounts(
  db: Db,
  userId: string,
  show: boolean,
): Promise<void> {
  await db.update(appUser).set({ showInvestmentAmounts: show }).where(eq(appUser.id, userId));
}
