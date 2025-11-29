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
 * Get a real image URL for the identified device using Google Custom Search.
 */
async function fetchRealImageFromGoogle(query) {
  const apiKey = process.env.CSE_API_KEY;
  const cx = process.env.CSE_CX;

  if (!apiKey || !cx || !query) return null;

  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(
    query
  )}&searchType=image&num=1&safe=active&key=${apiKey}&cx=${cx}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.log("⚠️ Image search HTTP error:", res.status, await res.text());
      return null;
    }
    const data = await res.json();
    if (data.items && data.items.length > 0) {
      return data.items[0].link; // real image URL
    }
  } catch (err) {
    console.error("Google Image Search error:", err);
  }
  return null;
}

/**
 * Fetch likely datasheet link + a few reference pages using Google Custom Search.
 * Returns { datasheetUrl, references[] }
 */
async function fetchDatasheetAndReferences(query) {
  const apiKey = process.env.CSE_API_KEY;
  const cx = process.env.CSE_CX;

  if (!apiKey || !cx || !query) {
    return { datasheetUrl: null, references: [] };
  }

  const q = `${query} datasheet pdf`;
  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(
    q
  )}&num=5&safe=active&key=${apiKey}&cx=${cx}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.log("⚠️ Datasheet search HTTP error:", res.status, await res.text());
      return { datasheetUrl: null, references: [] };
    }

    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];

    let datasheetUrl = null;
    const references = [];

    for (const item of items) {
      if (!item.link) continue;

      // Heuristic: prefer PDF or obvious manufacturer domains for datasheet
      const link = item.link;
      const mime = item.mime || "";
      const display = (item.displayLink || "").toLowerCase();

      const looksPdf =
        mime === "application/pdf" ||
        link.toLowerCase().endsWith(".pdf") ||
        link.toLowerCase().includes("datasheet");

      const looksManufacturer =
        display.includes("microchip") ||
        display.includes("espressif") ||
        display.includes("st.com") ||
        display.includes("ti.com") ||
        display.includes("analog.com") ||
        display.includes("nxp.com") ||
        display.includes("infineon") ||
        display.includes("onsemi") ||
        display.includes("renesas");

      if (!datasheetUrl && (looksPdf || looksManufacturer)) {
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
    console.error("Google Datasheet Search error:", err);
    return { datasheetUrl: null, references: [] };
  }
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

Write your answer as if it were an encyclopedia entry:
- Give a short, precise name.
- In "description", write 2–3 short paragraphs:
  1) High-level overview and what family it belongs to.
  2) Internal principle of operation / architecture in simple terms.
  3) Typical usage patterns and design notes.
- In "key_specs", list concrete, realistic numbers when commonly known
  (voltage ranges, current, package, frequency, tolerance, memory size, etc.).
- In "typical_uses", focus on real-world circuits, boards, and applications.

Respond ONLY with a JSON object in this exact format:

{
  "name": "Short specific name, like 'ESP32 Dev Board' or '10kΩ Carbon Film Resistor'",
  "category": "Component | Microcontroller | Tool | Test Equipment | Module | Power Supply | Other",
  "description": "2–3 short paragraphs explaining what it is and how it works, in simple words.",
  "typical_uses": [
    "Where and how this is usually used in electronics projects or industry"
  ],
  "where_to_buy": [
    "Typical places to buy (local electronics shops, online like Lazada/Shopee/Amazon, distributors like Mouser/Digi-Key, etc.)"
  ],
  "key_specs": [
    "Important specs or parameters (voltage ratings, current, power, tolerance, package, frequency, memory size, etc.) if identifiable. If unsure, be honest."
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
      return res.status(500).json({ error: "Failed to parse AI response from Gemini." });
    }

    const result = {
      name: parsed.name || "Unknown device",
      category: parsed.category || "Other",
      description: parsed.description || "No description provided.",
      typical_uses: Array.isArray(parsed.typical_uses) ? parsed.typical_uses : [],
      where_to_buy: Array.isArray(parsed.where_to_buy) ? parsed.where_to_buy : [],
      key_specs: Array.isArray(parsed.key_specs) ? parsed.key_specs : [],
      datasheet_hint:
        parsed.datasheet_hint ||
        "Search for the device name + 'datasheet' on your preferred search engine."
    };

    // Attach real Google image
    const realImageUrl = await fetchRealImageFromGoogle(result.name);
    result.real_image = realImageUrl || null;

    // Attach datasheet URL + reference links
    const { datasheetUrl, references } = await fetchDatasheetAndReferences(
      result.name
    );
    result.datasheet_url = datasheetUrl || null;
    result.references = references;

    return res.status(200).json(result);
  } catch (err) {
    console.error("Error in /api/electro-lookup:", err);
    return res.status(500).json({ error: "Gemini AI request failed." });
  }
}
