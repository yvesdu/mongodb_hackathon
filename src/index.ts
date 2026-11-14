import { getAgentByName, routeAgentRequest } from "agents";
import { SHOP_ID, type Env } from "./types";
import { stt, tts } from "./voice";

export { YesChefAgent } from "./agent";

const json = (body: unknown, status = 200) => Response.json(body, { status });

// Names the transcriber should expect to hear.
const KEYTERMS = ["coffee", "latte", "croissant", "croissants", "muffin", "muffins", "two-for-one", "sold out"];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const key = request.headers.get("x-key") ?? "";
    const isCounter = key !== "" && key === env.COUNTER_KEY;
    const isOwner = key !== "" && key === env.OWNER_KEY;
    const post = request.method === "POST";

    try {
      if (path.startsWith("/api/")) {
        const shop = async () => (await getAgentByName(env.YesChefAgent, SHOP_ID)) as any;

        // Read-only routes: anyone may look.
        if (path === "/api/health") return json(await (await shop()).health());
        if (path === "/api/state") return json(await (await shop()).refresh());
        if (path === "/api/record") return json(await (await shop()).record(url.searchParams.get("action_id")));
        if (path === "/api/actions") return json(await (await shop()).actions(Number(url.searchParams.get("limit") ?? 20)));
        if (path === "/api/config" && !post) return json(await (await shop()).config());
        if (path === "/api/chain") return json(await (await shop()).chain());

        // Speech out carries no authority, so it needs no key.
        if (path === "/api/tts" && post) {
          const body = (await request.json()) as { text?: string };
          return tts(env, String(body.text ?? "").slice(0, 600));
        }

        // Everything that can change the shop needs the counter's key.
        if (path === "/api/stt" && post) {
          if (!isCounter) return json({ error: "counter key required" }, 401);
          const audio = await request.arrayBuffer();
          return json(await stt(env, audio, request.headers.get("content-type") ?? "audio/webm", KEYTERMS));
        }
        if (path === "/api/utterance" && post) {
          if (!isCounter) return json({ error: "counter key required" }, 401);
          const body = (await request.json()) as { human_id: string; text: string; stt?: "elevenlabs" | "typed" };
          return json(await (await shop()).utterance({ human_id: body.human_id, text: body.text, stt: body.stt ?? "typed" }));
        }
        if (path === "/api/halt" && post) {
          if (!isCounter) return json({ error: "counter key required" }, 401);
          const body = (await request.json()) as { halt: boolean; human_id?: string };
          return json(await (await shop()).halt(body));
        }

        if (path === "/api/config" && post) {
          if (!isCounter) return json({ error: "counter key required" }, 401);
          return json(await (await shop()).config((await request.json()) as { public_url?: string | null; slow?: boolean; reanchor?: boolean }));
        }

        // Approving a held request needs the owner's key (stands in for the owner's device login).
        if (path === "/api/approve" && post) {
          if (!isOwner) return json({ error: "owner key required" }, 401);
          const body = (await request.json()) as { action_id: string; approve: boolean };
          return json(await (await shop()).approve(body));
        }

        return json({ error: "not found" }, 404);
      }

      // WebSocket and HTTP traffic addressed to the agent itself (/agents/yes-chef-agent/<shop>)
      return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
    } catch (err: any) {
      console.error(err);
      return json({ error: String(err?.message ?? err) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
