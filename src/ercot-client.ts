const TOKEN_URL =
  "https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com/B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token";
// Public client ID for ERCOT's Public API, documented at
// https://developer.ercot.com/applications/pubapi/user-guide/registration-and-authentication/
const CLIENT_ID = "fec253ea-0d06-4272-a5e6-b478baeecd70";
const API_BASE = "https://api.ercot.com/api/public-reports";

interface TokenResponse {
  id_token: string;
  expires_in: string;
}

let cachedToken: { idToken: string; expiresAt: number } | undefined;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See README.md for ERCOT registration steps.`,
    );
  }
  return value;
}

async function fetchIdToken(): Promise<string> {
  const username = requireEnv("ERCOT_USERNAME");
  const password = requireEnv("ERCOT_PASSWORD");

  const body = new URLSearchParams({
    username,
    password,
    grant_type: "password",
    scope: `openid ${CLIENT_ID} offline_access`,
    client_id: CLIENT_ID,
    response_type: "id_token",
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `ERCOT authentication failed (${response.status}): ${text || response.statusText}`,
    );
  }

  const data = (await response.json()) as TokenResponse;
  return data.id_token;
}

async function getIdToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) {
    return cachedToken.idToken;
  }

  const idToken = await fetchIdToken();
  // ID tokens are valid for 1 hour; refresh a minute early to be safe.
  cachedToken = { idToken, expiresAt: now + 59 * 60 * 1000 };
  return idToken;
}

function buildUrl(pathOrUrl: string, query?: Record<string, string | number | boolean | undefined>): URL {
  const url = pathOrUrl.startsWith("http")
    ? new URL(pathOrUrl)
    : new URL(pathOrUrl.replace(/^\/?/, ""), `${API_BASE}/`);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return url;
}

export async function ercotGet(
  pathOrUrl: string,
  query?: Record<string, string | number | boolean | undefined>,
): Promise<unknown> {
  const subscriptionKey = requireEnv("ERCOT_SUBSCRIPTION_KEY");
  const idToken = await getIdToken();
  const url = buildUrl(pathOrUrl, query);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Ocp-Apim-Subscription-Key": subscriptionKey,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `ERCOT API request to ${url} failed (${response.status}): ${text || response.statusText}`,
    );
  }

  return response.json();
}

export { API_BASE };
