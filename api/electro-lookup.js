// api/electro-lookup.js

// Uses Node runtime (Vercel serverless / Node, NOT Edge)
import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch"; // Added for explicit dependency

// NOTE: Add this to avoid maximum body size limit on Vercel Node runtime.
export const config = {
  api: {
    bodyParser: false,
    // Vercel only allows 4.5MB for this config, but we need manual stream reading anyway.
  },
};

export const runtime = "nodejs";

// ========== Helpers: request body + image parsing ==========

async function readJsonBody(req) {
  // CRITICAL FIX: The previous version was missing the size limit.
  // The Vercel runtime default limit is 4.5MB, but it's good practice to enforce one.
  const MAX_BYTES = 8 * 1024 * 1024; // 8MB limit for multi-modal requests

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
        // FIX: Added content-type check to ensure only JSON is parsed when we expect it
        const contentType = req.headers['content-type'] || '';
        const isJson = contentType.includes('application/json');
        
        // Vercel's node environment usually handles the raw body stream,
        // so we manually parse the collected string data.
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

// ========== Google Custom Search helpers ==========

async function googleImageSearch(query) {
  const apiKey = process.env.CSE_API_KEY;
  const cx = process.env.CSE_CX;
  if (!apiKey || !cx || !query) return null;

  // Note: Removed 'safe=active' as it's not strictly necessary and not always supported
  // by all Google search contexts.
  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(
    query
  )}&searchType=image&num=1&key=${apiKey}&cx=${cx}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error("Image search HTTP error:", res.status);
      return null;
    }
    const data = await res.json();
    
    // FIX: Check for API error object in response data
    if (data.error) {
        console.error("Google CSE Image API Error:", data.error);
        return null;
    }
    
    return data.items?.[0]?.link || null;
  } catch (err) {
    console.error("Google image search error:", err);
    return null;
  }
}

async function fetchRealImageFromGoogle(nameOrQuery) {
  return googleImageSearch(nameOrQuery);
}

async function fetchUsageImageFromGoogle(nameOrQuery) {
  // try to get an application / example circuit image
  const q = `${nameOrQuery} application circuit electronics example`;
  return googleImageSearch(q);
}

async function fetchPinoutImageFromGoogle(nameOrQuery) {
  // try to get a pinout diagram
  const q = `${nameOrQuery} pinout diagram`;
  return googleImageSearch(q);
}

async function fetchDatasheetAndReferences(name) {
  const apiKey = process.env.CSE_API_KEY;
  const cx = process.env.CSE_CX;
  if (!apiKey || !cx || !name) return { datasheetUrl: null, references: [] };

  const query = `${name} datasheet pdf`;
  // Note: Removed 'safe=active'
  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(
    query
  )}&num=5&key=${apiKey}&cx=${cx}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error("Datasheet search HTTP error:", res.status);
      return { datasheetUrl: null, references: [] };
    }
    const data = await res.json();
    
    // CRITICAL FIX: Check for API error object in response data
    if (data.error) {
        console.error("Google CSE Datasheet API Error:", data.error);
        return { datasheetUrl: null, references: [] };
    }

    let datasheetUrl = null;
    const references = [];

    // FIX: Ensure 'data.items' is handled safely (it might be missing if no results)
    for (const item of data.items || []) {
      const link = item.link || "";
      if (!datasheetUrl && (link.endsWith(".pdf") || link.toLowerCase().includes("datasheet"))) {
        datasheetUrl = link;
      }
      if (references.length < 4) {
        references.push({
          title: item.title || "",
          url: link,
          snippet: item.snippet || ""
        });
      }
    }

    return { datasheetUrl, references };
  } catch (err) {
    console.error("Datasheet search error:", err);
    return { datasheetUrl: null, references: [] };
  }
}

// ========== Shop links ==========

function generateShopLinks(nameOrQuery) {
  const q = encodeURIComponent(nameOrQuery || "");
  return {
    shopee: `https://shopee.ph/search?keyword=${q}`,
    lazada: `https://www.lazada.com.ph/tag/${q}/`,
    amazon: `https://www.amazon.com/s?k=${q}`,
    aliexpress: `https://www.aliexpress.com/wholesale?SearchText=${q}`
  };
}

// ========== Groq refinement: make it a real encyclopedia ==========

async function groqRefine(baseJson) {
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
  • Example: "ESP32-WROOM-32 datasheet PDF espressif" or "LM7805 TO-220 voltage regulator datasheet".

Image-related keys:
- "real_image", "usage_image", "pinout_image", "datasheet_url", "shop_links", "references":
  • DO NOT modify or overwrite URLs. They are provided by the server.
  • You may assume they are valid links to images or pages.

- "official_store":
  • If you recognize a likely manufacturer (Espressif, Texas Instruments, STMicroelectronics, etc.),
    you may set or refine this as their main official website or product page URL.
  • If you are not sure, leave it as is.

GENERAL:
- Do not contradict clear information already in the JSON.
- Never claim impossible or absurd electrical values.
- Return ONLY a valid JSON object. No markdown, no extra commentary, no code fences.
`;

  const body = {
    model: "mixtral-8x7b-32768",
    messages: [
      { role: "system", content: systemPrompt },
      // CRITICAL FIX: Base JSON might contain nested arrays/objects (like 'references', 'shop_links').
      // Stringifying it without indentation is slightly more efficient for the API call.
      { role: "user", content: JSON.stringify(baseJson) } 
    ],
    // FIX: Add response_format for strict JSON output
    response_format: { type: "json_object" } 
  };

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqKey}`
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
        console.error("Groq HTTP Error:", res.status, await res.text());
        return baseJson;
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    
    if (!text) {
      console.log("⚠️ Groq empty content, falling back to baseJson.");
      return baseJson;
    }
    
    // FIX: Safely parse JSON and handle models that might wrap JSON in markdown (Groq shouldn't, but defense is good)
    const jsonString = text.replace(/```json\n?|```/g, '').trim();
    return JSON.parse(jsonString);
    
  } catch (err) {
    console.error("Groq refinement failed:", err);
    return baseJson;
  }
}

// ========== Main handler ==========

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

    const geminiKey = process.env.GOOGLE_API_KEY;
    if (!geminiKey) {
      console.error("Missing GOOGLE_API_KEY");
      return res.status(500).json({
        error: "Server misconfigured: GOOGLE_API_KEY missing."
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

    let imagePayload = null;
    if (image) {
      const extracted = extractBase64FromDataUrl(image);
      if (!extracted) {
        return res.status(400).json({
          error: "Image must be a base64 data URL like data:image/jpeg;base64,..."
        });
      }
      imagePayload = { mimeType: extracted.mimeType, data: extracted.base64 };
      parts.push({ inlineData: imagePayload });
      
      if (safeQueryText) {
        parts.push({ text: `User text label: "${safeQueryText}"` });
      }
    } else {
      parts.push({ text: `User typed query: "${safeQueryText}"` });
    }

    const geminiResp = await model.generateContent({
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json" }
    });

    let baseJson;
    try {
        // FIX: Safely parse JSON and handle models that might wrap JSON in markdown
        const jsonString = geminiResp.response.text.replace(/```json\n?|```/g, '').trim();
        baseJson = JSON.parse(jsonString);
    } catch (err) {
      console.error("Failed to parse Gemini JSON:", geminiResp.response.text);
      return res
        .status(500)
        .json({ error: "Failed to parse Gemini response as JSON. Check model output." });
    }

    const nameOrQuery =
      baseJson.image_search_query ||
      baseJson.name ||
      safeQueryText ||
      "electronics component";

    // CRITICAL FIX: Await all image fetches concurrently for better performance
    const [realImage, usageImage, pinoutImage] = await Promise.all([
        fetchRealImageFromGoogle(nameOrQuery),
        fetchUsageImageFromGoogle(nameOrQuery),
        fetchPinoutImageFromGoogle(nameOrQuery),
    ]);
    
    // Images from Google
    baseJson.real_image = realImage;
    baseJson.usage_image = usageImage;
    baseJson.pinout_image = pinoutImage;

    // Datasheet + references
    const ds = await fetchDatasheetAndReferences(
      baseJson.name || safeQueryText || ""
    );
    baseJson.datasheet_url = ds.datasheetUrl;
    baseJson.references = ds.references;

    // Shop links
    baseJson.shop_links = generateShopLinks(
      baseJson.name || safeQueryText || "electronics"
    );

    // Let Groq turn it into a full-blown encyclopedia entry
    const refined = await groqRefine(baseJson);

    // 🔒 Preserve server-generated URLs & links even if Groq drops them
    const finalJson = {
      ...refined,
      real_image: baseJson.real_image,
      usage_image: baseJson.usage_image,
      pinout_image: baseJson.pinout_image,
      datasheet_url: baseJson.datasheet_url,
      references: baseJson.references,
      shop_links: baseJson.shop_links
    };

    if (baseJson.official_store && !finalJson.official_store) {
      finalJson.official_store = baseJson.official_store;
    }

    return res.status(200).json(finalJson);
  } catch (err) {
    console.error("Error in /api/electro-lookup:", err);
    return res
      .status(500)
      .json({ error: "Internal server error in electro-lookup.", details: err.message || String(err) });
  }
}