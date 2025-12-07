// /api/electro-lookup.js

import { GoogleGenerativeAI } from "@google/generative-ai";

// Allow bigger JSON bodies (for uploaded base64 images)
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "8mb" // increase if you still hit limits
    }
  }
};

// ----------------- Helpers: image parsing -----------------

function extractBase64FromDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return null;
  }
  const match = dataUrl.match(/^data:(.+);base64,(.*)$/);
  if (!match) return null;
  return { mimeType: match[1], base64: match[2] };
}

// ----------------- Google Custom Search: images -----------------

async function googleImageSearch(query) {
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
      return null;
    }
    const data = await res.json();
    return data.items?.[0]?.link || null;
  } catch (err) {
    console.error("Google image search error:", err);
    return null;
  }
}

// ----------------- Serper: images & datasheets fallback -----------------

async function serperImageSearch(query) {
  const serperKey = process.env.SERPER_API_KEY;
  if (!serperKey || !query) return null;

  try {
    const res = await fetch("https://google.serper.dev/images", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": serperKey
      },
      body: JSON.stringify({
        q: query,
        num: 1
      })
    });

    if (!res.ok) {
      console.error("Serper image search HTTP error:", res.status);
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

async function serperDatasheetSearch(query) {
  const serperKey = process.env.SERPER_API_KEY;
  if (!serperKey || !query) {
    return { datasheetUrl: null, references: [] };
  }

  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": serperKey
      },
      body: JSON.stringify({
        q: `${query} datasheet pdf`,
        num: 5
      })
    });

    if (!res.ok) {
      console.error("Serper datasheet search HTTP error:", res.status);
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
          snippet: item.snippet || ""
        });
      }
    }

    return { datasheetUrl, references };
  } catch (err) {
    console.error("Serper datasheet search error:", err);
    return { datasheetUrl: null, references: [] };
  }
}

// ----------------- Google CSE: datasheets & references -----------------

async function googleDatasheetAndReferences(name) {
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
      console.error("Datasheet search HTTP error:", res.status);
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

// ----------------- Unified helpers (Google -> Serper fallback) -----------------

async function smartImageSearch(query) {
  if (!query) return null;

  // 1) Google
  let url = await googleImageSearch(query);
  if (url) return url;

  // 2) Serper fallback
  console.warn(
    "Google image search failed or quota exceeded – falling back to Serper."
  );
  url = await serperImageSearch(query);
  return url || null;
}

async function fetchRealImageFromGoogle(nameOrQuery) {
  return smartImageSearch(nameOrQuery);
}

async function fetchUsageImageFromGoogle(nameOrQuery) {
  const q = `${nameOrQuery} application circuit electronics example`;
  return smartImageSearch(q);
}

async function fetchPinoutImageFromGoogle(nameOrQuery) {
  const q = `${nameOrQuery} pinout diagram`;
  return smartImageSearch(q);
}

async function fetchDatasheetAndReferences(name) {
  if (!name) return { datasheetUrl: null, references: [] };

  // 1) Google
  let { datasheetUrl, references } = await googleDatasheetAndReferences(name);

  const needsFallback =
    !datasheetUrl || !Array.isArray(references) || references.length === 0;

  if (!needsFallback) {
    return { datasheetUrl, references };
  }

  // 2) Serper fallback
  console.warn(
    "Google datasheet search insufficient – falling back to Serper."
  );
  const serperResult = await serperDatasheetSearch(name);

  if (!datasheetUrl && serperResult.datasheetUrl) {
    datasheetUrl = serperResult.datasheetUrl;
  }
  if (!Array.isArray(references) || references.length === 0) {
    references = serperResult.references || [];
  }

  return { datasheetUrl, references };
}

// ----------------- Shop links -----------------

function generateShopLinks(nameOrQuery) {
  const q = encodeURIComponent(nameOrQuery || "");
  return {
    shopee: `https://shopee.ph/search?keyword=${q}`,
    lazada: `https://www.lazada.com.ph/tag/${q}/`,
    amazon: `https://www.amazon.com/s?k=${q}`,
    aliexpress: `https://www.aliexpress.com/wholesale?SearchText=${q}`
  };
}

// ----------------- Groq refinement -----------------

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

[... prompt text truncated for brevity in explanation, keep yours same as before ...]
`;

  const body = {
    model: "mixtral-8x7b-32768",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(baseJson, null, 2) }
    ]
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

// ----------------- Main handler -----------------

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body || {};
    const { image } = body;
    const rawQueryText =
      typeof body.queryText === "string" ? body.queryText : "";
    const safeQueryText = rawQueryText.trim();

    if (!image && !safeQueryText) {
      return res
        .status(400)
        .json({ error: "Provide an image or queryText." });
    }

    const geminiKey = process.env.GOOGLE_API_KEY;
    if (!geminiKey) {
      console.error("Missing GOOGLE_API_KEY");
      return res
        .status(500)
        .json({ error: "Server misconfigured: GOOGLE_API_KEY missing." });
    }

    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const basePrompt = `
You are ElectroLens, an assistant specialized ONLY in electronics-related items.

[keep your original basePrompt text here exactly, unchanged]
`;

    const parts = [{ text: basePrompt }];

    if (image) {
      const extracted = extractBase64FromDataUrl(image);
      if (!extracted) {
        return res.status(400).json({
          error:
            "Image must be a base64 data URL like data:image/jpeg;base64,..."
        });
      }
      parts.push({
        inlineData: {
          mimeType: extracted.mimeType,
          data: extracted.base64
        }
      });
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
      baseJson = JSON.parse(geminiResp.response.text());
    } catch (err) {
      console.error("Failed to parse Gemini JSON:", geminiResp.response.text());
      return res
        .status(500)
        .json({ error: "Failed to parse Gemini response as JSON." });
    }

    const nameOrQuery =
      baseJson.image_search_query ||
      baseJson.name ||
      safeQueryText ||
      "electronics component";

    // Images (Google first, Serper fallback)
    baseJson.real_image = await fetchRealImageFromGoogle(nameOrQuery);
    baseJson.usage_image = await fetchUsageImageFromGoogle(nameOrQuery);
    baseJson.pinout_image = await fetchPinoutImageFromGoogle(nameOrQuery);

    // Datasheet + references (Google first, Serper fallback)
    const ds = await fetchDatasheetAndReferences(
      baseJson.name || safeQueryText || ""
    );
    baseJson.datasheet_url = ds.datasheetUrl;
    baseJson.references = ds.references;

    // Shop links
    baseJson.shop_links = generateShopLinks(
      baseJson.name || safeQueryText || "electronics"
    );

    // Groq refinement
    const refined = await groqRefine(baseJson);

    // Preserve URLs (in case Groq removed them)
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
    return res.status(500).json({
      error: "Internal server error in electro-lookup.",
      details: err.message || String(err)
    });
  }
}
