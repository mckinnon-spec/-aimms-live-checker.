function clean(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRss(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .slice(0, 8)
    .map(([, item]) => {
      const get = tag =>
        clean(
          item.match(
            new RegExp(
              "<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">",
              "i"
            )
          )?.[1] || ""
        );

      return {
        title: get("title"),
        url: get("link"),
        publisher: get("source") || "Google News",
        date: get("pubDate")
      };
    })
    .filter(item =>
      item.title && /^https?:\/\//i.test(item.url)
    );
}

async function analyseClaim(claim, news, factChecks, apiKey) {
  const evidence = {
    news: news.map(item => ({
      title: item.title,
      publisher: item.publisher,
      date: item.date,
      url: item.url
    })),
    publishedFactChecks: factChecks
  };

  const prompt = `
You are the AI analysis component of AIMMS,
an evidence-aware misinformation mitigation system.

Analyse the user's claim using ONLY the evidence supplied below.

USER CLAIM:
${claim}

AVAILABLE EVIDENCE:
${JSON.stringify(evidence)}

IMPORTANT RULES:

1. Never invent facts, sources, quotations or evidence.
2. News headlines alone cannot prove a claim true or false.
3. Consider whether published fact-checks address the exact claim.
4. If evidence is insufficient, indirect, conflicting or unavailable,
   choose Inconclusive.
5. Absence of evidence does not mean a claim is false.
6. Explain the limitations of the available evidence.
7. Remain neutral and avoid unsupported assumptions.

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
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
        "HTTP-Referer": "https://luxury-macaron-2eb64a.netlify.app",
        "X-Title": "AIMMS"
      },
      body: JSON.stringify({
        model: "openrouter/free",
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.2,
        response_format: {
          type: "json_object"
        }
      }),
      signal: AbortSignal.timeout(20000)
    }
  );

  const responseText = await response.text();

  if (!response.ok) {
    console.error(
      "OpenRouter API error:",
      response.status,
      responseText.slice(0, 1500)
    );

    throw new Error(
      "OpenRouter API returned status " + response.status
    );
  }

  let result;

  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error("OpenRouter returned invalid JSON.");
  }

  const content = result.choices?.[0]?.message?.content;

  const aiText = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map(part => part.text || "").join("")
      : "";

  if (!aiText) {
    throw new Error("OpenRouter returned an empty response.");
  }

  let analysis;

  try {
    analysis = JSON.parse(aiText);
  } catch {
    throw new Error("AI analysis was not valid JSON.");
  }

  const allowedVerdicts = [
    "Supported",
    "Contradicted",
    "Inconclusive"
  ];

  const allowedConfidence = [
    "Low",
    "Moderate",
    "High"
  ];

  if (!allowedVerdicts.includes(analysis.verdict)) {
    throw new Error("AI returned an invalid verdict.");
  }

  if (!allowedConfidence.includes(analysis.confidence)) {
    throw new Error("AI returned an invalid confidence level.");
  }

  return {
    verdict: analysis.verdict,
    confidence: analysis.confidence,
    explanation: String(analysis.explanation || ""),
    evidenceAssessment: String(
      analysis.evidenceAssessment || ""
    ),
    limitations: String(analysis.limitations || "")
  };
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

  const claim = String(body.claim || "")
    .trim()
    .slice(0, 500);

  if (claim.length < 8) {
    return Response.json(
      {
        error: "Please enter a claim of at least 8 characters."
      },
      { status: 400 }
    );
  }

  const query = encodeURIComponent(claim);

  // GOOGLE NEWS SEARCH

  const newsUrl =
    "https://news.google.com/rss/search?q=" +
    query +
    "&hl=en-NG&gl=NG&ceid=NG:en";

  const newsPromise = fetch(newsUrl, {
    headers: {
      "User-Agent": "AIMMS/1.0"
    },
    signal: AbortSignal.timeout(10000)
  })
    .then(async response =>
      response.ok
        ? parseRss(await response.text())
        : []
    )
    .catch(error => {
      console.error("News search error:", error.message);
      return [];
    });

  // GOOGLE FACT CHECK SEARCH

  const factCheckKey = Netlify.env.get(
    "GOOGLE_FACT_CHECK_API_KEY"
  );

  const factPromise = factCheckKey
    ? fetch(
        "https://factchecktools.googleapis.com/v1alpha1/claims:search?query=" +
          query +
          "&languageCode=en&key=" +
          encodeURIComponent(factCheckKey),
        {
          signal: AbortSignal.timeout(10000)
        }
      )
        .then(async response => {
          if (!response.ok) return [];

          const data = await response.json();

          return (data.claims || [])
            .slice(0, 8)
            .flatMap(claimItem =>
              (claimItem.claimReview || [])
                .map(review => ({
                  title:
                    claimItem.text ||
                    review.title ||
                    "Published fact-check",
                  url: review.url,
                  publisher:
                    review.publisher?.name ||
                    "Fact-check publisher",
                  rating:
                    review.textualRating ||
                    "Rating not supplied",
                  date: review.reviewDate || ""
                }))
                .filter(item =>
                  /^https?:\/\//i.test(item.url || "")
                )
            );
        })
        .catch(error => {
          console.error(
            "Fact-check search error:",
            error.message
          );
          return [];
        })
    : Promise.resolve([]);

  // RETRIEVE EVIDENCE

  const [news, factChecks] = await Promise.all([
    newsPromise,
    factPromise
  ]);

  // OPENROUTER AI ANALYSIS

  let aiAnalysis = null;
  let aiError = null;

  const openRouterKey = Netlify.env.get(
    "OPENROUTER_API_KEY"
  );

  if (openRouterKey) {
    try {
      aiAnalysis = await analyseClaim(
        claim,
        news,
        factChecks,
        openRouterKey
      );
    } catch (error) {
      console.error(
        "AIMMS AI analysis error:",
        error.message
      );

      aiError =
        "AI analysis could not be completed. Please try again.";
    }
  } else {
    aiError = "OpenRouter API key is not configured.";
  }

  // RETURN RESULTS TO THE WEBSITE

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
      headers: {
        "Cache-Control": "no-store"
      }
    }
  );
};
