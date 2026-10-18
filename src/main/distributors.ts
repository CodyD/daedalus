// Stock and price lookups from Mouser and DigiKey keyword search.
//
// Mouser: Search API v1, one API key (mouser.com > My Account > APIs).
// DigiKey: Product Information API v4, OAuth2 client-credentials app
// (developer.digikey.com). Both are free with per-day limits, so results are
// cached for the session.

export type Distributor = "mouser" | "digikey";

export interface StockHit {
  mpn: string;
  manufacturer: string;
  description: string;
  stock: number;
  /** Unit price at quantity 1, in `currency`; null when not listed. */
  price: number | null;
  currency: string;
  url: string;
}

export type StockAnswer = { hits: StockHit[] } | { error: string };

export interface DistributorKeys {
  mouser?: string;
  digikeyId?: string;
  digikeySecret?: string;
}

const num = (v: unknown): number | null => {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const n = parseFloat(v.replace(/[^\d.]/g, ""));
  return isFinite(n) ? n : null;
};

async function mouser(q: string, key: string): Promise<StockHit[]> {
  const res = await fetch(`https://api.mouser.com/api/v1/search/keyword?apiKey=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      SearchByKeywordRequest: { keyword: q, records: 10, startingRecord: 0, searchOptions: "InStock", searchWithYourSignUpLanguage: "false" },
    }),
  });
  const body = await res.json().catch(() => null) as any;
  const err = body?.Errors?.[0];
  if (!res.ok || err) throw new Error(err?.Message ?? `HTTP ${res.status}`);
  return (body?.SearchResults?.Parts ?? []).map((p: any): StockHit => {
    const first = p.PriceBreaks?.[0];
    return {
      mpn: p.ManufacturerPartNumber ?? "",
      manufacturer: p.Manufacturer ?? "",
      description: p.Description ?? "",
      stock: num(p.AvailabilityInStock) ?? num(p.Availability) ?? 0,
      price: first ? num(first.Price) : null,
      currency: first?.Currency ?? "USD",
      url: p.ProductDetailUrl ?? "",
    };
  });
}

let dkToken: { id: string; token: string; expires: number } | null = null;

async function digikeyToken(id: string, secret: string): Promise<string> {
  if (dkToken && dkToken.id === id && Date.now() < dkToken.expires) return dkToken.token;
  const res = await fetch("https://api.digikey.com/v1/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials" }),
  });
  const body = await res.json().catch(() => null) as any;
  if (!res.ok || !body?.access_token) throw new Error(body?.error_description ?? body?.detail ?? `sign-in failed (HTTP ${res.status})`);
  // Renew a minute early; tokens last about ten minutes.
  dkToken = { id, token: body.access_token, expires: Date.now() + ((body.expires_in ?? 600) - 60) * 1000 };
  return dkToken.token;
}

async function digikey(q: string, id: string, secret: string): Promise<StockHit[]> {
  const token = await digikeyToken(id, secret);
  const res = await fetch("https://api.digikey.com/products/v4/search/keyword", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "X-DIGIKEY-Client-Id": id,
      "X-DIGIKEY-Locale-Site": "US",
      "X-DIGIKEY-Locale-Currency": "USD",
    },
    body: JSON.stringify({ Keywords: q, Limit: 10, Offset: 0 }),
  });
  const body = await res.json().catch(() => null) as any;
  if (res.status === 401) dkToken = null;
  if (!res.ok) throw new Error(body?.detail ?? body?.title ?? `HTTP ${res.status}`);
  const products = [...(body?.ExactMatches ?? []), ...(body?.Products ?? [])];
  const seen = new Set<string>();
  return products.flatMap((p: any): StockHit[] => {
    const mpn = p.ManufacturerProductNumber ?? "";
    if (seen.has(mpn)) return [];
    seen.add(mpn);
    return [{
      mpn,
      manufacturer: p.Manufacturer?.Name ?? "",
      description: p.Description?.ProductDescription ?? "",
      stock: num(p.QuantityAvailable) ?? 0,
      price: num(p.UnitPrice),
      currency: "USD",
      url: p.ProductUrl ?? "",
    }];
  });
}

const cache = new Map<string, StockAnswer>();

/** Best in-stock matches first. Errors are returned per query, not thrown, so one bad line doesn't sink the rest. */
export async function lookupStock(dist: Distributor, q: string, keys: DistributorKeys): Promise<StockAnswer> {
  const ck = `${dist}|${q}`;
  const hit = cache.get(ck);
  if (hit) return hit;
  try {
    let hits: StockHit[];
    if (dist === "mouser") {
      if (!keys.mouser) return { error: "no Mouser API key" };
      hits = await mouser(q, keys.mouser);
    } else {
      if (!keys.digikeyId || !keys.digikeySecret) return { error: "no DigiKey client ID / secret" };
      hits = await digikey(q, keys.digikeyId, keys.digikeySecret);
    }
    const answer = { hits: hits.sort((a, b) => b.stock - a.stock).slice(0, 5) };
    cache.set(ck, answer);
    return answer;
  } catch (e) {
    return { error: (e as Error).message };
  }
}
