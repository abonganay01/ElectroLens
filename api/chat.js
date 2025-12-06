import fetch from "node-fetch";

/**
 * /api/chat
 * Handles follow-up questions about the identified electronic component.
 *
 * Expects JSON:
 * {
 *   "message": "user question",
 *   "context_blob": "{...component JSON...}"
 * }
 */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST only." });
  }

  try {
    const body = await new Promise((resolve, reject) => {
      let data = "";
      req.on("data", chunk => (data += chunk));
      req.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });

    const { message, context_blob } = body;

    if (!message || !context_blob) {
      return res.status(400).json({
        error: "Both 'message' and 'context_blob' are required."
      });
    }

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
      return res.status(500).json({
        error: "Missing GROQ_API_KEY in environment variables."
      });
    }

    // -----------------------------
    // SYSTEM PROMPT FOR CHAT MODE
    // -----------------------------
    const systemPrompt = `
You are ElectroLens Chat Assistant.

You will be given:
1. The JSON description of an identified electronic component (context).
2. A follow-up user question.

Your job:
• Answer CLEARLY and FACTUALLY.
• Base everything on the JSON + general electronics knowledge.
• Provide wiring notes, explanations, alternatives, and engineering reasoning.
• If user asks for a circuit, produce ASCII diagrams.
• If user asks for compatibility, explain voltage, current, and logic requirements.
• NEVER output JSON. Only plain text.
• Keep the tone educational but concise.
`;

    const userPrompt = `
=== COMPONENT CONTEXT JSON ===
${context_blob}

=== USER QUESTION ===
${message}

Now answer the question in detail:
`;

    const bodyPayload = {
      model: "mixtral-8x7b-32768",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    };

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqKey}`
      },
      body: JSON.stringify(bodyPayload)
    });

    const groqData = await groqRes.json();

    const answer = groqData?.choices?.[0]?.message?.content || "No answer produced.";

    return res.status(200).json({ reply: answer });
  } catch (err) {
    console.error("Chat handler error:", err);
    return res.status(500).json({ error: "Chat endpoint failed." });
  }
}
