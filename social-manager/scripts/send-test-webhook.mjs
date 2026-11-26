#!/usr/bin/env node
/**
 * Posts a signed fake webhook to the Worker, shaped like Meta's.
 *
 *   npm run webhook -- seed-account    once: fake Instagram account + Facebook Page in local D1
 *   npm run webhook -- comment "xmas" --network facebook   a Facebook Page comment
 *   npm run webhook -- comment "chrisstmas please 🎄"
 *   npm run webhook -- comment "hello" --media 17890000000000000 --user 111
 *   npm run webhook -- dm "xmas"
 *   npm run webhook -- tap sm:open:1   someone taps a "Send me the link" button (rule 1)
 *   npm run webhook -- verify          GET subscription check
 *   npm run webhook -- bad-signature   must come back 401
 *
 * Options: --network instagram|facebook, --url (default http://localhost:8787/webhooks/<network>), --media,
 * --user, --account (the connected account's IG id). Secrets come from
 * .dev.vars, or the environment (META_APP_SECRET, IG_VERIFY_TOKEN). Without
 * --user each run uses a new random commenter, so dedup
 * doesn't block repeat runs. Pass a fixed --user to test dedup.
 *
 * With DRY_RUN=true in .dev.vars nothing reaches Instagram; watch the
 * `wrangler dev` terminal for `instagram.graph.dry_run` lines.
 */
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vars = { ...readDevVars(`${root}/.dev.vars`), ...process.env };

const [command = "comment", ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);
const url = opts.url ?? `http://localhost:8787/webhooks/${opts.network ?? "instagram"}`;
const IG_ID = "17841400000000000"; // seed-account ids
const IG_MEDIA = "17890000000000000";
const FB_PAGE = "100000000000001";
const FB_POST = "100000000000001_200000000000002";
const network = opts.network ?? "instagram";
const igUserId = opts.account ?? (network === "facebook" ? FB_PAGE : IG_ID);
const rand = () => String(Math.floor(Math.random() * 1e15)).padStart(15, "1");

switch (command) {
  case "seed-account": {
    // What /connect/<network> would store after a real login, plus one example
    // auto-reply each, written to the local D1 that `npm run dev` reads.
    // Run `npm run db:migrate:local` first.
    const now = new Date().toISOString();
    const q = (v) => `'${String(v).replaceAll("'", "''")}'`;
    const rule = (network, account, media, name) =>
      `INSERT OR IGNORE INTO rules (network, account_id, media_id, name, keywords, link, dm, public_replies, any_comment, enabled, created_at, updated_at)
       VALUES (${q(network)}, ${q(account)}, ${q(media)}, ${q(name)}, ${q(JSON.stringify(["christmas", "xmas"]))},
       'https://example.com/christmas', ${q("Here's your link 🎄 {link}")}, ${q(JSON.stringify(["Sent! 🎄 Check your messages 📩"]))}, 0, 1, ${q(now)}, ${q(now)});`;
    const sql = [
      `INSERT OR REPLACE INTO accounts (network, id, username, token, connected_at) VALUES ('instagram', ${q(IG_ID)}, 'llamapresenter', 'local-fake-token', ${q(now)});`,
      `INSERT OR REPLACE INTO accounts (network, id, username, token, connected_at) VALUES ('facebook', ${q(FB_PAGE)}, 'LlamaPresenter', 'local-fake-token', ${q(now)});`,
      rule("instagram", IG_ID, IG_MEDIA, "Silent Night (example)"),
      rule("facebook", FB_PAGE, FB_POST, "Christmas post (example)"),
    ].join("\n");
    execFileSync("npx", ["wrangler", "d1", "execute", "social-manager", "--local", "--command", sql], {
      cwd: root,
      stdio: ["ignore", "ignore", "inherit"],
    });
    console.log(`Seeded @llamapresenter (Instagram ${IG_ID}) and the LlamaPresenter Page (Facebook ${FB_PAGE}), each with an example auto-reply.`);
    break;
  }

  case "comment":
    await post(
      network === "facebook"
        ? {
            object: "page",
            entry: [
              {
                id: igUserId,
                time: Math.floor(Date.now() / 1000),
                changes: [
                  {
                    field: "feed",
                    value: {
                      item: "comment",
                      verb: "add",
                      comment_id: `${FB_POST.split("_")[1]}_${rand()}`,
                      post_id: opts.media ?? FB_POST,
                      from: { id: opts.user ?? `77${rand()}`, name: "Test Commenter" },
                      message: opts._[0] ?? "chrisstmas please 🎄",
                      created_time: Math.floor(Date.now() / 1000),
                    },
                  },
                ],
              },
            ],
          }
        : {
            object: "instagram",
            entry: [
              {
                id: igUserId,
                time: Math.floor(Date.now() / 1000),
                changes: [
                  {
                    field: "comments",
                    value: {
                      comment_id: `179${rand()}`, // Unified Login field name
                      text: opts._[0] ?? "chrisstmas please 🎄",
                      from: { id: opts.user ?? `55${rand()}`, username: "test_commenter" },
                      media: { id: opts.media ?? IG_MEDIA, media_product_type: "REELS" },
                    },
                  },
                ],
              },
            ],
          },
    );
    break;

  case "dm":
    await post({
      object: network === "facebook" ? "page" : "instagram",
      entry: [
        {
          id: igUserId,
          time: Date.now(),
          messaging: [
            {
              sender: { id: opts.user ?? `66${rand()}` },
              recipient: { id: igUserId },
              timestamp: Date.now(),
              message: { mid: `aWdf${rand()}`, text: opts._[0] ?? "xmas" },
            },
          ],
        },
      ],
    });
    break;

  case "tap":
    // A button tap (webhook field messaging_postbacks). The payload names the step and rule.
    await post({
      object: "instagram",
      entry: [
        {
          id: igUserId,
          time: Date.now(),
          messaging: [
            {
              sender: { id: opts.user ?? `66${rand()}` },
              recipient: { id: igUserId },
              timestamp: Date.now(),
              postback: { mid: `aWdf${rand()}`, title: "Send me the link", payload: opts._[0] ?? "sm:open:1" },
            },
          ],
        },
      ],
    });
    break;

  case "verify": {
    const qs = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": vars.IG_VERIFY_TOKEN ?? "",
      "hub.challenge": "challenge-123",
    });
    const res = await fetch(`${url}?${qs}`);
    console.log(res.status, await res.text(), "(expect 200 challenge-123)");
    break;
  }

  case "bad-signature":
    await post({ object: "instagram", entry: [] }, "sha256=" + "0".repeat(64));
    break;

  default:
    console.error(`Unknown command "${command}". Use seed-account | comment | dm | verify | bad-signature.`);
    process.exit(1);
}

async function post(payload, forcedSignature) {
  if (!vars.META_APP_SECRET && !forcedSignature) {
    console.error("META_APP_SECRET not found in .dev.vars or the environment.");
    process.exit(1);
  }
  const body = JSON.stringify(payload);
  const signature =
    forcedSignature ?? `sha256=${createHmac("sha256", vars.META_APP_SECRET).update(body).digest("hex")}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
    body,
  });
  console.log(`POST ${url} → ${res.status} ${await res.text()}`);
  console.log(JSON.stringify(payload, null, 2));
}

function readDevVars(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function parseArgs(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) out[args[i].slice(2)] = args[++i];
    else out._.push(args[i]);
  }
  return out;
}
