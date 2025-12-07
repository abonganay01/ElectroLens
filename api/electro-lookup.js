import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";

export const config = {
  api: {
    bodyParser: false,
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

// ========== SERPER helpers (fallback search) ==========

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

// ========== Google Custom Search helpers (with Serper fallback) ==========

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
      if (!res.ok) {
        console.error("Image search HTTP error (CSE):", res.status);
      } else {
        const data = await res.json();
        const link = data.items?.[0]?.link;
        if (link) return link;
      }
    } catch (err) {
      console.error("Google CSE image search error:", err);
    }
  }

  // Fallback: Serper
  return serperImageSearch(query);
}

async function fetchRealImageFromGoogle(nameOrQuery) {
  return googleImageSearch(nameOrQuery);
}

async function fetchUsageImageFromGoogle(nameOrQuery) {
  const q = `${nameOrQuery} application circuit schematic wiring diagram`;
  return googleImageSearch(q);
}

async function fetchPinoutImageFromGoogle(nameOrQuery) {
  const q = `${nameOrQuery} pinout diagram`;
  return googleImageSearch(q);
}

async function fetchDatasheetAndReferences(name) {
  const apiKey = process.env.CSE_API_KEY;
  const cx = process.env.CSE_CX;
  if (!name) return { datasheetUrl: null, references: [] };

  // Primary: Google CSE
  if (apiKey && cx) {
    const query = `${name} datasheet pdf`;
    const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(
      query
    )}&num=5&key=${apiKey}&cx=${cx}`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error("Datasheet search HTTP error (CSE):", res.status);
      } else {
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
          if (references.length < 5) {
            references.push({
              title: item.title || "",
              url: link,
              snippet: item.snippet || "",
            });
          }
        }

        return { datasheetUrl, references };
      }
    } catch (err) {
      console.error("Datasheet search error (CSE):", err);
    }
  }

  // Fallback: Serper
  return serperDatasheetSearch(name);
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

// ========== Main handler (Gemini only for AI) ==========

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
        error: "Server misconfigured: GOOGLE_API_KEY missing.",
      });
    }

    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

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

    if (image) {
      const extracted = extractBase64FromDataUrl(image);
      if (!extracted) {
        return res.status(400).json({
          error:
            "Image must be a base64 data URL like data:image/jpeg;base64,...",
        });
      }
      const imagePayload = {
        mimeType: extracted.mimeType,
        data: extracted.base64,
      };
      parts.push({ inlineData: imagePayload });

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

    let baseJson;
    try {
      // FIX: Added parentheses .text() to call the function
      const jsonString = geminiResp.response.text()
        .replace(/```json\n?|```/g, "")
        .trim();
      baseJson = JSON.parse(jsonString);
    } catch (err) {
      console.error("Failed to parse Gemini JSON. Raw response:", geminiResp.response.text());
      return res
        .status(500)
        .json({ error: "Failed to parse Gemini response as JSON." });
    }

    const nameOrQuery =
      baseJson.image_search_query ||
      baseJson.name ||
      safeQueryText ||
      "electronics component";

    // Concurrent image fetching (CSE → Serper)
    const [realImage, usageImage, pinoutImage] = await Promise.all([
      fetchRealImageFromGoogle(nameOrQuery),
      fetchUsageImageFromGoogle(nameOrQuery),
      fetchPinoutImageFromGoogle(nameOrQuery),
    ]);

    baseJson.real_image = realImage;
    baseJson.usage_image = usageImage;
    baseJson.pinout_image = pinoutImage;

    // Datasheet + references (CSE → Serper)
    const ds = await fetchDatasheetAndReferences(
      baseJson.name || safeQueryText || ""
    );
    baseJson.datasheet_url = ds.datasheetUrl;
    baseJson.references = ds.references;

    // Shop links
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