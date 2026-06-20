#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env");

function loadLocalEnv() {
  if (!existsSync(envPath)) return {};
  const parsed = {};
  const text = readFileSync(envPath, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[match[1]] = value;
  }
  return parsed;
}

const localEnv = loadLocalEnv();

function secret(name) {
  return process.env[name] || localEnv[name] || "";
}

const supabaseUrl = secret("SUPABASE_URL").replace(/\/+$/, "");
const serviceRole =
  secret("SUPABASE_SERVICE_ROLE_KEY") ||
  secret("SUPABASE_SERVICE_ROLE") ||
  secret("SUPABASE_SERVICE_KEY");
const ownerEmail = secret("PERMANENT_OWNER_ACCOUNT_EMAIL");

if (!supabaseUrl || !serviceRole || !ownerEmail) {
  console.error(JSON.stringify({
    ok: false,
    error: "missing_required_configuration",
    supabase_url_configured: Boolean(supabaseUrl),
    service_role_configured: Boolean(serviceRole),
    owner_email_configured: Boolean(ownerEmail),
  }, null, 2));
  process.exit(1);
}

const headers = {
  accept: "application/json",
  apikey: serviceRole,
  authorization: `Bearer ${serviceRole}`,
};

async function listUsers() {
  const users = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetch(
      `${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=1000`,
      { headers },
    );
    if (!response.ok) {
      throw new Error(`auth_user_lookup_failed_${response.status}`);
    }
    const body = await response.json();
    const batch = Array.isArray(body.users) ? body.users : [];
    users.push(...batch);
    if (batch.length < 1000) break;
  }
  return users;
}

async function provision(userId) {
  const url = new URL(`${supabaseUrl}/rest/v1/internal_access_overrides`);
  url.searchParams.set("on_conflict", "user_id");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      user_id: userId,
      access_level: "internal_owner",
      billing_exempt: true,
      collector_entitled: true,
      status: "active",
      reason: "permanent_internal_owner_account",
      expires_at: null,
    }),
  });

  if (!response.ok) {
    throw new Error(`owner_access_upsert_failed_${response.status}`);
  }
}

async function verify(userId) {
  const url = new URL(`${supabaseUrl}/rest/v1/internal_access_overrides`);
  url.searchParams.set("select", "access_level,billing_exempt,collector_entitled,status,expires_at");
  url.searchParams.set("user_id", `eq.${userId}`);
  url.searchParams.set("limit", "1");

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`owner_access_verify_failed_${response.status}`);
  }
  const rows = await response.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  return Boolean(
    row &&
    row.access_level === "internal_owner" &&
    row.billing_exempt === true &&
    row.collector_entitled === true &&
    row.status === "active" &&
    row.expires_at === null
  );
}

try {
  const users = await listUsers();
  const matches = users.filter((user) =>
    String(user.email || "").toLowerCase() === ownerEmail.toLowerCase()
  );

  if (matches.length !== 1 || !matches[0]?.id) {
    console.error(JSON.stringify({
      ok: false,
      error: "owner_account_not_unique_or_missing",
      owner_account_found: matches.length > 0,
      owner_account_unique: matches.length === 1,
    }, null, 2));
    process.exit(1);
  }

  await provision(matches[0].id);
  const active = await verify(matches[0].id);

  console.log(JSON.stringify({
    ok: active,
    owner_account_found: true,
    owner_account_unique: true,
    owner_access_active: active,
    owner_access_non_expiring: active,
    owner_billing_exempt: active,
    owner_collector_entitled: active,
  }, null, 2));

  if (!active) process.exit(1);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : "owner_access_provisioning_failed",
  }, null, 2));
  process.exit(1);
}
