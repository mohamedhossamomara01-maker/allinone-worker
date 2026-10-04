// ══════════════════════════════════════════════════════════════
// allinone-worker — وسيط الذكاء الاصطناعي لتطبيق "AllinOne"
// - بيتحقق إن الطلب جاي من مستخدم مسجّل (JWT بتاع Supabase) — مفيش دخول من غير حساب
// - حد يومي لكل مستخدم (افتراضي ٢٠ طلب) بيتسجل في قاعدة البيانات ومش بيتلعب فيه من المتصفح
// - مفتاح Gemini مخزّن Secret هنا ومش بيظهر في التطبيق
// المتغيرات (Settings ← Variables and Secrets):
//   SUPABASE_URL           (Text)    https://xxxx.supabase.co
//   SUPABASE_ANON_KEY      (Text)    الـ anon public key
//   SUPABASE_SERVICE_KEY   (Secret)  service_role key
//   GEMINI_API_KEY         (Secret)
//   ALLOWED_ORIGIN         (Text)    رابط موقعك بالظبط، مثال: https://yourname.github.io
//   DAILY_LIMIT            (Text، اختياري) افتراضي 20
//   GEMINI_MODEL           (Text، اختياري) افتراضي gemini-2.5-flash
// ══════════════════════════════════════════════════════════════
const MAX_BODY_BYTES = 2_500_000; // ≈ صورة مضغوطة + نص

function cors(env, req) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  const ok = allowed.length === 0 ? "*" : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    "Access-Control-Allow-Origin": ok,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
const json = (obj, status, headers) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });

export default {
  async fetch(req, env) {
    const h = cors(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    const url = new URL(req.url);
    if (req.method === "GET") return new Response("allinone worker ✅", { headers: h });
    if (req.method !== "POST" || url.pathname !== "/ai") return json({ error: "not found" }, 404, h);

    // 1) تحقق الهوية
    const auth = req.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!token) return json({ error: "سجّل الدخول الأول" }, 401, h);
    const u = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } });
    if (!u.ok) return json({ error: "الجلسة منتهية، سجّل الدخول تاني" }, 401, h);
    const user = await u.json();
    if (!user || !user.id) return json({ error: "مستخدم غير معروف" }, 401, h);

    // 2) قراءة وتحقق من الطلب
    const len = Number(req.headers.get("Content-Length") || 0);
    if (len > MAX_BODY_BYTES) return json({ error: "الصورة كبيرة، جرّب صورة أصغر" }, 413, h);
    let body;
    try { body = await req.json(); } catch (e) { return json({ error: "طلب غير صالح" }, 400, h); }
    const prompt = String(body.prompt || "").slice(0, 4000);
    if (!prompt) return json({ error: "الطلب فاضي" }, 400, h);
    const parts = [];
    if (body.image && body.image.data) {
      const mime = String(body.image.mime || "image/jpeg");
      if (!/^image\/(jpeg|png|webp)$/.test(mime)) return json({ error: "نوع الصورة غير مدعوم" }, 400, h);
      if (String(body.image.data).length > 2_000_000) return json({ error: "الصورة كبيرة" }, 413, h);
      parts.push({ inline_data: { mime_type: mime, data: String(body.image.data) } });
    }
    parts.push({ text: prompt });

    // 3) الحد اليومي (ذرّي في قاعدة البيانات)
    const limit = Number(env.DAILY_LIMIT || 20);
    const bump = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/allinone_ai_bump`, {
      method: "POST",
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_user: user.id })
    });
    if (!bump.ok) return json({ error: "تعذّر التحقق من الحد اليومي" }, 503, h);
    const used = Number(await bump.json());
    if (used > limit) return json({ error: `وصلت للحد اليومي (${limit} طلب). جرّب بكرة.`, used, limit }, 429, h);

    // 4) نداء Gemini
    const model = env.GEMINI_MODEL || "gemini-2.5-flash";
    const g = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { maxOutputTokens: 900, temperature: 0.4 } })
    });
    const data = await g.json().catch(() => ({}));
    if (!g.ok) return json({ error: "خدمة الذكاء الاصطناعي مشغولة، جرّب بعد شوية" }, 502, h);
    const text = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts.map(p => p.text || "").join("").trim();
    return json({ text: text || "", used, limit }, 200, h);
  }
};
