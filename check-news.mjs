const clean=(s="")=>s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1").replace(/<[^>]*>/g," ").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/\s+/g," ").trim();
function parseRss(xml){return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0,8).map(([,item])=>{const get=tag=>clean(item.match(new RegExp("<"+tag+"[^>]*>([\\s\\S]*?)</"+tag+">","i"))?.[1]||"");return{title:get("title"),url:get("link"),publisher:get("source")||"Google News",date:get("pubDate")}}).filter(x=>x.title&&/^https?:\/\//i.test(x.url))}
export default async request=>{
 if(request.method!=="POST")return Response.json({error:"Use POST with a claim."},{status:405});
 let body;try{body=await request.json()}catch{return Response.json({error:"Invalid JSON request."},{status:400})}
 const claim=String(body.claim||"").trim().slice(0,500);
 if(claim.length<8)return Response.json({error:"Please enter a claim of at least 8 characters."},{status:400});
 const query=encodeURIComponent(claim);
 const newsUrl="https://news.google.com/rss/search?q="+query+"&hl=en-NG&gl=NG&ceid=NG:en";
 const newsPromise=fetch(newsUrl,{headers:{"User-Agent":"AIMMS/1.0"},signal:AbortSignal.timeout(10000)}).then(async r=>r.ok?parseRss(await r.text()):[]).catch(()=>[]);
 const key=Netlify.env.get("GOOGLE_FACT_CHECK_API_KEY");
 const factPromise=key?fetch("https://factchecktools.googleapis.com/v1alpha1/claims:search?query="+query+"&languageCode=en&key="+encodeURIComponent(key),{signal:AbortSignal.timeout(10000)}).then(async r=>{if(!r.ok)return[];const data=await r.json();return(data.claims||[]).slice(0,8).flatMap(c=>(c.claimReview||[]).map(v=>({title:c.text||v.title||"Published fact-check",url:v.url,publisher:v.publisher?.name||"Fact-check publisher",rating:v.textualRating||"Rating not supplied",date:v.reviewDate||""})).filter(x=>/^https?:\/\//i.test(x.url||"")))}).catch(()=>[]):Promise.resolve([]);
 const[news,factChecks]=await Promise.all([newsPromise,factPromise]);
 return Response.json({news,factChecks,note:"Evidence retrieved from public sources. News coverage does not establish truth, and no matching fact-check does not mean a claim is true or false."},{headers:{"Cache-Control":"no-store"}});
};