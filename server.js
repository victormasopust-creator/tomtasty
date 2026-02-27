const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const session = require("express-session");
const app = express();
const PORT = process.env.PORT || 3000;
const STORE = process.env.SHOPIFY_STORE || "tom-tasty.myshopify.com";
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = "2025-01";
const SESSION_SECRET = process.env.SESSION_SECRET || "tt-kitchen-secret-2025";
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || "BYL";

let tokenCache = { token: null, expiresAt: 0 };

app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } }));
app.use(express.urlencoded({ extended: false }));

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect("/login");
}

async function getToken() {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET env vars required");
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now + 60000) return tokenCache.token;
  const resp = await fetch("https://" + STORE + "/admin/oauth/access_token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  const data = await resp.json();
  tokenCache = { token: data.access_token, expiresAt: now + (data.expires_in - 300) * 1000 };
  return data.access_token;
}

async function fetchAllOrders(token) {
  let orders = [];
  let url = "https://" + STORE + "/admin/api/" + API_VERSION + "/orders.json?limit=250&status=open&financial_status=paid&fields=id,name,created_at,email,financial_status,fulfillment_status,line_items,shipping_address,current_total_price,tags,note";
  while (url) {
    const resp = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
    const data = await resp.json();
    orders = orders.concat(data.orders || []);
    const lh = resp.headers.get("link") || "";
    url = null;
    if (lh.includes('rel="next"')) { const m = lh.match(/<([^>]+)>;\s*rel="next"/); if (m) url = m[1]; }
  }
  return orders;
}

const VM = {"\u2696\uFE0F":"Original","\uD83D\uDCAA":"Sport","\uD83D\uDD25":"Weightloss"};
function getVariant(t) { for (const [e,v] of Object.entries(VM)) { if (t.includes(e)) return v; } const l=t.toLowerCase(); if (["suppe","risotto","kartoffel","gem\u00FCse","pak choi"].some(w=>l.includes(w))) return "Beilage"; if (l.includes("tasting")) return "Tasting-Box"; return "Standard"; }
function cleanName(t) { for (const e of Object.keys(VM)) t=t.replace(e,"").trim(); return t; }

app.get("/login", (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect("/");
  res.sendFile(path.join(__dirname, "login.html"));
});

app.post("/login", (req, res) => {
  const pw = (req.body.password || "").trim();
  if (pw === ACCESS_PASSWORD) {
    req.session.authenticated = true;
    return res.redirect("/");
  }
  res.redirect("/login?error=1");
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/api/production", requireAuth, async (req, res) => {
  try {
    const token = await getToken();
    const orders = await fetchAllOrders(token);
    const filtered = orders.filter(o => { const f = o.fulfillment_status || "unfulfilled"; return f === "unfulfilled" || f === "partial" || f === null; });
    const dishes = {}, orderDetails = [];
    for (const o of filtered) {
      const city = o.shipping_address?.city || "N/A", plz = o.shipping_address?.zip || "", items = [];
      for (const li of o.line_items || []) {
        const raw = li.title, clean = cleanName(raw), variant = getVariant(raw), qty = li.quantity, price = parseFloat(li.price);
        if (!dishes[clean]) dishes[clean] = {total:0,original:0,sport:0,weightloss:0,beilage:0,standard:0,tasting:0,revenue:0};
        dishes[clean].total += qty; dishes[clean].revenue += price * qty;
        const km = {Original:"original",Sport:"sport",Weightloss:"weightloss",Beilage:"beilage",Standard:"standard","Tasting-Box":"tasting"};
        dishes[clean][km[variant]||"standard"] += qty;
        items.push({rawTitle:raw,clean,variant,qty,price,lineTotal:price*qty});
      }
      orderDetails.push({name:o.name,email:o.email,city,plz,created:o.created_at,total:parseFloat(o.current_total_price),tags:o.tags||"",note:o.note||"",items});
    }
    const sorted = Object.entries(dishes).sort((a,b) => b[1].total - a[1].total).map(([name,data]) => ({name,...data}));
    const totals = sorted.reduce((a,d) => ({total:a.total+d.total,original:a.original+d.original,sport:a.sport+d.sport,weightloss:a.weightloss+d.weightloss,beilage:a.beilage+d.beilage,standard:a.standard+d.standard,revenue:a.revenue+d.revenue}),{total:0,original:0,sport:0,weightloss:0,beilage:0,standard:0,revenue:0});
    res.json({timestamp:new Date().toISOString(),totalOrders:filtered.length,totalPortions:totals.total,totals,dishes:sorted,orders:orderDetails.sort((a,b)=>b.total-a.total)});
  } catch (err) { console.error("API Error:", err); res.status(500).json({error:err.message}); }
});


app.use((req, res, next) => { res.setHeader("Content-Security-Policy", "frame-ancestors https://admin.shopify.com https://"+STORE+";"); next(); });
app.get("/", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.listen(PORT, () => console.log("Kitchen App on port " + PORT));
