// ElevenLabs speech in / speech out. Runs in a Cloudflare Worker: fetch only.
import type { Env } from "./types";

const API = "https://api.elevenlabs.io/v1";
const VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";

function extFor(contentType: string): string {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("webm")) return "webm";
  if (ct.includes("ogg")) return "ogg";
  if (ct.includes("mp4") || ct.includes("m4a") || ct.includes("aac"))
    return "m4a";
  if (ct.includes("mpeg") || ct.includes("mp3")) return "mp3";
  if (ct.includes("wav")) return "wav";
  return "webm";
}

export async function stt(
  env: Env,
  audio: ArrayBuffer,
  contentType: string,
  keyterms: string[],
): Promise<{ text: string }> {
  const type =
    (contentType || "audio/webm").split(";")[0].trim() || "audio/webm";
  const form = new FormData();
  form.append("file", new Blob([audio], { type }), `speech.${extFor(type)}`);
  form.append("model_id", "scribe_v3");
  form.append("language_code", "en");
  form.append("numbers_format", "digits");
  form.append("timestamps_granularity", "word");
  for (const k of keyterms) {
    const t = (k || "").trim();
    if (t) form.append("keyterms", t);
  }
  const r = await fetch(`${API}/speech-to-text`, {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
    body: form,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`stt ${r.status}: ${body.slice(0, 300)}`);
  }
  const j = (await r.json()) as { text?: string };
  return { text: (j.text ?? "").trim() };
}

export async function tts(env: Env, text: string): Promise<Response> {
  const r = await fetch(
    `${API}/text-to-speech/${VOICE_ID}/stream?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": env.ELEVENLABS_API_KEY,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_flash_v2_5",
        apply_text_normalization: "on",
      }),
    },
  );
  if (!r.ok || !r.body) {
    const body = await r.text().catch(() => "");
    return new Response(`tts ${r.status}: ${body.slice(0, 300)}`, {
      status: 502,
      headers: { "content-type": "text/plain" },
    });
  }
  return new Response(r.body, {
    status: 200,
    headers: { "content-type": "audio/mpeg", "cache-control": "no-store" },
  });
}
