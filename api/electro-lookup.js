// api/electro-lookup.js

// Uses Node runtime (Vercel serverless / Node, NOT Edge)
import { GoogleGenerativeAI } from "@google/generative-ai";

export const config = {
  api: {
    bodyParser: false,
  },
};

export const runtime = "nodejs";

// ========== Helpers: request body + image parsing ==========

async function readJsonBody(req) {
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
        // Fix: Added check for 'application/json' in header for proper parsing
        const isJson = req.headers['content-type'] && req.headers['content-type'].includes('application/json');
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

function isQuotaStatus(status) {
  return status === 429 || status === 402 || status === 403;
}

// ========== UNIVERSAL DETAILED PROMPT (USED BY ALL MODELS) ==========

const ELECTROLENS_SCHEMA_PROMPT = `
You are ElectroLens PRO, an engineering-grade electronics encyclopedia AI.

You must RETURN STRICT JSON ONLY with this exact schema:

{
  "name": "",
  "category": "",
  "description": "",
  "typical_uses": [],
  "where_to_buy": [],
  "key_specs": [],
  "project_ideas": [],
  "common_mistakes": [],
  "datasheet_hint": "",
  "image_search_query": ""
}

DETAILED RULES:

- "name":
  • Short but specific, e.g. "ESP32 DevKitC development board", "LM7805 linear regulator TO-220".
  • Do not invent fake part numbers.

- "category":
  • One of: "Component", "Microcontroller", "Module", "Tool", "Test Equipment", "Power Supply", "Other".

- "description":
  • 3–6 detailed paragraphs.
  • Cover:
    1) What this device is and what it’s used for.
    2) High-level principle of operation.
    3) Typical electrical characteristics (voltages, currents, logic levels, etc.).
    4) Typical use cases in real circuits or lab setups.
    5) Important limitations and design caveats (heat, noise, switching speed, accuracy, etc.).

- "typical_uses":
  • 4–8 bullet-style strings.
  • Each one is a clear, concrete application or use case.

- "where_to_buy":
  • 4–8 bullet-style strings.
  • Mention generic local shops, online marketplaces (Shopee, Lazada, Amazon, AliExpress),
    and professional distributors (Mouser, Digi-Key, RS, element14) if appropriate.

- "key_specs":
  • 6–12 bullet-style strings.
  • Include key voltages, currents, power rating, frequency range, tolerances, package type, etc.
  • If exact values are unknown, use realistic typical ranges and say “typically” or “commonly”.

- "project_ideas":
  • 3–6 student-friendly project ideas.
  • Each describes how this device is used in the project.

- "common_mistakes":
  • 5–10 realistic mistakes or warnings (wrong supply voltage, missing flyback diode, wrong pinout, insufficient heatsinking, etc.).

- "datasheet_hint":
  • ONE realistic search string the user can paste into Google to find the official datasheet.

- "image_search_query":
  • A phrase to find good images of this exact device.
  • Example: "ESP32 DevKitC board", "LM7805 TO-220 pinout".

GENERAL RULES:
- FOCUS ONLY on electronics-related items. If the query is not electronics-related, set "category": "Other" and explain briefly.
- ALWAYS fill every field with meaningful content. Do NOT return empty arrays unless the item is truly unknown.
- RETURN PURE JSON ONLY. No markdown, no explanation sentences, no extra keys.
`;

// ========== Google Custom Search helpers ==========

async function googleImageSearch(query, quotaWarnings = []) {
  const apiKey = process.env.CSE_API_KEY;
  const cx = process.env.CSE_CX;
  if (!apiKey || !cx || !query) return null;

  // Fix: Removed unnecessary 'safe=active' parameter as it's not standard for all search types/APIs
  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(
    query
  )}&searchType=image&num=1&key=${apiKey}&cx=${cx}`;

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

// ========== Serper (images + datasheet search fallback) ==========

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

async function smartImageSearch(query, quotaWarnings = []) {
  if (!query) return null;

  let url = await googleImageSearch(query, quotaWarnings);
  if (url) return url;

  console.warn(
    "Google image search failed or quota exceeded – falling back to Serper."
  );
  url = await serperImageSearch(query, quotaWarnings);
  return url || null;
}

async function fetchRealImageFromGoogle(nameOrQuery, quotaWarnings = []) {
  return smartImageSearch(nameOrQuery, quotaWarnings);
}

async function fetchUsageImageFromGoogle(nameOrQuery, quotaWarnings = []) {
  const q = `${nameOrQuery} application circuit electronics example`;
  return smartImageSearch(q, quotaWarnings);
}

async function fetchPinoutImageFromGoogle(nameOrQuery, quotaWarnings = []) {
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
  // Fix: Removed unnecessary 'safe=active' parameter as it's not standard for all search types/APIs
  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(
    query
  )}&num=5&key=${apiKey}&cx=${cx}`;

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

    // CRITICAL FIX: The Google Custom Search API returns an `error` property
    // on the main response object if the query fails (e.g., missing API key or
    // quota limits), but also sometimes returns an empty `data.items` array
    // without an HTTP error code. We must check for `data.error` to avoid
    // crashing on a non-existent `data.items` array.
    if (data.error) {
      console.error("Datasheet search API error (Google):", data.error);
      return { datasheetUrl: null, references: [] };
    }

    let datasheetUrl = null;
    const references = [];

    // FIX: Ensure `data.items` is an array before iterating.
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

  const serperResult = await serperDatasheetSearch(name, quotaWarnings);

  if (!datasheetUrl && serperResult.datasheetUrl) {
    datasheetUrl = serperResult.datasheetUrl;
  }

  // FIX: Ensure 'references' is an array before checking length and assigning fallback
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

// ========== MODEL CALL HELPERS (NO REFINEMENT STEP) ==========

// Gemini: text or image
async function useGemini(safeQueryText, image, quotaWarnings) {
  const geminiKey = process.env.GOOGLE_API_KEY;
  if (!geminiKey) return null;

  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const parts = [{ text: ELECTROLENS_SCHEMA_PROMPT }];

    if (image) {
      parts.push({
        inlineData: {
          mimeType: image.mimeType,
          data: image.base64,
        },
      });
      if (safeQueryText) {
        parts.push({ text: `User label or part number: "${safeQueryText}"` });
      }
    } else {
      parts.push({ text: `User typed query: "${safeQueryText}"` });
    }

    const resp = await model.generateContent({
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json" },
    });
    
    // FIX: Safely parse JSON and handle models that might wrap JSON in markdown
    const jsonString = resp.response.text.replace(/```json\n?|```/g, '').trim();
    return JSON.parse(jsonString);

  } catch (err) {
    console.error("Gemini error:", err);
    quotaWarnings.push({
      source: "gemini",
      status: 500,
      message: String(err),
    });
    return null;
  }
}

// Groq text-only
async function useGroq(safeQueryText, quotaWarnings) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return null;

  const body = {
    model: "mixtral-8x7b-32768",
    messages: [
      { role: "system", content: ELECTROLENS_SCHEMA_PROMPT },
      {
        role: "user",
        content: `User typed query describing an electronics item: "${safeQueryText}". Generate the JSON.`,
      },
    ],
    // FIX: Add response_format for strict JSON output
    response_format: { type: "json_object" }
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
      const txt = await res.text();
      console.error("Groq HTTP error:", res.status, txt);
      quotaWarnings.push({
        source: "groq",
        status: res.status,
        message: txt,
      });
      return null;
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) return null;

    // FIX: Safely parse JSON and handle models that might wrap JSON in markdown
    const jsonString = text.replace(/```json\n?|```/g, '').trim();
    return JSON.parse(jsonString);
  } catch (err) {
    console.error("Groq error:", err);
    quotaWarnings.push({
      source: "groq",
      status: 500,
      message: String(err),
    });
    return null;
  }
}

// DeepSeek text-only
async function useDeepSeek(safeQueryText, quotaWarnings) {
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  if (!deepseekKey) return null;

  const body = {
    model: "deepseek-chat",
    messages: [
      { role: "system", content: ELECTROLENS_SCHEMA_PROMPT },
      {
        role: "user",
        content: `User typed query describing an electronics item: "${safeQueryText}". Generate the JSON.`,
      },
    ],
    // FIX: Add response_format for strict JSON output (assuming DeepSeek supports this OpenAI-style parameter)
    response_format: { type: "json_object" }
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
      const txt = await res.text();
      console.error("DeepSeek HTTP error:", res.status, txt);
      quotaWarnings.push({
        source: "deepseek",
        status: res.status,
        message: txt,
      });
      return null;
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) return null;

    // FIX: Safely parse JSON and handle models that might wrap JSON in markdown
    const jsonString = text.replace(/```json\n?|```/g, '').trim();
    return JSON.parse(jsonString);
  } catch (err) {
    console.error("DeepSeek error:", err);
    quotaWarnings.push({
      source: "deepseek",
      status: 500,
      message: String(err),
    });
    return null;
  }
}

// Ensure fields exist and are non-empty with at least generic text.
function normalizeAndFill(json, safeName) {
  // Use a temporary object to ensure all required fields are present
  // and avoid potential issues if the LLM returned a non-object or missing keys
  const normalized = {
      name: json.name || safeName || "Unknown electronics item",
      category: json.category || "Other",
      description: json.description || "",
      typical_uses: Array.isArray(json.typical_uses) ? json.typical_uses : [],
      where_to_buy: Array.isArray(json.where_to_buy) ? json.where_to_buy : [],
      key_specs: Array.isArray(json.key_specs) ? json.key_specs : [],
      project_ideas: Array.isArray(json.project_ideas) ? json.project_ideas : [],
      common_mistakes: Array.isArray(json.common_mistakes) ? json.common_mistakes : [],
      datasheet_hint: json.datasheet_hint || "",
      image_search_query: json.image_search_query || "",
      datasheet_url: json.datasheet_url || null, // Keep datasheet and references if they were passed in
      references: Array.isArray(json.references) ? json.references : [],
      shop_links: json.shop_links || {}, // Same for shop links
  };

  if (!normalized.description.trim()) {
    normalized.description =
      "Auto-generated encyclopedia entry for this electronics-related item. " +
      "For exact electrical ratings, pinouts, and timing, always confirm with the official datasheet.";
  }

  function ensureList(key, fallback) {
    if (normalized[key].length === 0) {
      normalized[key] = [fallback];
    }
  }

  ensureList(
    "typical_uses",
    "Typical applications depend on the exact variant; see the description and datasheet for detailed use cases."
  );
  ensureList(
    "where_to_buy",
    "Available from common electronics suppliers, local electronics shops, and online marketplaces such as Shopee, Lazada, Amazon, or AliExpress."
  );
  ensureList(
    "key_specs",
    "Key electrical specifications should be taken from the official datasheet for the specific part number."
  );
  ensureList(
    "project_ideas",
    "Use this device in a small lab project or prototype to learn its behavior before integrating it into a larger system."
  );
  ensureList(
    "common_mistakes",
    "Using this device without checking the datasheet for voltage, current, and pinout limits can damage both the device and the rest of the circuit."
  );

  if (!normalized.datasheet_hint.trim()) {
    normalized.datasheet_hint = `${normalized.name} datasheet pdf`;
  }
  if (!normalized.image_search_query.trim()) {
    normalized.image_search_query = normalized.name;
  }

  return normalized;
}

// ========== Main handler ==========

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const quotaWarnings = [];

  try {
    const body = await readJsonBody(req);
    const { image } = body || {};
    const rawQueryText =
      body && typeof body.queryText === "string" ? body.queryText : "";
    const safeQueryText = rawQueryText.trim();

    if (!image && !safeQueryText) {
      return res.status(400).json({
        error: "Provide an image or queryText.",
        meta: { quotaWarnings, preferredModel: "fallback" },
      });
    }

    let baseJson = null;
    let preferredModel = "fallback";

    // 1) Try Gemini (handles BOTH image + text, or text-only)
    let imagePayload = null;
    if (image) {
      const extracted = extractBase64FromDataUrl(image);
      if (!extracted) {
        return res.status(400).json({
          error:
            "Image must be a base64 data URL like data:image/jpeg;base64,...",
          meta: { quotaWarnings, preferredModel: "fallback" },
        });
      }
      imagePayload = { mimeType: extracted.mimeType, base64: extracted.base64 };
    }

    // FIX: Added a more robust check for a valid JSON object return from the LLM
    const getValidJson = (json) => typeof json === 'object' && json !== null && json.name;

    baseJson = await useGemini(safeQueryText, imagePayload, quotaWarnings);
    if (getValidJson(baseJson)) {
        preferredModel = "gemini";
    } else {
        baseJson = null; // Discard invalid or null response
    }

    // 2) If Gemini failed (or not configured) and this is TEXT mode, try Groq
    if (!baseJson && !image) {
      baseJson = await useGroq(safeQueryText, quotaWarnings);
      if (getValidJson(baseJson)) {
          preferredModel = "groq";
      } else {
          baseJson = null; // Discard invalid or null response
      }
    }

    // 3) If still nothing and TEXT mode, try DeepSeek
    if (!baseJson && !image) {
      baseJson = await useDeepSeek(safeQueryText, quotaWarnings);
      if (getValidJson(baseJson)) {
          preferredModel = "deepseek";
      } else {
          baseJson = null; // Discard invalid or null response
      }
    }

    // 4) Final fallback if absolutely nothing came back
    if (!baseJson) {
      const safeName = safeQueryText || "Unknown electronics item";
      baseJson = {
        name: safeName,
        category: "Other",
        description:
          "Basic auto-generated entry. No AI model was available on the server. " +
          "Configure at least one provider (Gemini, Groq, or DeepSeek) for richer content.",
        typical_uses: [],
        where_to_buy: [],
        key_specs: [],
        datasheet_hint: `${safeName} datasheet pdf`,
        project_ideas: [],
        common_mistakes: [],
        image_search_query: safeName,
      };
      preferredModel = "fallback";
    }

    // Make sure everything has content
    // Note: The normalizeAndFill function now correctly handles filling missing fields
    // without expecting pre-filled image/datasheet/shop-link fields.
    baseJson = normalizeAndFill(baseJson, safeQueryText);

    // ========== 2. Web-based images & datasheets ==========

    const nameOrQuery =
      baseJson.image_search_query ||
      baseJson.name ||
      safeQueryText ||
      "electronics component";

    // Await all image fetches concurrently for speed
    const [realImage, usageImage, pinoutImage] = await Promise.all([
        fetchRealImageFromGoogle(nameOrQuery, quotaWarnings),
        fetchUsageImageFromGoogle(nameOrQuery, quotaWarnings),
        fetchPinoutImageFromGoogle(nameOrQuery, quotaWarnings),
    ]);
    
    baseJson.real_image = realImage;
    baseJson.usage_image = usageImage;
    baseJson.pinout_image = pinoutImage;


    const ds = await fetchDatasheetAndReferences(
      baseJson.name || safeQueryText || "",
      quotaWarnings
    );
    baseJson.datasheet_url = ds.datasheetUrl;
    baseJson.references = ds.references;

    baseJson.shop_links = generateShopLinks(
      baseJson.name || safeQueryText || "electronics"
    );

    // No refinement step. Just return what we have.
    const finalJson = {
      ...baseJson,
      meta: {
        quotaWarnings,
        preferredModel,
      },
    };

    return res.status(200).json(finalJson);
  } catch (err) {
    console.error("Error in /api/electro-lookup:", err);
    return res.status(500).json({
      error: "Internal server error in electro-lookup.",
      details: err.message || String(err),
      meta: { quotaWarnings, preferredModel: "fallback" },
    });
  }
}