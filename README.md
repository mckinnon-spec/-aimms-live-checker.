# AIMMS — AI-Powered Misinformation Mitigation System

Responsive academic prototype with a Netlify Function that retrieves recent Google News coverage and published Google Fact Check records.

## Deploy
Connect this repository to your Netlify site. The included `netlify.toml` configures the root publish directory and `netlify/functions` folder.

## Optional Google Fact Check API key
Add `GOOGLE_FACT_CHECK_API_KEY` in Netlify environment variables with Functions scope, then redeploy. Google News RSS works without a key. The Google Fact Check API only returns previously published reviews.

## Important limitations
News coverage is not proof. No matching published fact-check does not establish truth or falsity. This prototype does not contain or run a trained BiLSTM model; model training and evaluation remain future work.
