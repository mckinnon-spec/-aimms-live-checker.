const clean = (s = "") =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

function parseRss(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .slice(0, 8)
    .map(([, item]) => {
      const get = tag =>
        clean(item.match(
          new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i")
        )?.[1] || "");

      return {
        title: get("title"),
        url: get("link"),
        publisher: get("source") || "Google News",
        date: get("pubDate")
      };
    })
    .filter(x => x.title && /^https?:\/\//i.test(x.url));
}

async function analyseClaim(claim, news, factChecks, key) {
  const evidence = {
    news: news.map(n => ({
      title: n.title,
      publisher: n.publisher,
      date: n.date,
      url: n.url
    })),
    publishedFactChecks: factChecks
  };

  const prompt = `
You are the AI analysis component of AIMMS, an evidence-aware
misinformation mitigation system.

Analyse the user's claim using ONLY the evidence supplied below.

USER CLAIM:
${claim}

AVAILABLE EVIDENCE:
${JSON.stringify(evidence)}

IMPORTANT RULES:
1. Do not invent facts, sources, quotations or evidence.
2. News headlines alone cannot prove a claim true or false.
3. A published fact-check is useful evidence, but consider its rating,
   publisher and whether it addresses the exact claim.
4. If evidence is insufficient, indirect, conflicting or unavailable,
   choose Inconclusive.
5. Do not treat absence of evidence as evidence that a claim is false.
6. Explain the limitations of the available evidence.
7. Be neutral and do not make unsupported assumptions.

Return ONLY valid JSON using this exact structure:
{
  "verdict": "Supported, Contradicted, or Inconclusive",
  "confidence": "Low, Moderate, or High",
  "explanation": "A clear explanation of your assessment",
  "evidenceAssessment": "How the available sources relate to the claim",
  "limitations": "What cannot be established from the available evidence"
}
`;

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json"
        }
      }),
      signal: AbortSignal.timeout(30000)
    }
  );

  const responseText = await response.text();

if (!response.ok) {
  console.error(
    "Gemini API diagnostic:",
    JSON.stringify({
      status: response.status,
      statusText: response.statusText,
      body: responseText.slice(0, 1500)
    })
  );

  throw new Error("Gemini API returned status " + response.status);
}

let result;

try {
  result = JSON.parse(responseText);
} catch {
  console.error(
    "Gemini API returned invalid JSON:",
    responseText.slice(0, 1000)
  );

  throw new Error("Gemini API returned an invalid response.");
}
  const text = result.candidates?.[0]?.content?.parts
    ?.map(p => p.text || "")
    .join("");

  if (!text) throw new Error("Gemini returned an empty response.");

  return JSON.parse(text);
}

export default async request => {
  if (request.method !== "POST") {
    return Response.json(
      { error: "Use POST with a claim." },
      { status: 405 }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON request." },
      { status: 400 }
    );
  }

  const claim = String(body.claim || "").trim().slice(0, 500);

  if (claim.length < 8) {
    return Response.json(
      { error: "Please enter a claim of at least 8 characters." },
      { status: 400 }
    );
  }

  const query = encodeURIComponent(claim);

  const newsUrl =
    "https://news.google.com/rss/search?q=" +
    query + "&hl=en-NG&gl=NG&ceid=NG:en";

  const newsPromise = fetch(newsUrl, {
    headers: { "User-Agent": "AIMMS/1.0" },
    signal: AbortSignal.timeout(10000)
  })
    .then(async r => r.ok ? parseRss(await r.text()) : [])
    .catch(() => []);

  const key = Netlify.env.get("GOOGLE_FACT_CHECK_API_KEY");

  const factPromise = key
    ? fetch(
        "https://factchecktools.googleapis.com/v1alpha1/claims:search?query=" +
        query + "&languageCode=en&key=" + encodeURIComponent(key),
        { signal: AbortSignal.timeout(10000) }
      )
        .then(async r => {
          if (!r.ok) return [];

          const data = await r.json();

          return (data.claims || []).slice(0, 8).flatMap(c =>
            (c.claimReview || [])
              .map(v => ({
                title: c.text || v.title || "Published fact-check",
                url: v.url,
                publisher: v.publisher?.name || "Fact-check publisher",
                rating: v.textualRating || "Rating not supplied",
                date: v.reviewDate || ""
              }))
              .filter(x => /^https?:\/\//i.test(x.url || ""))
          );
        })
        .catch(() => [])
    : Promise.resolve([]);

  const [news, factChecks] = await Promise.all([
    newsPromise,
    factPromise
  ]);

  let aiAnalysis = null;
  let aiError = null;

  const geminiKey = Netlify.env.get("GEMINI_API_KEY");

  if (geminiKey) {
    try {
      aiAnalysis = await analyseClaim(
        claim,
        news,
        factChecks,
        geminiKey
      );
    } catch (error) {
      console.error("AIMMS AI analysis error:", error.message);
      aiError = "AI analysis could not be completed. Please try again.";
    }
  } else {
    aiError = "Gemini API key is not configured.";
  }

  return Response.json(
    {
      claim,
      news,
      factChecks,
      aiAnalysis,
      aiError,
      note:
        "Evidence retrieved from public sources. News coverage does not establish truth, and no matching fact-check does not mean a claim is true or false."
    },
    {
      headers: { "Cache-Control": "no-store" }
    }
  );
};
