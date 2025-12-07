// api/electro-lookup.js

// Uses Node runtime (Vercel serverless / Node, NOT Edge)
import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";

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
  // Limit to 8MB for multi-modal requests
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
  const q = `${nameOrQuery} application circuit schematic wiring diagram`;
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
    
    if (data.error) {
        console.error("Google CSE Datasheet API Error:", data.error);
        return { datasheetUrl: null, references: [] };
    }

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

// ========== Groq refinement: Senior Engineer Persona ==========

async function groqRefine(baseJson) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    console.log("⚠️ No GROQ_API_KEY → skipping Groq refinement.");
    return baseJson;
  }

  // ENRICHED SYSTEM PROMPT FOR MAXIMUM DETAIL
  const systemPrompt = `
You are ElectroLens PRO, a Senior Hardware Engineer and Datasheet Expert.

You receive a JSON object describing an electronics component.
Your job is to REWRITE and ENRICH the JSON with **extremely detailed, engineering-grade** information.

RULES:
1. Return JSON ONLY. No markdown outside strings.
2. Keep existing keys. You may fill empty ones.
3. **Be Specific**: Don't say "input voltage varies". Say "Input Voltage: 4.5V to 28V (Recommended), 35V (Absolute Max)".
4. **Markdown allowed in values**: You can use bolding (**text**) inside the string values for emphasis.

FIELDS TO POPULATE:

- "name": Short, precise technical name (e.g., "LM2596S DC-DC Buck Converter Module").
- "category": "Component", "Microcontroller", "Module", "Tool", "Test Equipment", "Power Supply", or "Other".

- "description": 
  Write a comprehensive technical overview (4-6 paragraphs).
  Include: 
  1. Primary function.
  2. Internal architecture (e.g., "Uses a Darlington pair output stage").
  3. Key advantages over predecessors.
  4. Typical logic levels and communication protocols (I2C, SPI, UART) if applicable.

- "typical_uses": 5-8 concrete scenarios. (e.g., "Step-down regulation for 12V automotive systems", "High-speed switching for motor drivers").

- "where_to_buy": 4-6 bullet points covering local electronics shops and global distributors (Mouser, DigiKey).

- "key_specs": 
  8-15 bullet points. **MUST BE DETAILED.**
  Include: Supply Voltage, Logic Level, Max Current, Quiescent Current, Frequency, Operating Temperature, Package Type (DIP, SOP, QFN).
  *Distinguish between 'Recommended' and 'Absolute Maximum' ratings where possible.*

- "schematic_tips": 
  3-5 actionable engineering tips for PCB design.
  (e.g., "Requires a 100uF electrolytic capacitor on input close to pins", "Pull-up resistors of 4.7kΩ required on SDA/SCL lines").

- "alternatives":
  List 3-5 specific part numbers that perform similar functions (e.g., "Replace with LM2576 for lower frequency", "Use MP1584 for smaller footprint").

- "code_snippet":
  If this is a sensor, module, or MCU, provide a short, valid **Arduino C++** or **MicroPython** code block demonstrating initialization and basic reading.
  If not applicable (like a resistor), leave empty string.

- "project_ideas": 3-5 distinct projects with brief "how-it-works" summaries.

- "common_mistakes": 5-8 detailed warnings (e.g., "Connecting VCC to 5V on a 3.3V logic board will destroy the regulator instantly").

- "datasheet_hint": Precise search query.

PRESERVE these fields exactly (do not change URLs):
"real_image", "usage_image", "pinout_image", "datasheet_url", "shop_links", "references".
`;

  const body = {
    model: "mixtral-8x7b-32768",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(baseJson) } 
    ],
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

    // EXPANDED BASE PROMPT
    const basePrompt = `
You are ElectroLens, an assistant specialized ONLY in electronics.

Analyze the image or text. Return strict JSON.

Structure:
{
  "name": "Specific Part Name",
  "category": "Category",
  "description": "Brief description",
  "typical_uses": ["use 1", "use 2"],
  "where_to_buy": [],
  "key_specs": ["spec 1", "spec 2"],
  "datasheet_hint": "search query",
  "project_ideas": [],
  "common_mistakes": [],
  "image_search_query": "search query for google images",
  "schematic_tips": [],
  "alternatives": [],
  "code_snippet": ""
}

If the object is clearly NOT electronics, mark category as "Other".
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
        const jsonString = geminiResp.response.text.replace(/```json\n?|```/g, '').trim();
        baseJson = JSON.parse(jsonString);
    } catch (err) {
      console.error("Failed to parse Gemini JSON:", geminiResp.response.text);
      return res
        .status(500)
        .json({ error: "Failed to parse Gemini response as JSON." });
    }

    const nameOrQuery =
      baseJson.image_search_query ||
      baseJson.name ||
      safeQueryText ||
      "electronics component";

    // Concurrent image fetching
    const [realImage, usageImage, pinoutImage] = await Promise.all([
        fetchRealImageFromGoogle(nameOrQuery),
        fetchUsageImageFromGoogle(nameOrQuery),
        fetchPinoutImageFromGoogle(nameOrQuery),
    ]);
    
    baseJson.real_image = realImage;
    baseJson.usage_image = usageImage;
    baseJson.pinout_image = pinoutImage;

    const ds = await fetchDatasheetAndReferences(
      baseJson.name || safeQueryText || ""
    );
    baseJson.datasheet_url = ds.datasheetUrl;
    baseJson.references = ds.references;

    baseJson.shop_links = generateShopLinks(
      baseJson.name || safeQueryText || "electronics"
    );

    // Call refined Groq logic (with the new detailed prompt)
    const refined = await groqRefine(baseJson);

    // Merge and return
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
      .json({ error: "Internal server error.", details: err.message || String(err) });
  }
}