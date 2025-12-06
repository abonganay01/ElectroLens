import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";

// ========== Helpers: request body + image parsing ==========

async function readJsonBody(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => (data += chunk));
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

// ========== Google Custom Search helpers ==========

async function googleImageSearch(query) {
  const apiKey = process.env.CSE_API_KEY;
  const cx = process.env.CSE_CX;
  if (!apiKey || !cx || !query) return null;

  // Added &imgSize=medium to ensure we get visible results that load fast
  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(
    query
  )}&searchType=image&imgSize=medium&num=1&safe=active&key=${apiKey}&cx=${cx}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Image search HTTP error (${query}):`, res.status);
      return null;
    }
    const data = await res.json();
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
  const q = `${nameOrQuery} application circuit schematic wiring`;
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
  )}&num=4&safe=active&key=${apiKey}&cx=${cx}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error("Datasheet search HTTP error:", res.status);
      return { datasheetUrl: null, references: [] };
    }
    const data = await res.json();

    let datasheetUrl = null;
    const references = [];

    for (const item of data.items || []) {
      const link = item.link || "";
      // Prioritize actual PDF links
      if (!datasheetUrl && (link.endsWith(".pdf") || item.title.toLowerCase().includes("datasheet"))) {
        datasheetUrl = link;
      }
      if (references.length < 3) {
        references.push({
          title: item.title || "Reference",
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
  const q = encodeURIComponent(nameOrQuery || "electronics");
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

You receive a JSON object describing an electronics component.
Your job is to REWRITE and ENRICH the text fields with very complete, realistic information.

IMPORTANT: 
- Return the EXACT SAME JSON STRUCTURE.
- DO NOT change the "real_image", "usage_image", or "pinout_image" URLs. Keep them exactly as is.
- If the description is thin, expand it significantly.

Fields to enrich:
- "name": Standardize the name.
- "category": Keep it accurate.
- "description": 3-5 paragraphs, detailed engineering context.
- "typical_uses": Concrete examples.
- "where_to_buy": Common vendors.
- "key_specs": Real world numbers (voltages, pin counts, protocols).
- "project_ideas": Specific project concepts.
- "common_mistakes": Technical gotchas.
- "datasheet_hint": Best Google search term.

Return ONLY valid JSON.
`;

  const body = {
    model: "mixtral-8x7b-32768",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(baseJson) }
    ],
    temperature: 0.3
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
        console.error("Groq API error:", res.status);
        return baseJson;
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    
    // Extract JSON from potential markdown blocks
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
    } else {
        return JSON.parse(text);
    }
  } catch (err) {
    console.error("Groq refinement failed:", err);
    return baseJson; // Fallback to Gemini base data on error
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
    const { image, queryText } = body || {};

    if (!image && !queryText) {
      return res.status(400).json({ error: "Provide an image or queryText." });
    }

    const geminiKey = process.env.GOOGLE_API_KEY;
    if (!geminiKey) {
      console.error("Missing GOOGLE_API_KEY");
      return res.status(500).json({ error: "Server misconfigured: GOOGLE_API_KEY missing." });
    }

    const genAI = new GoogleGenerativeAI(geminiKey);
    // Using 1.5 flash or pro is often better for vision, but keeping requested model
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const basePrompt = `
You are ElectroLens, an electronics component identifier.
Identify the object in the image or query.

Return strict JSON:
{
  "name": "Component Name",
  "category": "Component Category",
  "description": "Brief description",
  "typical_uses": ["Use 1", "Use 2"],
  "where_to_buy": ["Store 1"],
  "key_specs": ["Spec 1"],
  "datasheet_hint": "Search query for datasheet",
  "project_ideas": ["Project 1"],
  "common_mistakes": ["Mistake 1"],
  "image_search_query": "Specific search query for Google Images"
}

"image_search_query" is CRITICAL. It should be the most precise name of the component to find a clean photo (e.g. 'ESP32 DevKit V1', 'Arduino Uno R3', 'LM7805 voltage regulator').
`;

    const parts = [{ text: basePrompt }];

    if (image) {
      const extracted = extractBase64FromDataUrl(image);
      if (!extracted) {
        return res.status(400).json({
          error: "Image must be a base64 data URL like data:image/jpeg;base64,..."
        });
      }
      parts.push({
        inlineData: {
          mimeType: extracted.mimeType,
          data: extracted.base64
        }
      });
      if (queryText && queryText.trim()) {
        parts.push({ text: `User text label: "${queryText.trim()}"` });
      }
    } else {
      parts.push({ text: `User typed query: "${queryText.trim()}"` });
    }

    const geminiResp = await model.generateContent({
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json" }
    });

    let baseJson;
    try {
      baseJson = JSON.parse(geminiResp.response.text());
    } catch (err) {
      console.error("Failed to parse Gemini JSON:", geminiResp.response.text());
      return res.status(500).json({ error: "Failed to parse Gemini response as JSON." });
    }

    // --- LOGIC UPDATE: Better Search Query Construction ---
    const nameOrQuery =
      (baseJson.image_search_query && baseJson.image_search_query.length > 2)
        ? baseJson.image_search_query
        : (baseJson.name || queryText || "electronics component");

    console.log(`Searching images for: ${nameOrQuery}`);

    // --- FETCH IMAGES ---
    // We execute these in parallel for speed
    const [realImage, usageImage, pinoutImage, dsData] = await Promise.all([
        fetchRealImageFromGoogle(nameOrQuery),
        fetchUsageImageFromGoogle(nameOrQuery),
        fetchPinoutImageFromGoogle(nameOrQuery),
        fetchDatasheetAndReferences(baseJson.name || queryText)
    ]);

    // Attach to baseJson
    baseJson.real_image = realImage;
    baseJson.usage_image = usageImage;
    baseJson.pinout_image = pinoutImage;
    baseJson.datasheet_url = dsData.datasheetUrl;
    baseJson.references = dsData.references;
    baseJson.shop_links = generateShopLinks(baseJson.name);

    // --- REFINE WITH GROQ ---
    let refinedJson = await groqRefine(baseJson);

    // --- CRITICAL FIX: RESTORE IMAGES ---
    // Sometimes LLMs hallucinates empty strings or nulls for fields it can't "see".
    // We explicitly overwrite the URL fields with the ones we fetched from Google above.
    refinedJson.real_image = baseJson.real_image;
    refinedJson.usage_image = baseJson.usage_image;
    refinedJson.pinout_image = baseJson.pinout_image;
    refinedJson.datasheet_url = baseJson.datasheet_url;
    refinedJson.references = baseJson.references;
    refinedJson.shop_links = baseJson.shop_links;
    
    // Ensure the frontend search fallback works by passing the query back
    refinedJson.image_search_query = nameOrQuery; 

    return res.status(200).json(refinedJson);

  } catch (err) {
    console.error("Error in /api/electro-lookup:", err);
    return res.status(500).json({ error: "Internal server error in electro-lookup." });
  }
}