// api/electro-lookup.js

// Node runtime (Vercel Node, not Edge)
import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";

export const config = {
  api: { bodyParser: false },
};

export const runtime = "nodejs";

// ===========================
// Helpers: request body
// ===========================
async function readJsonBody(req) {
  const MAX_BYTES = 8 * 1024 * 1024;

  return await new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;

    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        reject(new Error("Request body too large (limit: 8MB)"));
        req.destroy();
        return;
      }
      data += chunk;
    });

    req.on("end", () => {
      try {
        const contentType = req.headers["content-type"] || "";
        const isJson = contentType.includes("application/json");
        resolve(isJson && data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });

    req.on("error", reject);
  });
}

function extractBase64FromDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return null;
  }
  const match = dataUrl.match(/^data:(.+);base64,(.*)$/);
  if (!match) return null;
  return { mimeType: match[1], base64: match[2] };
}

// ===========================
// Shared prompts
// ===========================

const ELECTROLENS_SCHEMA_PROMPT = `
You are ElectroLens, an assistant specialized ONLY in electronics.

You must ALWAYS answer with strict JSON only (no extra text), with this exact structure:

{
  "name": "Specific Part Name",
  "category": "Category",
  "description": "Brief description",
  "typical_uses": [],
  "where_to_buy": [],
  "key_specs": [],
  "datasheet_hint": "",
  "project_ideas": [],
  "common_mistakes": [],
  "image_search_query": "",
  "schematic_tips": [],
  "alternatives": [],
  "code_snippet": ""
}

Rules:
- If the object is clearly NOT electronics, set "category" = "Other".
- Use best technical knowledge. If unsure, make a reasonable guess but stay plausible.
- Output MUST be valid JSON, no markdown fences.
`;

function buildTextOnlyUserPrompt(queryText, hasImage) {
  const q = (queryText || "").trim();

  if (hasImage && q) {
    return `
The user uploaded a photo of an electronics component (you CANNOT see the image here)
and also typed this label or name:

"${q}"

Based ONLY on this label and your electronics knowledge, fill the JSON schema.
If it is not clearly electronics, use category "Other".
`;
  }

  if (hasImage && !q) {
    return `
The user uploaded a photo of an electronics component (you CANNOT see the image).
You don't have any text label. Make a reasonable guess about a generic electronics part
and fill the JSON schema. If unsure, set category "Other".
`;
  }

  // No image, only text query
  return `
User typed this query about an electronics part:

"${q}"

Use this to fill the JSON schema. If not clearly electronics, set category "Other".
`;
}

// ===========================
// Fallback LLMs (DeepSeek, Groq)
// ===========================

async function callDeepSeek(hasImage, safeQueryText) {
  const deepSeekKey = process.env.DEEPSEEK_API_KEY;
  if (!deepSeekKey) {
    console.warn("⚠️ DEEPSEEK_API_KEY missing, skipping DeepSeek.");
    return null;
  }

  const url = "https://api.deepseek.com/chat/completions";
  const userPrompt = buildTextOnlyUserPrompt(safeQueryText, hasImage);

  const body = {
    model: "deepseek-chat",
    messages: [
      { role: "system", content: ELECTROLENS_SCHEMA_PROMPT },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deepSeekKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error("DeepSeek HTTP error:", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) return null;

    const jsonString = text.replace(/```json\n?|```/g, "").trim();
    const parsed = JSON.parse(jsonString);
    parsed._provider = "deepseek";
    return parsed;
  } catch (err) {
    console.error("DeepSeek failed:", err);
    return null;
  }
}

async function callGroq(hasImage, safeQueryText) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    console.warn("⚠️ GROQ_API_KEY missing, skipping Groq.");
    return null;
  }

  const url = "https://api.groq.com/openai/v1/chat/completions";
  const userPrompt = buildTextOnlyUserPrompt(safeQueryText, hasImage);

  const body = {
    model: "mixtral-8x7b-32768",
    messages: [
      { role: "system", content: ELECTROLENS_SCHEMA_PROMPT },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error("Groq HTTP error:", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) return null;

    const jsonString = text.replace(/```json\n?|```/g, "").trim();
    const parsed = JSON.parse(jsonString);
    parsed._provider = "groq";
    return parsed;
  } catch (err) {
    console.error("Groq failed:", err);
    return null;
  }
}

// Try DeepSeek then Groq
async function getFallbackJson(hasImage, safeQueryText) {
  const ds = await callDeepSeek(hasImage, safeQueryText);
  if (ds) return ds;

  const gr = await callGroq(hasImage, safeQueryText);
  if (gr) return gr;

  return null;
}

// ===========================
// Search helpers (CSE + Serper)
// ===========================

async function serperImageSearch(query) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey || !query) return null;

  try {
    const res = await fetch("https://google.serper.dev/images", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({ q: query, num: 1 }),
    });

    if (!res.ok) {
      console.error("Serper image HTTP error:", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const img = data.images?.[0];
    return img?.imageUrl || img?.thumbnailUrl || null;
  } catch (err) {
    console.error("Serper image search error:", err);
    return null;
  }
}

async function googleImageSearch(query) {
  if (!query) return null;

  const apiKey = process.env.CSE_API_KEY;
  const cx = process.env.CSE_CX;

  // Primary: Google CSE
  if (apiKey && cx) {
    const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(
      query
    )}&searchType=image&num=1&key=${apiKey}&cx=${cx}`;

    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const link = data.items?.[0]?.link;
        if (link) return link;
      } else {
        console.error("CSE image HTTP error:", res.status);
      }
    } catch (err) {
      console.error("CSE image search error:", err);
    }
  }

  // Fallback: Serper
  return serperImageSearch(query);
}

async function fetchRealImageFromGoogle(q) {
  return googleImageSearch(q);
}
async function fetchUsageImageFromGoogle(q) {
  return googleImageSearch(`${q} application circuit schematic wiring diagram`);
}
async function fetchPinoutImageFromGoogle(q) {
  return googleImageSearch(`${q} pinout diagram`);
}

async function serperDatasheetSearch(name) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey || !name) return { datasheetUrl: null, references: [] };

  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({ q: `${name} datasheet pdf`, num: 5 }),
    });

    if (!res.ok) {
      console.error("Serper datasheet HTTP error:", res.status, await res.text());
      return { datasheetUrl: null, references: [] };
    }

    const data = await res.json();
    const organic = data.organic || [];

    let datasheetUrl = null;
    const references = [];

    for (const item of organic) {
      const link = item.link || item.url || "";
      if (!datasheetUrl && (link.endsWith(".pdf") || link.toLowerCase().includes("datasheet"))) {
        datasheetUrl = link;
      }
      if (references.length < 5) {
        references.push({
          title: item.title || "",
          url: link,
          snippet: item.snippet || item.description || "",
        });
      }
    }

    return { datasheetUrl, references };
  } catch (err) {
    console.error("Serper datasheet search error:", err);
    return { datasheetUrl: null, references: [] };
  }
}

async function fetchDatasheetAndReferences(name) {
  if (!name) return { datasheetUrl: null, references: [] };

  const apiKey = process.env.CSE_API_KEY;
  const cx = process.env.CSE_CX;

  // Primary: Google CSE
  if (apiKey && cx) {
    const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(
      name + " datasheet pdf"
    )}&num=5&key=${apiKey}&cx=${cx}`;

    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        let datasheetUrl = null;
        const references = [];

        for (const item of data.items || []) {
          const link = item.link || "";
          if (!datasheetUrl && (link.endsWith(".pdf") || link.toLowerCase().includes("datasheet"))) {
            datasheetUrl = link;
          }
          if (references.length < 5) {
            references.push({
              title: item.title || "",
              url: link,
              snippet: item.snippet || "",
            });
          }
        }

        return { datasheetUrl, references };
      } else {
        console.error("CSE datasheet HTTP error:", res.status);
      }
    } catch (err) {
      console.error("CSE datasheet search error:", err);
    }
  }

  // Fallback: Serper
  return serperDatasheetSearch(name);
}

function generateShopLinks(nameOrQuery) {
  const q = encodeURIComponent(nameOrQuery || "");
  return {
    shopee: `https://shopee.ph/search?keyword=${q}`,
    lazada: `https://www.lazada.com.ph/tag/${q}/`,
    amazon: `https://www.amazon.com/s?k=${q}`,
    aliexpress: `https://www.aliexpress.com/wholesale?SearchText=${q}`,
  };
}

// ===========================
// MAIN HANDLER
// ===========================
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = await readJsonBody(req);
    const { image } = body || {};
    const rawQueryText =
      body && typeof body.queryText === "string" ? body.queryText : "";
    const safeQueryText = rawQueryText.trim();

    if (!image && !safeQueryText) {
      return res.status(400).json({ error: "Provide an image or queryText." });
    }

    // ===== 1) Try GEMINI (primary, can see image) =====
    let baseJson = null;
    let provider = null;

    try {
      const geminiKey = process.env.GOOGLE_API_KEY;
      if (!geminiKey) {
        console.warn("⚠️ GOOGLE_API_KEY missing, skipping Gemini.");
      } else {
        const genAI = new GoogleGenerativeAI(geminiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const parts = [{ text: ELECTROLENS_SCHEMA_PROMPT }];

        if (image) {
          const extracted = extractBase64FromDataUrl(image);
          if (!extracted) {
            console.warn("⚠️ Invalid base64 image format, Gemini will ignore image.");
          } else {
            parts.push({
              inlineData: {
                mimeType: extracted.mimeType,
                data: extracted.base64,
              },
            });
          }

          if (safeQueryText) {
            parts.push({ text: `User text label: "${safeQueryText}"` });
          }
        } else {
          parts.push({ text: `User typed query: "${safeQueryText}"` });
        }

        const geminiResp = await model.generateContent({
          contents: [{ role: "user", parts }],
          generationConfig: { responseMimeType: "application/json" },
        });

        // NOTE: this matches your previous working code style
        const raw = geminiResp.response.text;
        const jsonString = raw.replace(/```json\n?|```/g, "").trim();
        baseJson = JSON.parse(jsonString);
        provider = "gemini";
      }
    } catch (err) {
      console.error("Gemini failed, will try fallback models:", err);
      baseJson = null;
    }

    // ===== 2) Fallback → DeepSeek then Groq (text only) =====
    if (!baseJson) {
      const fb = await getFallbackJson(!!image, safeQueryText);
      if (!fb) {
        return res.status(500).json({
          error: "All AI providers failed to return valid JSON.",
        });
      }
      baseJson = fb;
      provider = baseJson._provider || "fallback";
    }

    baseJson._provider = provider; // keep track of which model was used

    const nameOrQuery =
      baseJson.image_search_query ||
      baseJson.name ||
      safeQueryText ||
      "electronics component";

    // ===== Image searches (CSE → Serper) =====
    const [realImage, usageImage, pinoutImage] = await Promise.all([
      fetchRealImageFromGoogle(nameOrQuery),
      fetchUsageImageFromGoogle(nameOrQuery),
      fetchPinoutImageFromGoogle(nameOrQuery),
    ]);

    baseJson.real_image = realImage;
    baseJson.usage_image = usageImage;
    baseJson.pinout_image = pinoutImage;

    // ===== Datasheet + references (CSE → Serper) =====
    const ds = await fetchDatasheetAndReferences(
      baseJson.name || safeQueryText || ""
    );
    baseJson.datasheet_url = ds.datasheetUrl;
    baseJson.references = ds.references;

    // ===== Shop links =====
    baseJson.shop_links = generateShopLinks(
      baseJson.name || safeQueryText || "electronics"
    );

    return res.status(200).json(baseJson);
  } catch (err) {
    console.error("Error in /api/electro-lookup:", err);
    return res.status(500).json({
      error: "Internal server error.",
      details: err.message || String(err),
    });
  }
}
