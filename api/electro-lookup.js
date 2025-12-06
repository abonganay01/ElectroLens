import { GoogleGenerativeAI } from "@google/generative-ai";

/**
 * Helper to read JSON body from Node request (Vercel Node runtime).
 */
async function readJsonBody(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        const json = data ? JSON.parse(data) : {};
        resolve(json);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Helper: strip data URL prefix and return { mimeType, base64 }
 */
function extractBase64FromDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const match = dataUrl.match(/^data:(.+);base64,(.*)$/);
  if (!match) return null;
  return { mimeType: match[1], base64: match[2] };
}

/**
 * Generic Google Custom Search image helper.
 * searchType=image, returns first image link or null.
 */
async function fetchFirstImage(query) {
  const apiKey = process.env.CSE_API_KEY;
  const cx = process.env.CSE_CX;

  if (!apiKey || !cx || !query) {
    console.warn("Missing CSE_API_KEY or CSE_CX or query for image search");
    return null;
  }

  const url =
    "https://www.googleapis.com/customsearch/v1" +
    `?q=${encodeURIComponent(query)}` +
    `&searchType=image` +
    `&num=1` +
    `&safe=active` +
    `&key=${apiKey}` +
    `&cx=${cx}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error("Image search HTTP error:", res.status, await res.text());
      return null;
    }
    const data = await res.json();
    if (data.items && data.items.length > 0) {
      return data.items[0].link; // direct image URL
    }
  } catch (err) {
    console.error("Google Image Search error:", err);
  }
  return null;
}

/**
 * Generic Google Custom Search for web references (datasheets, etc.).
 * Returns an array of { title, url, snippet } and optionally one datasheet URL.
 */
async function fetchWebReferences(query) {
  const apiKey = process.env.CSE_API_KEY;
  const cx = process.env.CSE_CX;

  if (!apiKey || !cx || !query) {
    return { references: [], datasheetUrl: null };
  }

  const url =
    "https://www.googleapis.com/customsearch/v1" +
    `?q=${encodeURIComponent(query)}` +
    `&num=5` +
    `&safe=active` +
    `&key=${apiKey}` +
    `&cx=${cx}`;

  let references = [];
  let datasheetUrl = null;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error("Web search HTTP error:", res.status, await res.text());
      return { references, datasheetUrl };
    }
    const data = await res.json();
    if (Array.isArray(data.items)) {
      for (const item of data.items) {
        const ref = {
          title: item.title,
          url: item.link,
          snippet: item.snippet || ""
        };
        references.push(ref);

        // Simple heuristic: if the URL or title mentions "datasheet", mark as datasheet.
        const lowerUrl = (item.link || "").toLowerCase();
        const lowerTitle = (item.title || "").toLowerCase();
        if (!datasheetUrl && (lowerUrl.includes("datasheet") || lowerTitle.includes("datasheet"))) {
          datasheetUrl = item.link;
        }
      }
    }
  } catch (err) {
    console.error("Google Web Search error:", err);
  }

  return { references, datasheetUrl };
}

/**
 * Helper: build some generic shop search links for the device name.
 */
function buildShopLinks(name) {
  if (!name) return null;
  const encoded = encodeURIComponent(name);
  return {
    shopee: `https://shopee.ph/search?keyword=${encoded}`,
    lazada: `https://www.lazada.com.ph/catalog/?q=${encoded}`,
    amazon: `https://www.amazon.com/s?k=${encoded}`,
    aliexpress: `https://www.aliexpress.com/wholesale?SearchText=${encoded}`
  };
}

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = await readJsonBody(req);
    const { image, queryText } = body || {};

    if (!image && !queryText) {
      return res.status(400).json({
        error: "Provide at least an image or a queryText."
      });
    }

    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      console.error("GOOGLE_API_KEY missing");
      return res.status(500).json({ error: "Server misconfigured." });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const userText =
      queryText && queryText.trim().length > 0
        ? `User query / label: "${queryText.trim()}".`
        : "No text label given, identify only from the image.";

    const parts = [
      {
        text: `
You are ElectroLens, an expert Electronics Engineer and components encyclopedia.

FOCUS ONLY ON ELECTRONICS-RELATED ITEMS:
- Electronic components (resistors, capacitors, diodes, transistors, ICs, regulators, etc.)
- Microcontrollers and dev boards (Arduino, ESP32, STM32, etc.)
- Modules (sensor boards, relay modules, power modules, etc.)
- Test equipment (multimeter, oscilloscope, power supply, etc.)
- Tools (soldering iron, breadboard, jumper wires, etc.)

TASK:
Look at the provided image and/or text label and identify the most likely electronics-related item.

Respond ONLY with a JSON object in this exact format:

{
  "name": "Short specific name, like 'ESP32 Dev Board' or '10kΩ Carbon Film Resistor'",
  "category": "Component | Microcontroller | Tool | Test Equipment | Module | Power Supply | Other",
  "description": "1-3 paragraphs explaining what it is in simple words, with engineering depth.",
  "typical_uses": [
    "Where and how this is usually used in electronics projects or industry"
  ],
  "where_to_buy": [
    "Typical places to buy (local electronics shops, online like Lazada/Shopee/Amazon, distributors like Mouser/Digi-Key, etc.)"
  ],
  "key_specs": [
    "Important specs or parameters (voltage ratings, current, power, tolerance, package, frequency, etc.) if identifiable. If unsure, be honest."
  ],
  "project_ideas": [
    "Example project ideas using this part in real circuits or hobby projects"
  ],
  "common_mistakes": [
    "Common wiring or usage mistakes, and warnings related to power, polarity, pinout, or heat"
  ],
  "datasheet_hint": "Short instruction on what to search on Google to find its datasheet. Include an example search query."
}

RULES:
- If you are not confident about the exact model, describe the general device type and say that the model is approximate.
- Do NOT invent unrealistic, ultra-specific part numbers if you cannot see them.
- If the object is not clearly electronics-related, set:
  "name": "Not an electronics-focused object",
  "category": "Other"
and briefly explain that it's outside electronics.
      `.trim()
      },
      { text: userText }
    ];

    if (image) {
      const extracted = extractBase64FromDataUrl(image);
      if (!extracted) {
        return res.status(400).json({
          error: "Image must be a base64 data URL like 'data:image/jpeg;base64,...'"
        });
      }
      parts.push({
        inlineData: {
          mimeType: extracted.mimeType || "image/jpeg",
          data: extracted.base64
        }
      });
    }

    // Call Gemini
    const geminiResult = await model.generateContent({
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json" }
    });

    const text = geminiResult.response.text();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.error("Failed to parse JSON from Gemini:", text);
      return res
        .status(500)
        .json({ error: "Failed to parse AI response from Gemini." });
    }

    // Base encyclopedia result from Gemini
    const baseName =
      parsed.name && typeof parsed.name === "string"
        ? parsed.name
        : (queryText || "Unknown device");

    const result = {
      name: baseName,
      category: parsed.category || "Other",
      description: parsed.description || "No description provided.",
      typical_uses: Array.isArray(parsed.typical_uses) ? parsed.typical_uses : [],
      where_to_buy: Array.isArray(parsed.where_to_buy) ? parsed.where_to_buy : [],
      key_specs: Array.isArray(parsed.key_specs) ? parsed.key_specs : [],
      project_ideas: Array.isArray(parsed.project_ideas) ? parsed.project_ideas : [],
      common_mistakes: Array.isArray(parsed.common_mistakes) ? parsed.common_mistakes : [],
      datasheet_hint:
        parsed.datasheet_hint ||
        `Search for "${baseName} datasheet" on your preferred search engine.`,
      // place-holders, will be filled below
      references: [],
      datasheet_url: null,
      shop_links: buildShopLinks(baseName),
      official_store: null,
      real_image: null,
      usage_image: null,
      pinout_image: null
    };

    // 1) Web references + datasheet
    const { references, datasheetUrl } = await fetchWebReferences(baseName);
    if (references && references.length > 0) {
      result.references = references;
    }
    if (datasheetUrl) {
      result.datasheet_url = datasheetUrl;
    }

    // 2) Images (component, usage, pinout)
    //    Keep it simple: 3 separate searches. This is okay for free-tier demos.
    const [realImageUrl, usageImageUrl, pinoutImageUrl] = await Promise.all([
      fetchFirstImage(baseName),
      fetchFirstImage(`${baseName} in circuit`),
      fetchFirstImage(`${baseName} pinout diagram`)
    ]);

    result.real_image = realImageUrl || null;
    result.usage_image = usageImageUrl || null;
    result.pinout_image = pinoutImageUrl || null;

    return res.status(200).json(result);
  } catch (err) {
    console.error("Error in /api/electro-lookup:", err);
    return res.status(500).json({ error: "Gemini/Google request failed." });
  }
}
