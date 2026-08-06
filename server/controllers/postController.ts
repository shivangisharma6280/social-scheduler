import { Response } from "express";
import { AuthRequest } from "../middleware/authMiddleware.js";
import zernio from "../config/zernio.js";
import { Generation } from "../models/Generation.js";
import { Post } from "../models/Post.js";
import { UploadMediaDirectData } from "@zernio/node";
import dns from "node:dns";
import https from "node:https";


const PUBLIC_DNS_SERVERS = ["8.8.8.8", "1.1.1.1"];
const DEFAULT_TIMEOUT_MS = 30_000;
const IMAGE_TIMEOUT_MS = 45_000;

// Resolve a hostname to the first IPv4 address using public DNS servers.
const resolveViaPublicDns = (hostname: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const resolver = new dns.Resolver();
    resolver.setServers(PUBLIC_DNS_SERVERS);
    resolver.resolve4(hostname, (err, addresses) => {
      if (err) return reject(err);
      if (!addresses || addresses.length === 0) {
        return reject(new Error(`No A record for ${hostname}`));
      }
      resolve(addresses[0]);
    });
  });
};

// Custom `lookup` passed to https.request so the hostname is resolved via public
// DNS instead of the machine's (possibly broken) local resolver.
const publicDnsLookup = (hostname: string, _options: any, callback: any): void => {
  resolveViaPublicDns(hostname)
    .then((ip) => callback(null, ip, 4))
    .catch((err) => callback(err as Error));
};

interface DnsFallbackResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<any>;
  arrayBuffer: () => Promise<ArrayBuffer>;
  headers: { get: (name: string) => string | null };
}

// Perform an HTTPS request that resolves the host via public DNS and connects to
// the resolved IP. Keeps the Host header + SNI correct so the request works
// end-to-end. Supports GET and POST, and returns both text/json/arrayBuffer
// accessors so it works for JSON APIs (Hugging Face) and binary APIs (images).
const requestViaPublicDns = (
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number
): Promise<DnsFallbackResponse> => {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname + parsed.search,
        method,
        headers: { ...headers, Host: parsed.host },
        servername: parsed.hostname, // SNI / TLS certificate hostname
        lookup: publicDnsLookup,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({
            ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
            status: res.statusCode || 0,
            text: async () => buf.toString("utf-8"),
            json: async () => JSON.parse(buf.toString("utf-8")),
            arrayBuffer: async () =>
              buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
            headers: {
              get: (name: string) => (res.headers[name.toLowerCase()] as string) || null,
            },
          });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error(`Request to ${parsed.hostname} timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
};

// Fetch that prefers the built-in global fetch (works on normal networks) and
// falls back to the public-DNS HTTPS client when the default resolver reports
// a DNS error (ENOTFOUND, ENODATA, EAI_AGAIN, etc). Works for both GET (images)
// and POST (Hugging Face) requests, and applies a timeout either way.
const fetchWithDnsFallback = async (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<DnsFallbackResponse> => {
  const method = init?.method || "GET";
  const headers = init?.headers || {};
  const body = init?.body;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...(init as any), signal: controller.signal });
      const buf = await res.arrayBuffer();
      return {
        ok: res.ok,
        status: res.status,
        text: async () => Buffer.from(buf).toString("utf-8"),
        json: async () => JSON.parse(Buffer.from(buf).toString("utf-8")),
        arrayBuffer: async () => buf,
        headers: { get: (name: string) => res.headers.get(name) },
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    // The DNS error code can live in a few places depending on the runtime:
    //  - err.code / err.cause.code ("ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", ...)
    //  - the message string itself, e.g. "queryA ENODATA api-inference.huggingface.co"
    //    (Node's dns.resolve4 throws with the code embedded in the message).
    // We check both so the public-DNS fallback triggers reliably.
    const code = err?.cause?.code || err?.code || "";
    const msg = String(err?.message || "");
    const isDnsError =
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      code === "ETIMEDOUT" ||
      code === "ENODATA" ||
      /\b(ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENODATA|ESERVFAIL|EBADRESP)\b/.test(msg);

    if (!isDnsError) throw err;

    // Fall back to the public-DNS HTTPS client (handles both GET and POST).
    return requestViaPublicDns(url, method, headers, body, timeoutMs);
  }
};

// ---------------------------------------------------------------------------
// Helper: build a free image-generation URL using Pollinations.ai
// (no API key, no card required). Used only as a last-resort fallback if all
// Hugging Face image models fail (see generateImageWithHfFallback below).
// Docs: https://pollinations.ai
// ---------------------------------------------------------------------------
const buildPollinationsImageUrl = (prompt: string): string => {
  const encodedPrompt = encodeURIComponent(prompt);
  // random seed so repeated identical prompts don't return a cached/identical image
  const seed = Math.floor(Math.random() * 1_000_000);
  return `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&seed=${seed}&nologo=true&model=flux&enhance=true`;
};

// ---------------------------------------------------------------------------
// Hugging Face image generation via Inference Providers (router.huggingface.co).
// The "hf-inference" provider route accepts a POST with { inputs: prompt } and
// returns the raw image bytes directly (not JSON), same as the old Serverless
// Inference API did. We try a fallback chain of free/cheap models, same idea
// as the text generation chain above.
// Docs: https://huggingface.co/docs/inference-providers/en/tasks/text-to-image
// ---------------------------------------------------------------------------
const HF_IMAGE_ROUTER_URL = "https://router.huggingface.co/hf-inference/models/";

const HF_IMAGE_MODELS = [
  "black-forest-labs/FLUX.1-schnell",
  "black-forest-labs/FLUX.1-dev",
  "stabilityai/stable-diffusion-3.5-large-turbo",
];

const generateImageWithHfFallback = async (
  imagePrompt: string
): Promise<{ buffer: ArrayBuffer; mime: string } | null> => {
  const hfToken = process.env.HF_TOKEN;
  if (!hfToken) return null;

  for (const model of HF_IMAGE_MODELS) {
    try {
      const response = await fetchWithDnsFallback(
        `${HF_IMAGE_ROUTER_URL}${model}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${hfToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ inputs: imagePrompt }),
        },
        IMAGE_TIMEOUT_MS
      );

      if (!response.ok) {
        const errText = (await response.text()).slice(0, 300);
        throw new Error(`HF image model (${model}) returned ${response.status}: ${errText}`);
      }

      const mime = response.headers.get("content-type") || "image/jpeg";
      if (!mime.startsWith("image/")) {
        // Some providers return a JSON error body with a 200 status in edge cases
        // (e.g. model still loading) - guard against silently "succeeding" with junk.
        throw new Error(`HF image model (${model}) did not return image data (content-type: ${mime})`);
      }

      const buffer = await response.arrayBuffer();
      console.log(`Image generated using Hugging Face model: ${model}`);
      return { buffer, mime };
    } catch (err: any) {
      console.warn(`HF image model ${model} failed: ${err?.message || err}`);
    }
  }

  return null; // caller falls back to Pollinations
};

// ---------------------------------------------------------------------------
// Hugging Face model fallback chain for text generation.
// Uses the Hugging Face Inference API with the HF_TOKEN from server/.env.
// Each model is a free, open chat/instruct model. We try them in order and
// skip failures (model loading / not available) so the request keeps working.
// ---------------------------------------------------------------------------
const HF_MODELS = [
  "Qwen/Qwen2.5-72B-Instruct",
  "meta-llama/Llama-3.2-3B-Instruct",
  "mistralai/Mistral-7B-Instruct-v0.3",
  "microsoft/Phi-3.5-mini-instruct",
  "google/gemma-2-2b-it",
  "HuggingFaceH4/zephyr-7b-beta",
];

// NOTE: Hugging Face retired the old "api-inference.huggingface.co" Serverless
// Inference API. All new traffic goes through the Inference Providers router,
// which speaks the standard OpenAI-style Chat Completions format. Docs:
// https://huggingface.co/docs/inference-providers/index
const HF_ROUTER_URL = "https://router.huggingface.co/v1/chat/completions";

const buildHfSystemPrompt = (tone: string): string =>
  `You are an expert social media content creator. Generate a social media post based on the user's prompt and tone. Include relevant hashtags. Respond ONLY with valid JSON with "content" and "imagePrompt" fields, no markdown fences, no preamble. The "imagePrompt" should be a highly descriptive prompt for an image generator that complements the post. Tone: ${tone}.`;

// Try every model in the chain. We only throw after all models have failed,
// surfacing a clear, user-friendly error.
const generateWithHfFallback = async (prompt: string, tone: string): Promise<string> => {
  const hfToken = process.env.HF_TOKEN;
  if (!hfToken) {
    throw new Error("HF_TOKEN is missing. Please add it to your server/.env file.");
  }

  let lastError: any = null;

  for (const model of HF_MODELS) {
    try {
      const response = await fetchWithDnsFallback(
        HF_ROUTER_URL,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${hfToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model, // router auto-selects an available provider for this model
            messages: [
              { role: "system", content: buildHfSystemPrompt(tone) },
              { role: "user", content: prompt },
            ],
            max_tokens: 500,
            temperature: 0.8,
          }),
        },
        DEFAULT_TIMEOUT_MS
      );

      if (!response.ok) {
        const errText = (await response.text()).slice(0, 300);
        throw new Error(`Hugging Face (${model}) returned ${response.status}: ${errText}`);
      }

      const data = await response.json();
      // Chat Completions format: { choices: [{ message: { content: "..." } }] }
      const generated = data?.choices?.[0]?.message?.content;
      if (generated) {
        console.log(`Hugging Face post generated using model: ${model}`);
        return generated;
      }
      lastError = new Error(`Hugging Face (${model}) returned an empty response`);
    } catch (err: any) {
      console.warn(`Hugging Face model ${model} failed: ${err?.message || err}`);
      lastError = err;
    }
  }

  throw new Error(
    `AI generation is temporarily unavailable, please try again in a moment. (${
      lastError?.message || lastError
    })`
  );
};

// ---------------------------------------------------------------------------
// Generate post
// POST /api/posts/generate
// ---------------------------------------------------------------------------
export const generatePost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { prompt, tone, generateImage } = req.body;

    if (!prompt) {
      res.status(400).json({ message: "prompt is required" });
      return;
    }

    if (!process.env.HF_TOKEN) {
      res.status(400).json({
        message: "HF_TOKEN is missing. Please add it to your server/.env file.",
      });
      return;
    }

    // ---- 1. Generate text content + image prompt ----
    const rawText = await generateWithHfFallback(prompt, tone);

    let content = "";
    let imagePrompt = prompt;

    try {
      // Strip markdown code fences (```json ... ``` or ``` ... ```) that models
      // sometimes wrap the JSON in despite being told not to.
      const cleaned = rawText.replace(/```json|```/gi, "").trim();

      // Extract the JSON object by its outermost braces rather than a greedy
      // regex, so leading/trailing prose around the JSON doesn't break parsing.
      const firstBrace = cleaned.indexOf("{");
      const lastBrace = cleaned.lastIndexOf("}");
      const jsonSlice =
        firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace
          ? cleaned.slice(firstBrace, lastBrace + 1)
          : null;

      const data = jsonSlice ? JSON.parse(jsonSlice) : { content: rawText, imagePrompt: prompt };
      content = data.content || rawText;
      // Only fall back to the raw short user prompt if the model genuinely gave
      // us nothing usable — this is what was silently degrading image relevance.
      imagePrompt = data.imagePrompt || prompt;

      if (!jsonSlice) {
        console.warn("No JSON object found in Hugging Face response; using raw text + prompt as fallback.");
      }
    } catch (parseErr) {
      console.error("Failed to parse Hugging Face JSON response:", parseErr, "Raw text:", rawText.slice(0, 300));
      content = rawText;
    }

    // ---- 2. Optionally generate an image ----
    let mediaUrl = "";

    if (generateImage) {
      try {
        // Prefer Hugging Face's own image models (better quality/context-adherence
        // than Pollinations). Fall back to Pollinations only if all HF models fail,
        // so the feature still works even if HF's image quota/availability is down.
        const hfImage = await generateImageWithHfFallback(imagePrompt);

        let imageArrayBuffer: ArrayBuffer;
        let imageMime: string;
        let pollinationsUrl = "";

        if (hfImage) {
          imageArrayBuffer = hfImage.buffer;
          imageMime = hfImage.mime;
        } else {
          console.warn("All Hugging Face image models failed, falling back to Pollinations.");
          pollinationsUrl = buildPollinationsImageUrl(imagePrompt);
          const imageResp = await fetchWithDnsFallback(pollinationsUrl, { method: "GET" }, IMAGE_TIMEOUT_MS);
          if (!imageResp.ok) {
            throw new Error(`Pollinations fallback returned status ${imageResp.status}`);
          }
          imageArrayBuffer = await imageResp.arrayBuffer();
          imageMime = imageResp.headers.get("content-type") || "image/jpeg";
        }

        // Upload the image bytes to Zernio so the media URL is hosted by Zernio
        // (no Cloudinary dependency).
        try {
          const imageBlob = new Blob([new Uint8Array(imageArrayBuffer)], { type: imageMime });
          const uploadOptions: UploadMediaDirectData = {
            body: { file: imageBlob, contentType: imageMime },
          };
          const uploadResp = await zernio.messages.uploadMediaDirect(uploadOptions);
          const uploadData = (uploadResp.data as any) ?? {};
          // If Zernio doesn't return a URL and we used the Pollinations fallback,
          // we still have a valid public URL to fall back to.
          mediaUrl = uploadData.url || pollinationsUrl;
        } catch (uploadErr) {
          console.warn("Zernio upload failed for generated image:", uploadErr);
          // Only Pollinations gives us a directly-usable public URL as a fallback;
          // an HF-generated image with a failed upload has nowhere else to live.
          mediaUrl = pollinationsUrl;
        }
      } catch (err: any) {
        console.error("Image generation failed:", err?.message || err);
        // Text generation still succeeds even if the image fails.
      }
    }

    // ---- 3. Save generation to DB ----
    const generation = await Generation.create({
      user: req.user._id,
      prompt,
      content,
      mediaUrl,
      mediaType: mediaUrl ? "image" : undefined,
      tone,
    });

    res.json(generation);
  } catch (error: any) {
    console.error("generatePost error:", error?.response?.data || error?.message || error);
    // Surface the real, actionable error instead of a generic message.
    const errMsg = error?.message || error;
    res.status(500).json({ message: `Failed to generate post: ${errMsg}` });
  }
};

// Get generations
// GET /api/posts/generations
export const getGenerations = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const generations = await Generation.find({ user: req.user._id }).sort({ createdAt: -1 });
    res.json(generations);
  } catch (error: any) {
    res.status(500).json({ message: error?.message || "Server error" });
  }
};

// Get posts
// GET /api/posts
export const getPosts = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const posts = await Post.find({ user: req.user._id });
    res.json(posts);
  } catch (error: any) {
    res.status(500).json({ message: error?.message || "Server error" });
  }
};

// Schedule posts
// POST /api/posts
export const schedulePost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { content, platforms, scheduledFor, status } = req.body;

    // Parse platforms if it comes as a stringified array from FormData
    let parsedPlatforms = platforms;
    if (typeof platforms === "string") {
      try {
        parsedPlatforms = JSON.parse(platforms);
      } catch (e) {
        parsedPlatforms = platforms.split(",");
      }
    }
    let mediaUrl: string | undefined = req.body.mediaUrl;
    let mediaType: "image" | "video" | undefined = req.body.mediaType;

    if (req.file) {
      try {
        // Upload the media buffer directly to Zernio (no Cloudinary dependency).
        // Zernio returns a publicly accessible URL we can attach to the post.
        const uploadBody = new Blob([new Uint8Array(req.file.buffer)], {
          type: req.file.mimetype,
        });
        const uploadOptions: UploadMediaDirectData = {
          body: { file: uploadBody, contentType: req.file.mimetype },
        };
        const uploadResp = await zernio.messages.uploadMediaDirect(uploadOptions);
        const uploadData = (uploadResp.data as any) ?? {};
        mediaUrl = uploadData.url || "";
        mediaType = String(uploadData.contentType || req.file.mimetype).startsWith("video")
          ? "video"
          : "image";
      } catch (uploadErr: any) {
        // Surface the actual upload error rather than silently scheduling a post
        // with no media — an Instagram post without media will later fail to publish.
        const cErr = uploadErr?.message || uploadErr;
        console.warn("Media upload failed:", cErr);
        res.status(500).json({ message: `Media upload failed: ${cErr}` });
        return;
      }
    }

    // Instagram requires media (image/video). Reject scheduling an Instagram post
    // with no media up front so the user can fix it, instead of letting the post
    // silently fail to publish later.
    const instagramSelected = (Array.isArray(parsedPlatforms) ? parsedPlatforms : []).some(
      (p: string) => p.toLowerCase() === "instagram"
    );
    if (instagramSelected && !mediaUrl) {
      res.status(400).json({ message: "Instagram posts require an image or video. Please attach media." });
      return;
    }

    const post = await Post.create({
      user: req.user._id,
      content,
      platforms: parsedPlatforms,
      mediaUrl,
      mediaType,
      scheduledFor,
      status,
    });
    res.status(201).json(post);
  } catch (error: any) {
    res.status(500).json({ message: error?.message || "Server error" });
  }
};