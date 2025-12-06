import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";

// -----------------------
// Helper: Read JSON body
// -----------------------
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
  });
}

// ------------------------------
// Helper: Convert Data URL
// ------------------------------
function extractBase64FromDataUrl(dataUrl) {
  if (!dataUrl?.startsWith("data:")) return null;
  const match = dataUrl.match(/^data:(.+);base64,(.*)$/);
  return match ? { mimeType: match[1], base64: match[2] } : null;
}

// ------------------------------
// Google: Similar Photo Search
// ------------------------------
async function fetchRealImageFromGoogle(query) {
  const apiKey = process.env.CSE_API_KEY;
  const cx = process.env.CSE_CX;
  if (!apiKey || !cx) return null;

  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&searchType=image&imgType=photo&num=1&safe=active&key=${apiKey}&cx=${cx}`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    return data.items?.[0]?.link || null;
  } catch {
    return null;
  }
}

// -----------------------------------------
// Google: Datasheet + References
// -----------------------------------------
async function fetchDatasheetAndReferences(name) {
  const apiKey = process.env.CSE_API_KEY;
  const cx = process.env.CSE_CX;
  if (!apiKey || !cx) return { datasheetUrl: null, references: [] };

  const query = `${name} datasheet pdf`;
  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&num=5&safe=active&key=${apiKey}&cx=${cx}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    let datasheetUrl = null;
    const references = [];

    for (const item of data.items || []) {
      const link = item.link;
      const display = (item.displayLink || "").toLowerCase();

      if (!datasheetUrl && (link.endsWith(".pdf") || link.includes("datasheet")))
        datasheetUrl = link;

      if (references.length < 4) {
        references.push({
          title: item.title || "",
          url: link,
          snippet: item.snippet || ""
        });
      }
    }

    return { datasheetUrl, references };
  } catch {
    return { datasheetUrl: null, references: [] };
  }
}
// ---------------------------------------------
// GROQ: Refinement and Circuit ASCII Generator
// ---------------------------------------------
async function groqRefine(baseJson) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return baseJson;

  const systemPrompt = `
You are ElectroLens PRO, an electronics encyclopedia AI.

Your tasks:
1. Improve the Gemini JSON fields with deeper engineering detail.
2. Expand descriptions to 2–4 technical but student-friendly paragraphs.
3. Generate ASCII CIRCUIT DIAGRAMS in baseJson.circuit_ascii for the MOST COMMON application.
4. Add more realistic project ideas.
5. Add safety warnings, usage mistakes, heat dissipation notes, etc.
6. Suggest official manufacturer website IF KNOWN in baseJson.official_store.

IMPORTANT:
• ALWAYS return valid JSON.
• NEVER add markdown.
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
    const refined = data?.choices?.[0]?.message?.content;

    return JSON.parse(refined);
  } catch (err) {
    console.error("GROQ refine error:", err);
    return baseJson;
  }
}

// ---------------------------------------------
// Online Shop Link Generator
// ---------------------------------------------
function generateShopLinks(name) {
  const query = encodeURIComponent(name);

  return {
    shopee: `https://shopee.ph/search?keyword=${query}`,
    lazada: `https://www.lazada.com.ph/tag/${query}/`,
    amazon: `https://www.amazon.com/s?k=${query}`,
    aliexpress: `https://www.aliexpress.com/wholesale?SearchText=${query}`
  };
}
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = await readJsonBody(req);
    const { image, queryText } = body;

    if (!image && !queryText)
      return res.status(400).json({ error: "Missing input" });

    // -----------------------------
    // GEMINI IDENTIFICATION
    // -----------------------------
    const geminiKey = process.env.GOOGLE_API_KEY;
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const parts = [
      {
        text: `
Identify this electronics component and output STRICT JSON:
{
 "name":"",
 "category":"",
 "description":"",
 "typical_uses":[],
 "where_to_buy":[],
 "key_specs":[],
 "datasheet_hint":"",
 "project_ideas":[],
 "common_mistakes":[],
 "image_search_query":""
}
`
      }
    ];

    if (image) {
      const ex = extractBase64FromDataUrl(image);
      parts.push({
        inlineData: { mimeType: ex.mimeType, data: ex.base64 }
      });
    } else {
      parts.push({ text: queryText });
    }

    const reply = await model.generateContent({
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json" }
    });

    let baseJson = JSON.parse(reply.response.text());

    // -----------------------------
    // GOOGLE IMAGE
    // -----------------------------
    const imgQuery = baseJson.image_search_query || baseJson.name || queryText;
    baseJson.real_image = await fetchRealImageFromGoogle(imgQuery);

    // -----------------------------
    // GOOGLE DATASHEET
    // -----------------------------
    const ds = await fetchDatasheetAndReferences(baseJson.name);
    baseJson.datasheet_url = ds.datasheetUrl;
    baseJson.references = ds.references;

    // -----------------------------
    // SHOP LINKS
    // -----------------------------
    baseJson.shop_links = generateShopLinks(baseJson.name);

    // -----------------------------
    // GROQ REFINEMENT
    // -----------------------------
    const refined = await groqRefine(baseJson);

    // -----------------------------
    // STORE JSON FOR CHAT MODE
    // -----------------------------
    refined.context_blob = JSON.stringify(refined);

    return res.status(200).json(refined);
  } catch (err) {
    console.error("ElectroLens error:", err);
    return res.status(500).json({ error: "Server failed." });
  }
}
