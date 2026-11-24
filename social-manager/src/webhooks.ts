/**
 * The part of webhook handling every Meta network shares: the GET
 * subscription check, signature verification on the raw bytes, and
 * answering 200 before doing the work (a slow answer makes Meta redeliver,
 * and a redelivery is a second DM attempt).
 */
import type { Env } from "./env";
import { log } from "./log";
import type { Network } from "./networks";
import { verifySignature } from "./signature";

/** Meta's one-time check when you save the callback URL. One verify token serves every network. */
export function verifySubscription(url: URL, env: Env, network: Network): Response {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === env.IG_VERIFY_TOKEN && challenge) {
    log.info(`${network}.webhook.verified`);
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  log.warn(`${network}.webhook.verify_failed`, { mode, token_matches: token === env.IG_VERIFY_TOKEN });
  return new Response("Forbidden", { status: 403 });
}

export async function receiveWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  network: Network,
  process: (payload: unknown, env: Env) => Promise<void>,
): Promise<Response> {
  const raw = await request.arrayBuffer();
  const which = await verifySignature(raw, request.headers.get("X-Hub-Signature-256"), [
    { name: "META_APP_SECRET", value: env.META_APP_SECRET },
    { name: "IG_APP_SECRET_ALT", value: env.IG_APP_SECRET_ALT },
  ]);
  if (!which) {
    log.warn(`${network}.signature.invalid`, {
      has_header: request.headers.has("X-Hub-Signature-256"),
      hint: "Webhooks are signed with the Meta app secret (App settings > Basic). See README.",
    });
    return new Response("Invalid signature", { status: 401 });
  }
  if (which !== "META_APP_SECRET") log.info(`${network}.signature.ok`, { which });

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    log.warn(`${network}.webhook.bad_json`);
    return new Response("Bad JSON", { status: 400 });
  }
  ctx.waitUntil(process(payload, env));
  return new Response("EVENT_RECEIVED", { status: 200 });
}
