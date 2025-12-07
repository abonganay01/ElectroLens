// api/electro-lookup.js

// Uses Node runtime (Vercel serverless / Node, NOT Edge)
import { GoogleGenerativeAI } from "@google/generative-ai";

// ---------------------------------------------------------
// Vercel / Next API config: disable automatic body parsing
// so we can manually read large base64 JSON bodies.
// ---------------------------------------------------------
export const config = {
  api: {
    bodyParser: false,
  },
};

// (optional, but helps in Next hybrids)
export const runtime = "nodejs";

// ========== Helpers: request body + image parsing ==========

async function readJsonBody(req) {
  // Hard limit ~8MB of JSON text
  const MAX_BYTES = 8 * 1024 * 1024;

  return await new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;

    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      data += chunk;
    });

    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
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

// Small helper to detect quota-ish HTTP statuses
function isQuotaStatus(status) {
  return status === 429 || status === 402 || status === 403;
}

// ========== Google Custom Search helpers ==========

async function googleImageSearch(query, quotaWarnings = []) {
  const apiKey = process.env.CSE_API_KEY;
  const cx = process.env.CSE_CX;
  if (!apiKey || !cx || !query) return null;

  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(
    query
  )}&searchType=image&num=1&safe=active&key=${apiKey}&cx=${cx}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error("Image search HTTP error (Google):", res.status);
      if (isQuotaStatus(res.status)) {
        quotaWarnings.push({
          source: "google_cse_images",
          status: res.status,
          message: "Google Custom Search image quota or billing limit reached.",
        });
      }
      return null;
    }
    const data = await res.json();
    return data.items?.[0]?.link || null;
  } catch (err) {
    console.error("Google image search error:", err);
    return null;
  }
}

// ========== Serper API helpers (images + datasheet fallback) ==========
// Docs: https://serper.dev

async function serperImageSearch(query, quotaWarnings = []) {
  const serperKey = process.env.SERPER_API_KEY;
  if (!serperKey || !query) return null;

  try {
    const res = await fetch("https://google.serper.dev/images", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": serperKey,
      },
      body: JSON.stringify({
        q: query,
        num: 1,
      }),
    });

    if (!res.ok) {
      console.error("Serper image search HTTP error:", res.status);
      if (isQuotaStatus(res.status)) {
        quotaWarnings.push({
          source: "serper_images",
          status: res.status,
          message: "Serper image search quota or billing limit reached.",
        });
      }
      return null;
    }

    const data = await res.json();
    const first = Array.isArray(data.images) ? data.images[0] : null;
    if (!first) return null;

    return first.imageUrl || first.thumbnailUrl || first.link || null;
  } catch (err) {
    console.error("Serper image search error:", err);
    return null;
  }
}

// unified helper: Google first, then Serper
async function smartImageSearch(query, quotaWarnings = []) {
  if (!query) return null;

  // Try Google CSE first
  let url = await googleImageSearch(query, quotaWarnings);
  if (url) return url;

  console.warn(
    "Google image search failed or quota exceeded – falling back to Serper."
  );
  url = await serperImageSearch(query, quotaWarnings);
  return url || null;
}

// Wrappers that keep your original function names
async function fetchRealImageFromGoogle(nameOrQuery, quotaWarnings = []) {
  return smartImageSearch(nameOrQuery, quotaWarnings);
}

async function fetchUsageImageFromGoogle(nameOrQuery, quotaWarnings = []) {
  // try to get an application / example circuit image
  const q = `${nameOrQuery} application circuit electronics example`;
  return smartImageSearch(q, quotaWarnings);
}

async function fetchPinoutImageFromGoogle(nameOrQuery, quotaWarnings = []) {
  // try to get a pinout diagram
  const q = `${nameOrQuery} pinout diagram`;
  return smartImageSearch(q, quotaWarnings);
}

// ---------- Datasheets & references: Google first, Serper fallback ----------

async function serperDatasheetSearch(query, quotaWarnings = []) {
  const serperKey = process.env.SERPER_API_KEY;
  if (!serperKey || !query) {
    return { datasheetUrl: null, references: [] };
  }

  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": serperKey,
      },
      body: JSON.stringify({
        q: `${query} datasheet pdf`,
        num: 5,
      }),
    });

    if (!res.ok) {
      console.error("Serper datasheet search HTTP error:", res.status);
      if (isQuotaStatus(res.status)) {
        quotaWarnings.push({
          source: "serper_search",
          status: res.status,
          message: "Serper search quota or billing limit reached.",
        });
      }
      return { datasheetUrl: null, references: [] };
    }

    const data = await res.json();
    const organic = Array.isArray(data.organic) ? data.organic : [];

    let datasheetUrl = null;
    const references = [];

    for (const item of organic) {
      const link = item.link || "";
      if (
        !datasheetUrl &&
        (link.endsWith(".pdf") || link.toLowerCase().includes("datasheet"))
      ) {
        datasheetUrl = link;
      }
      if (references.length < 4) {
        references.push({
          title: item.title || "",
          url: link,
          snippet: item.snippet || "",
        });
      }
    }

    return { datasheetUrl, references };
  } catch (err) {
    console.error("Serper datasheet search error:", err);
    return { datasheetUrl: null, references: [] };
  }
}

async function googleDatasheetAndReferences(name, quotaWarnings = []) {
  const apiKey = process.env.CSE_API_KEY;
  const cx = process.env.CSE_CX;
  if (!apiKey || !cx || !name) return { datasheetUrl: null, references: [] };

  const query = `${name} datasheet pdf`;
  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(
    query
  )}&num=5&safe=active&key=${apiKey}&cx=${cx}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error("Datasheet search HTTP error (Google):", res.status);
      if (isQuotaStatus(res.status)) {
        quotaWarnings.push({
          source: "google_cse_search",
          status: res.status,
          message: "Google Custom Search quota or billing limit reached.",
        });
      }
      return { datasheetUrl: null, references: [] };
    }
    const data = await res.json();

    let datasheetUrl = null;
    const references = [];

    for (const item of data.items || []) {
      const link = item.link || "";
      if (
        !datasheetUrl &&
        (link.endsWith(".pdf") || link.toLowerCase().includes("datasheet"))
      ) {
        datasheetUrl = link;
      }
      if (references.length < 4) {
        references.push({
          title: item.title || "",
          url: link,
          snippet: item.snippet || "",
        });
      }
    }

    return { datasheetUrl, references };
  } catch (err) {
    console.error("Datasheet search error:", err);
    return { datasheetUrl: null, references: [] };
  }
}

async function fetchDatasheetAndReferences(name, quotaWarnings = []) {
  if (!name) return { datasheetUrl: null, references: [] };

  // 1) Google CSE
  let { datasheetUrl, references } = await googleDatasheetAndReferences(
    name,
    quotaWarnings
  );

  const needsFallback =
    !datasheetUrl || !Array.isArray(references) || references.length === 0;

  if (!needsFallback) {
    return { datasheetUrl, references };
  }

  console.warn(
    "Google datasheet search insufficient – falling back to Serper for datasheet & references."
  );

  // 2) Serper fallback
  const serperResult = await serperDatasheetSearch(name, quotaWarnings);

  if (!datasheetUrl && serperResult.datasheetUrl) {
    datasheetUrl = serperResult.datasheetUrl;
  }

  if (!Array.isArray(references) || references.length === 0) {
    references = serperResult.references || [];
  }

  return { datasheetUrl, references };
}

// ========== Shop links ==========

function generateShopLinks(nameOrQuery) {
  const q = encodeURIComponent(nameOrQuery || "");
  return {
    shopee: `https://shopee.ph/search?keyword=${q}`,
    lazada: `https://www.lazada.com.ph/tag/${q}/`,
    amazon: `https://www.amazon.com/s?k=${q}`,
    aliexpress: `https://www.aliexpress.com/wholesale?SearchText=${q}`,
  };
}

// ========== Groq refinement: make it a real encyclopedia ==========

async function groqRefine(baseJson, quotaWarnings = []) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    console.log("⚠️ No GROQ_API_KEY → skipping Groq refinement.");
    return baseJson;
  }

  const systemPrompt = `
You are ElectroLens PRO, an engineering-grade electronics encyclopedia AI.

You receive a JSON object describing an electronics component, module, or tool.
Your job is to REWRITE and ENRICH that JSON with very complete, realistic information,
while keeping the SAME keys that already exist. Do not rename keys.

For each field:

- "name":
  • Keep it short but specific.
  • Include common designation if obvious (e.g. "ESP32 DevKit board", "LM7805 linear regulator TO-220").
  • Do not invent fake part numbers.

- "category":
  • Keep a broad label: "Component", "Microcontroller", "Module", "Tool", "Test Equipment", "Power Supply", "Other".

- "description":
  • Write 3–6 detailed paragraphs.
  • Cover:
    1) What type of device this is and its role in electronics.
    2) High-level principle of operation.
    3) Typical electrical characteristics (voltages, currents, logic levels, etc.).
    4) Common uses in real circuits or lab setups.
    5) Important limitations and design caveats (e.g. heat, noise, accuracy, switching limits).

- "typical_uses":
  • Provide 4–8 bullet points.
  • Each bullet should be a real, concrete application.

- "where_to_buy":
  • Provide 4–8 bullet points.
  • Include generic local shops, online marketplaces (Shopee, Lazada, Amazon, AliExpress),
    and professional distributors (Mouser, Digi-Key, RS, element14) where reasonable.

- "key_specs":
  • Provide 6–12 bullet points.
  • Include key voltages, currents, power ratings, tolerances, package type, input/output behavior, frequency range, etc.
  • If exact values are unknown, use typical ranges and clearly say "typically" or "commonly".

- "project_ideas":
  • Provide 3–6 student-friendly projects.
  • Explain how this component is used in each project.

- "common_mistakes":
  • Provide 5–10 realistic mistakes and warnings.
  • Mention why they are problems (overheating, incorrect biasing, wrong supply voltage, missing flyback diode, etc.).

- "datasheet_hint":
  • Give ONE realistic search string the user can paste into Google to find the official datasheet.

GENERAL:
- Do not contradict clear information already in the JSON.
- Never claim impossible or absurd electrical values.
- Return ONLY a valid JSON object. No markdown, no extra commentary, no code fences.
`;

  const body = {
    model: "mixtral-8x7b-32768",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(baseJson, null, 2) },
    ],
  };

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error("Groq HTTP error:", res.status, await res.text());
      if (isQuotaStatus(res.status)) {
        quotaWarnings.push({
          source: "groq_refine",
          status: res.status,
          message: "Groq refinement quota or billing limit reached.",
        });
      }
      return baseJson;
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) {
      console.log("⚠️ Groq empty content, falling back to baseJson.");
      return baseJson;
    }

    return JSON.parse(text);
  } catch (err) {
    console.error("Groq refinement failed:", err);
    return baseJson;
  }
}

// ========== DeepSeek refinement (encyclopedia-style) ==========

async function deepseekRefine(baseJson, quotaWarnings = []) {
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  if (!deepseekKey) {
    console.log("⚠️ No DEEPSEEK_API_KEY → skipping DeepSeek refinement.");
    return baseJson;
  }

  const systemPrompt = `
You are ElectroLens PRO (DeepSeek edition), an engineering-grade electronics encyclopedia AI.

You receive a JSON object describing an electronics component, module, or tool.
Your job is to REWRITE and ENRICH that JSON with very complete, realistic information,
while keeping the SAME keys that already exist. Do not rename keys.

Use the SAME JSON schema as the input:
- name, category, description, typical_uses, where_to_buy, key_specs,
  datasheet_hint, project_ideas, common_mistakes, plus any extra fields that
  might already exist (like real_image, usage_image, datasheet_url, references, shop_links).

Return ONLY a valid JSON object. No markdown, no extra commentary, no code fences.
`;

  const body = {
    model: "deepseek-chat",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(baseJson, null, 2) },
    ],
  };

  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deepseekKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error("DeepSeek refine HTTP error:", res.status, await res.text());
      if (isQuotaStatus(res.status)) {
        quotaWarnings.push({
          source: "deepseek_refine",
          status: res.status,
          message: "DeepSeek refinement quota or billing limit reached.",
        });
      }
      return baseJson;
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) {
      console.log("⚠️ DeepSeek refine empty content, falling back to baseJson.");
      return baseJson;
    }

    return JSON.parse(text);
  } catch (err) {
    console.error("DeepSeek refinement failed:", err);
    return baseJson;
  }
}

// ========== Groq text-only fallback / description ==========

async function groqDescribeFromText(queryText, quotaWarnings = []) {
  const groqKey = process.env.GROQ_API_KEY;
  const safeName = queryText || "Unknown electronics item";

  const fallbackJson = {
    name: safeName,
    category: "Other",
    description:
      "Text-only fallback entry. Either the primary model was unavailable " +
      "or Groq returned an error, so this is a minimal placeholder. " +
      "Use the datasheet and external links for exact specifications.",
    typical_uses: [],
    where_to_buy: [],
    key_specs: [],
    datasheet_hint: safeName
      ? `${safeName} datasheet pdf`
      : "electronics component datasheet pdf",
    project_ideas: [],
    common_mistakes: [],
    image_search_query: safeName || "electronics component",
  };

  if (!groqKey) {
    quotaWarnings.push({
      source: "groq_text_fallback",
      status: 500,
      message:
        "GROQ_API_KEY not set. Using simple text-only fallback for manual search.",
    });
    return fallbackJson;
  }

  const systemPrompt = `
You are ElectroLens, an assistant specialized ONLY in electronics-related items.

Return STRICT JSON ONLY in this shape:

{
  "name": "",
  "category": "",
  "description": "",
  "typical_uses": [],
  "where_to_buy": [],
  "key_specs": [],
  "datasheet_hint": "",
  "project_ideas": [],
  "common_mistakes": [],
  "image_search_query": ""
}

- "category": one of "Component", "Microcontroller", "Module", "Tool", "Test Equipment", "Power Supply", "Other".
- Do NOT include any extra fields or text outside the JSON.
`;

  const body = {
    model: "mixtral-8x7b-32768",
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `User typed query describing an electronics item: "${queryText}". Infer the most likely component/module/tool and fill the JSON.`,
      },
    ],
  };

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Groq text fallback HTTP error:", res.status, errText);
      if (isQuotaStatus(res.status)) {
        quotaWarnings.push({
          source: "groq_text_fallback",
          status: res.status,
          message:
            "Groq text-only quota or billing limit reached. Using simple fallback instead.",
        });
      } else {
        quotaWarnings.push({
          source: "groq_text_fallback",
          status: res.status,
          message:
            "Groq text-only returned HTTP " +
            res.status +
            ". Using simple fallback instead.",
        });
      }
      return fallbackJson;
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) {
      console.error("Groq text fallback returned empty content.");
      quotaWarnings.push({
        source: "groq_text_fallback",
        status: 500,
        message:
          "Groq text fallback returned empty content. Using simple fallback instead.",
      });
      return fallbackJson;
    }

    return JSON.parse(text);
  } catch (err) {
    console.error("Groq text fallback error:", err);
    quotaWarnings.push({
      source: "groq_text_fallback",
      status: 500,
      message:
        "Groq text fallback threw an error. Using simple fallback instead.",
    });
    return fallbackJson;
  }
}

// ========== DeepSeek text-only description ==========

async function deepseekDescribeFromText(queryText, quotaWarnings = []) {
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  const safeName = queryText || "Unknown electronics item";

  const fallbackJson = {
    name: safeName,
    category: "Other",
    description:
      "Text-only fallback entry. Either DeepSeek was unavailable " +
      "or returned an error, so this is a minimal placeholder. " +
      "Use the datasheet and external links for exact specifications.",
    typical_uses: [],
    where_to_buy: [],
    key_specs: [],
    datasheet_hint: safeName
      ? `${safeName} datasheet pdf`
      : "electronics component datasheet pdf",
    project_ideas: [],
    common_mistakes: [],
    image_search_query: safeName || "electronics component",
  };

  if (!deepseekKey) {
    quotaWarnings.push({
      source: "deepseek_text_fallback",
      status: 500,
      message:
        "DEEPSEEK_API_KEY not set. Using simple text-only fallback for manual search.",
    });
    return fallbackJson;
  }

  const systemPrompt = `
You are ElectroLens (DeepSeek), an assistant specialized ONLY in electronics-related items.

Return STRICT JSON ONLY in this exact shape:

{
  "name": "",
  "category": "",
  "description": "",
  "typical_uses": [],
  "where_to_buy": [],
  "key_specs": [],
  "datasheet_hint": "",
  "project_ideas": [],
  "common_mistakes": [],
  "image_search_query": ""
}

- "category": one of "Component", "Microcontroller", "Module", "Tool", "Test Equipment", "Power Supply", "Other".
- Do NOT include any extra fields or text outside the JSON.
`;

  const body = {
    model: "deepseek-chat",
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `User typed query describing an electronics item: "${queryText}". Infer the most likely component/module/tool and fill the JSON.`,
      },
    ],
  };

  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deepseekKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("DeepSeek text HTTP error:", res.status, errText);
      if (isQuotaStatus(res.status)) {
        quotaWarnings.push({
          source: "deepseek_text_fallback",
          status: res.status,
          message:
            "DeepSeek text quota or billing limit reached. Using simple fallback instead.",
        });
      } else {
        quotaWarnings.push({
          source: "deepseek_text_fallback",
          status: res.status,
          message:
            "DeepSeek text returned HTTP " +
            res.status +
            ". Using simple fallback instead.",
        });
      }
      return fallbackJson;
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) {
      console.error("DeepSeek text returned empty content.");
      quotaWarnings.push({
        source: "deepseek_text_fallback",
        status: 500,
        message:
          "DeepSeek text returned empty content. Using simple fallback instead.",
      });
      return fallbackJson;
    }

    return JSON.parse(text);
  } catch (err) {
    console.error("DeepSeek text error:", err);
    quotaWarnings.push({
      source: "deepseek_text_fallback",
      status: 500,
      message:
        "DeepSeek text threw an error. Using simple fallback instead.",
    });
    return fallbackJson;
  }
}

// ========== Main handler ==========

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Collect quota-related warnings here and return in meta.quotaWarnings
  const quotaWarnings = [];

  try {
    const body = await readJsonBody(req); // works for camera, upload, and type search
    const { image } = body || {};
    const rawQueryText =
      body && typeof body.queryText === "string" ? body.queryText : "";
    const safeQueryText = rawQueryText.trim();

    // preferredModel: "auto" | "gemini" | "groq" | "deepseek"
    const preferredRaw =
      body && typeof body.preferredModel === "string"
        ? body.preferredModel.toLowerCase()
        : "auto";
    const allowedModels = ["auto", "gemini", "groq", "deepseek"];
    let preferredModel = allowedModels.includes(preferredRaw)
      ? preferredRaw
      : "auto";
    let backendModel = preferredModel; // will update if we fall back

    if (!image && !safeQueryText) {
      return res.status(400).json({
        error: "Provide an image or queryText.",
        meta: { quotaWarnings, preferredModel: backendModel },
      });
    }

    const geminiKey = process.env.GOOGLE_API_KEY;

    let baseJson;

    // ========== 1. Get baseJson depending on mode & preferred model ==========

    if (image) {
      // ----- IMAGE MODE: Gemini Vision is required -----
      if (!geminiKey) {
        console.error("Missing GOOGLE_API_KEY for image mode");
        quotaWarnings.push({
          source: "gemini",
          status: 500,
          message:
            "GOOGLE_API_KEY is missing on the server. Image-based modes cannot run.",
        });
        return res.status(500).json({
          error:
            "Server misconfigured: GOOGLE_API_KEY missing. Camera and upload analysis require Gemini Vision.",
          meta: { quotaWarnings, preferredModel: backendModel },
        });
      }

      const genAI = new GoogleGenerativeAI(geminiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

      const basePrompt = `
You are ElectroLens, an assistant specialized ONLY in electronics-related items.

FOCUS ONLY on:
- Electronic components (resistors, capacitors, diodes, transistors, ICs, regulators, etc.)
- Microcontrollers / dev boards (ESP32, Arduino, STM32, etc.)
- Modules (sensor modules, relay modules, power modules, communication modules, etc.)
- Test equipment (multimeters, oscilloscopes, power supplies, etc.)
- Common electronics tools (soldering iron, breadboard, jumper wires, etc.)
- Consumer electronics devices (if clearly visible) but described from an electronics engineering perspective.

If the object is NOT electronics-related, treat it as "Other" and explain briefly.

Return STRICT JSON ONLY in this shape:

{
  "name": "",
  "category": "",
  "description": "",
  "typical_uses": [],
  "where_to_buy": [],
  "key_specs": [],
  "datasheet_hint": "",
  "project_ideas": [],
  "common_mistakes": [],
  "image_search_query": ""
}

- "name": short and specific.
- "category": one of "Component", "Microcontroller", "Module", "Tool", "Test Equipment", "Power Supply", "Other".
- "description": 1–3 paragraphs (base version, may be expanded later).
- "typical_uses": 2–5 short bullet ideas.
- "where_to_buy": 2–5 bullet ideas.
- "key_specs": 3–8 bullet specs.
- "datasheet_hint": what to search on Google to find the datasheet.
- "project_ideas": 2–4 very short project ideas.
- "common_mistakes": 3–6 short mistakes.
- "image_search_query": the best search phrase to find images of this exact device (e.g. "ESP32 DevKitC board", "LM7805 TO-220").
`;

      const parts = [{ text: basePrompt }];

      const extracted = extractBase64FromDataUrl(image);
      if (!extracted) {
        return res.status(400).json({
          error:
            "Image must be a base64 data URL like data:image/jpeg;base64,...",
          meta: { quotaWarnings, preferredModel: backendModel },
        });
      }
      parts.push({
        inlineData: {
          mimeType: extracted.mimeType,
          data: extracted.base64,
        },
      });
      if (safeQueryText) {
        parts.push({ text: `User text label: "${safeQueryText}"` });
      }

      try {
        const geminiResp = await model.generateContent({
          contents: [{ role: "user", parts }],
          generationConfig: { responseMimeType: "application/json" },
        });

        const rawText = geminiResp.response.text();
        baseJson = JSON.parse(rawText);
        // In image-mode, Gemini always does the first pass.
        // Refinement later will be chosen by backendModel.
      } catch (err) {
        const msg = String(err || "");
        const isQuotaError =
          msg.includes("429") ||
          msg.includes("You exceeded your current quota") ||
          msg.includes("Quota exceeded for metric");

        if (isQuotaError) {
          console.error("Gemini quota exceeded. Raw error:", msg);
          quotaWarnings.push({
            source: "gemini",
            status: 429,
            message:
              "Gemini free-tier quota exceeded for model gemini-2.5-flash. Image-based analysis may be unavailable.",
          });

          return res.status(429).json({
            error: "Gemini vision quota exceeded.",
            details:
              "Camera and upload analysis require Gemini (vision). Your free-tier Gemini quota is used up. Try again after the quota resets or upgrade your Gemini plan.",
            meta: { quotaWarnings, preferredModel: backendModel },
          });
        } else {
          console.error("Gemini error:", err);
          return res.status(500).json({
            error: "Failed to call Gemini generateContent for image.",
            details: msg,
            meta: { quotaWarnings, preferredModel: backendModel },
          });
        }
      }
    } else {
      // ----- TEXT-ONLY MODE -----
      if (preferredModel === "groq") {
        baseJson = await groqDescribeFromText(safeQueryText, quotaWarnings);
        backendModel = "groq";
      } else if (preferredModel === "deepseek") {
        baseJson = await deepseekDescribeFromText(safeQueryText, quotaWarnings);
        backendModel = "deepseek";
      } else {
        // auto or gemini → Gemini-first with Groq fallback
        if (!geminiKey) {
          quotaWarnings.push({
            source: "gemini",
            status: 500,
            message:
              "GOOGLE_API_KEY is missing. Falling back to Groq text-only description.",
          });
          baseJson = await groqDescribeFromText(safeQueryText, quotaWarnings);
          backendModel = "groq";
        } else {
          const genAI = new GoogleGenerativeAI(geminiKey);
          const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
          });

          const basePrompt = `
You are ElectroLens, an assistant specialized ONLY in electronics-related items.

FOCUS ONLY on electronics-related items. If the query is not electronics-related,
still return a JSON entry with category "Other" and explain briefly.

Return STRICT JSON ONLY in this shape:

{
  "name": "",
  "category": "",
  "description": "",
  "typical_uses": [],
  "where_to_buy": [],
  "key_specs": [],
  "datasheet_hint": "",
  "project_ideas": [],
  "common_mistakes": [],
  "image_search_query": ""
}

- "category": one of "Component", "Microcontroller", "Module", "Tool", "Test Equipment", "Power Supply", "Other".
- Do NOT include any extra fields or text outside the JSON.
`;

          const parts = [
            { text: basePrompt },
            { text: `User typed query: "${safeQueryText}"` },
          ];

          try {
            const geminiResp = await model.generateContent({
              contents: [{ role: "user", parts }],
              generationConfig: { responseMimeType: "application/json" },
            });

            const rawText = geminiResp.response.text();
            baseJson = JSON.parse(rawText);
            backendModel = preferredModel === "gemini" ? "gemini" : "auto";
          } catch (err) {
            const msg = String(err || "");
            const isQuotaError =
              msg.includes("429") ||
              msg.includes("You exceeded your current quota") ||
              msg.includes("Quota exceeded for metric");

            if (isQuotaError) {
              console.error("Gemini quota exceeded (text-only):", msg);
              quotaWarnings.push({
                source: "gemini",
                status: 429,
                message:
                  "Gemini free-tier quota exceeded for text. Falling back to Groq text description.",
              });

              baseJson = await groqDescribeFromText(
                safeQueryText,
                quotaWarnings
              );
              backendModel = "groq";
            } else {
              console.error("Gemini text error:", err);
              return res.status(500).json({
                error: "Failed to call Gemini generateContent for text.",
                details: msg,
                meta: { quotaWarnings, preferredModel: backendModel },
              });
            }
          }
        }
      }
    }

    // ========== 2. Web-based images & datasheets, driven by the model's guess ==========

    const nameOrQuery =
      baseJson.image_search_query ||
      baseJson.name ||
      safeQueryText ||
      "electronics component";

    // Images via Google CSE + Serper fallback
    baseJson.real_image = await fetchRealImageFromGoogle(
      nameOrQuery,
      quotaWarnings
    );
    baseJson.usage_image = await fetchUsageImageFromGoogle(
      nameOrQuery,
      quotaWarnings
    );
    baseJson.pinout_image = await fetchPinoutImageFromGoogle(
      nameOrQuery,
      quotaWarnings
    );

    // Datasheet + references (Google first, Serper fallback)
    const ds = await fetchDatasheetAndReferences(
      baseJson.name || safeQueryText || "",
      quotaWarnings
    );
    baseJson.datasheet_url = ds.datasheetUrl;
    baseJson.references = ds.references;

    // Shop links (template)
    baseJson.shop_links = generateShopLinks(
      baseJson.name || safeQueryText || "electronics"
    );

    // ========== 3. Model-specific refinement (encyclopedia text) ==========

    let refined = baseJson;

    if (backendModel === "deepseek") {
      refined = await deepseekRefine(baseJson, quotaWarnings);
    } else if (backendModel === "groq" || backendModel === "auto") {
      refined = await groqRefine(baseJson, quotaWarnings);
    } else if (backendModel === "gemini") {
      // Gemini-only: keep baseJson as-is
      refined = baseJson;
    }

    // Preserve server-generated URLs & links even if refined object drops them
    const finalJson = {
      ...refined,
      real_image: baseJson.real_image,
      usage_image: baseJson.usage_image,
      pinout_image: baseJson.pinout_image,
      datasheet_url: baseJson.datasheet_url,
      references: baseJson.references,
      shop_links: baseJson.shop_links,
      meta: {
        quotaWarnings,
        preferredModel: backendModel,
      },
    };

    if (baseJson.official_store && !finalJson.official_store) {
      finalJson.official_store = baseJson.official_store;
    }

    return res.status(200).json(finalJson);
  } catch (err) {
    console.error("Error in /api/electro-lookup:", err);
    return res.status(500).json({
      error: "Internal server error in electro-lookup.",
      details: err.message || String(err),
      meta: { quotaWarnings },
    });
  }
}
