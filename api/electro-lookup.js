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

// ========== Serper API helpers (for datasheets & references only) ==========
// Docs: https://serper.dev

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

// ---------- Datasheets & references: Google CSE first, Serper fallback ----------

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

// ========== Groq text-only fallback when Gemini is out of quota ==========

async function groqDescribeFromText(queryText, quotaWarnings = []) {
  const groqKey = process.env.GROQ_API_KEY;
  const safeName = queryText || "Unknown electronics item";

  // Base fallback JSON that we can always return
  const fallbackJson = {
    name: safeName,
    category: "Other",
    description:
      "Text-only fallback entry. The primary Gemini model was unavailable (quota or billing) " +
      "and Groq could not be used reliably, so this is a minimal placeholder. " +
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

  // If there is no Groq API key, just return the fallback JSON
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
            "Groq text-only fallback quota or billing limit reached. Using simple fallback instead.",
        });
      } else {
        quotaWarnings.push({
          source: "groq_text_fallback",
          status: res.status,
          message:
            "Groq text-only fallback returned HTTP " +
            res.status +
            ". Using simple fallback instead.",
        });
      }
      // Do NOT throw → return minimal fallback
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

// ========== Gemini-based image URL search ==========
// Uses Gemini to find representative image URLs for the component/module.

async function fetchImagesWithGemini(nameOrQuery, quotaWarnings = []) {
  const geminiKey = process.env.GOOGLE_API_KEY;
  if (!geminiKey || !nameOrQuery) {
    return {
      real_image: null,
      usage_image: null,
      pinout_image: null,
    };
  }

  const prompt = `
You are ElectroLens, an assistant specialized in electronics.

Given this component or module name:

"${nameOrQuery}"

Use your knowledge and web tools to find up to 3 representative image URLs:

- "real_image": a realistic photo of the actual part or module.
- "usage_image": a photo or illustration showing how it is used in a circuit or project.
- "pinout_image": a schematic-style pinout or labeled diagram, if it exists.

Return STRICT JSON ONLY with this exact shape:

{
  "real_image": "https://...",
  "usage_image": "https://...",
  "pinout_image": "https://..."
}

Rules:
- If you cannot find a URL for a field, set that field to null.
- Use only direct HTTPS URLs to publicly viewable image files (jpg, jpeg, png, webp).
- Do NOT invent domains. Prefer official or well-known sites if possible.
`;

  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const resp = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: { responseMimeType: "application/json" },
    });

    const text = resp.response.text();
    const parsed = JSON.parse(text);

    return {
      real_image: parsed.real_image || null,
      usage_image: parsed.usage_image || null,
      pinout_image: parsed.pinout_image || null,
    };
  } catch (err) {
    const msg = String(err || "");
    const isQuotaError =
      msg.includes("429") ||
      msg.includes("You exceeded your current quota") ||
      msg.includes("Quota exceeded for metric");

    if (isQuotaError) {
      quotaWarnings.push({
        source: "gemini_images",
        status: 429,
        message:
          "Gemini quota exceeded for image URL lookup. Image URLs may be missing.",
      });
    } else {
      console.error("Gemini image fetch error:", err);
    }

    return {
      real_image: null,
      usage_image: null,
      pinout_image: null,
    };
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

    if (!image && !safeQueryText) {
      return res
        .status(400)
        .json({ error: "Provide an image or queryText.", meta: { quotaWarnings } });
    }

    const geminiKey = process.env.GOOGLE_API_KEY;
    if (!geminiKey) {
      console.error("Missing GOOGLE_API_KEY");
      quotaWarnings.push({
        source: "gemini",
        status: 500,
        message: "GOOGLE_API_KEY is missing on the server.",
      });
      return res.status(500).json({
        error: "Server misconfigured: GOOGLE_API_KEY missing.",
        meta: { quotaWarnings },
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
- "description": 1–3 paragraphs (base version, will be expanded later).
- "typical_uses": 2–5 short bullet ideas.
- "where_to_buy": 2–5 bullet ideas.
- "key_specs": 3–8 bullet specs.
- "datasheet_hint": what to search on Google to find the datasheet.
- "project_ideas": 2–4 very short project ideas.
- "common_mistakes": 3–6 short mistakes.
- "image_search_query": the best search phrase to find images of this exact device (e.g. "ESP32 DevKitC board", "LM7805 TO-220").
`;

    const parts = [{ text: basePrompt }];

    if (image) {
      const extracted = extractBase64FromDataUrl(image);
      if (!extracted) {
        return res.status(400).json({
          error:
            "Image must be a base64 data URL like data:image/jpeg;base64,...",
          meta: { quotaWarnings },
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
    } else {
      parts.push({ text: `User typed query: "${safeQueryText}"` });
    }

    let baseJson;

    // --- Gemini call with quota-aware handling ---
    try {
      const geminiResp = await model.generateContent({
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json" },
      });

      const rawText = geminiResp.response.text();
      baseJson = JSON.parse(rawText);
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

        // If it's a TEXT-only query (manual mode), use Groq (or simple) fallback
        if (!image && safeQueryText) {
          console.log(
            "Using Groq text-only fallback (or minimal fallback) because Gemini quota is exhausted."
          );
          baseJson = await groqDescribeFromText(safeQueryText, quotaWarnings);
        } else {
          // Image-based modes can't work without a vision model
          return res.status(429).json({
            error: "Gemini vision quota exceeded.",
            details:
              "Camera and upload analysis require Gemini (vision). Your free-tier Gemini quota is used up. Try again after the quota resets or upgrade your Gemini plan.",
            meta: { quotaWarnings },
          });
        }
      } else {
        // Some other Gemini error
        console.error("Gemini error:", err);
        return res.status(500).json({
          error: "Failed to call Gemini generateContent.",
          details: msg,
          meta: { quotaWarnings },
        });
      }
    }

    const nameOrQuery =
      baseJson.image_search_query ||
      baseJson.name ||
      safeQueryText ||
      "electronics component";

    // Images via Gemini (your request): real, usage, pinout
    const imgResult = await fetchImagesWithGemini(nameOrQuery, quotaWarnings);
    baseJson.real_image = imgResult.real_image;
    baseJson.usage_image = imgResult.usage_image;
    baseJson.pinout_image = imgResult.pinout_image;

    // Datasheet + references (Google CSE first, Serper fallback)
    const ds = await fetchDatasheetAndReferences(
      baseJson.name || safeQueryText || "",
      quotaWarnings
    );
    baseJson.datasheet_url = ds.datasheetUrl;
    baseJson.references = ds.references;

    // Shop links
    baseJson.shop_links = generateShopLinks(
      baseJson.name || safeQueryText || "electronics"
    );

    // Let Groq turn it into a full-blown encyclopedia entry
    const refined = await groqRefine(baseJson, quotaWarnings);

    // Preserve server-generated URLs & links even if Groq drops them
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
