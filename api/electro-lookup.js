// api/electro-lookup.js

import { GoogleGenerativeAI } from "@google/generative-ai";

export const config = {
  api: { bodyParser: false },
};
export const runtime = "nodejs";

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => data += chunk);
    req.on("end", () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// ------------------------------
// UNIVERSAL ENCYCLOPEDIA PROMPT
// ------------------------------
const ENCYCLOPEDIA_PROMPT = `
You are ElectroLens, an engineering-grade electronics encyclopedia.

RETURN STRICT JSON ONLY WITH THIS SCHEMA:

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

RULES:
- ALWAYS fill ALL fields with realistic, rich content.
- NEVER return empty arrays unless item is truly unknown.
- "description": 3–6 paragraphs.
- "typical_uses": 4–8 bullet items.
- "key_specs": 6–12 technical bullet items.
- "project_ideas": 3–6 useful project examples.
- "common_mistakes": 5–10 real mistakes engineers make.
- NEVER include Markdown.
- NEVER hallucinate fake part numbers.
- If unsure, return generalized but realistic electronics information.
`;

// ------------------------------
// CALL MODELS
// ------------------------------

async function callGemini(text, image, quotaWarnings) {
  try {
    const key = process.env.GOOGLE_API_KEY;
    if (!key) return null;

    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const parts = [{ text: ENCYCLOPEDIA_PROMPT }];
    if (text) parts.push({ text: `User query: "${text}"` });

    if (image) {
      parts.push({
        inlineData: {
          mimeType: image.mimeType,
          data: image.data
        }
      });
    }

    const resp = await model.generateContent({
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json" }
    });

    return JSON.parse(resp.response.text());
  } catch (err) {
    quotaWarnings.push({ source: "gemini", msg: String(err) });
    return null;
  }
}

async function callGroq(text, quotaWarnings) {
  try {
    const key = process.env.GROQ_API_KEY;
    if (!key) return null;

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: "mixtral-8x7b-32768",
        messages: [
          { role: "system", content: ENCYCLOPEDIA_PROMPT },
          { role: "user", content: text }
        ]
      })
    });

    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  } catch (err) {
    quotaWarnings.push({ source: "groq", msg: String(err) });
    return null;
  }
}

async function callDeepSeek(text, quotaWarnings) {
  try {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) return null;

    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: ENCYCLOPEDIA_PROMPT },
          { role: "user", content: text }
        ]
      })
    });

    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  } catch (err) {
    quotaWarnings.push({ source: "deepseek", msg: String(err) });
    return null;
  }
}

// ------------------------------
// IMAGE SEARCH (kept)
// ------------------------------

async function fetchImage(q) {
  try {
    const key = process.env.CSE_API_KEY;
    const cx = process.env.CSE_CX;

    if (!key || !cx) return null;

    const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(
      q
    )}&searchType=image&num=1&key=${key}&cx=${cx}`;

    const res = await fetch(url);
    const data = await res.json();
    return data.items?.[0]?.link || null;
  } catch {
    return null;
  }
}

async function fetchDatasheet(q) {
  try {
    const key = process.env.CSE_API_KEY;
    const cx = process.env.CSE_CX;

    if (!key || !cx) return null;

    const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(
      q + " datasheet pdf"
    )}&num=5&key=${key}&cx=${cx}`;

    const res = await fetch(url);
    const data = await res.json();

    return data.items?.find(i =>
      i.link.endsWith(".pdf") || i.link.toLowerCase().includes("datasheet")
    )?.link;
  } catch {
    return null;
  }
}

// ------------------------------
// BACKEND HANDLER
// ------------------------------

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const quotaWarnings = [];

  try {
    const body = await readJsonBody(req);
    const text = body.queryText?.trim() || "";
    const imgData =
      body.image?.startsWith("data:") ?
      extractBase64FromDataUrl(body.image) : null;

    let result = null;
    let modelUsed = "none";

    // 1) Try Gemini (text or image)
    result = await callGemini(text, imgData, quotaWarnings);
    if (result) modelUsed = "gemini";

    // 2) Try Groq
    if (!result) {
      result = await callGroq(text, quotaWarnings);
      if (result) modelUsed = "groq";
    }

    // 3) Try DeepSeek
    if (!result) {
      result = await callDeepSeek(text, quotaWarnings);
      if (result) modelUsed = "deepseek";
    }

    // 4) Final fallback
    if (!result) {
      result = {
        name: text || "Unknown item",
        category: "Other",
        description:
          "General encyclopedia entry. AI models were unavailable on the server.",
        typical_uses: ["General electronic usage"],
        where_to_buy: ["Local electronics suppliers"],
        key_specs: ["Specifications vary"],
        project_ideas: ["General-purpose educational projects"],
        common_mistakes: ["Always verify datasheet information"],
        datasheet_hint: text + " datasheet pdf",
        image_search_query: text
      };
      modelUsed = "fallback";
    }

    // 5) Add real images & datasheet
    result.real_image = await fetchImage(result.image_search_query);
    result.usage_image = await fetchImage(result.image_search_query + " application");
    result.pinout_image = await fetchImage(result.image_search_query + " pinout");
    result.datasheet_url = await fetchDatasheet(result.image_search_query);

    return res.status(200).json({
      ...result,
      meta: {
        modelUsed,
        quotaWarnings
      }
    });

  } catch (err) {
    return res.status(500).json({
      error: "Server failure",
      details: String(err),
      meta: { quotaWarnings }
    });
  }
}
