require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const prisma = new PrismaClient();

// Render sits behind a proxy; this makes req.ip the real client IP (used by rate limits).
app.set("trust proxy", 1);

// =========================
// CONFIGURATION
// =========================

const PORT = process.env.PORT || 3000;

// IMPORTANT: set a long random JWT_SECRET in Render -> Environment.
const JWT_SECRET = process.env.JWT_SECRET || "speech-db-secret-key";
if (!process.env.JWT_SECRET) {
  console.warn("⚠️ JWT_SECRET is not set — using an insecure default. Set it in Render.");
}

const VALID_ROLES = ["PATIENT", "THERAPIST", "CAREGIVER"];

// FREE AI: Google Gemini free tier (get a key at https://aistudio.google.com/apikey).
// Set GEMINI_API_KEY in Render. GEMINI_MODEL is optional; if it fails (wrong
// name / quota), the server automatically falls back to the other models below.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODELS = [
  process.env.GEMINI_MODEL,
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
].filter(Boolean);

// =========================
// GEMINI HELPER (free tier friendly)
// =========================
// - tries several models in order (free-tier quotas are per model)
// - 25s timeout per attempt
// - supports a system instruction, multi-turn contents, JSON mode, temperature

async function callGemini(
  prompt,
  { json = false, system = "", contents = null, temperature = 0.4, maxOutputTokens = 1200 } = {}
) {
  if (!GEMINI_API_KEY) {
    throw new Error("AI is not configured (GEMINI_API_KEY is missing)");
  }

  const body = {
    contents: contents || [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens,
      ...(json ? { responseMimeType: "application/json" } : {}),
    },
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  };

  let lastError = null;
  for (const model of [...new Set(GEMINI_MODELS)]) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        lastError = new Error(data?.error?.message || `Gemini request failed (${response.status})`);
        console.warn(`⚠️ Gemini model ${model} failed: ${lastError.message}`);
        continue; // try next model
      }

      const text = data?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text || "")
        .join("")
        .trim();
      if (!text) {
        lastError = new Error("Gemini returned an empty response");
        continue;
      }
      return text;
    } catch (err) {
      lastError = err.name === "AbortError" ? new Error("AI request timed out") : err;
      console.warn(`⚠️ Gemini model ${model} error: ${lastError.message}`);
    }
  }
  throw lastError || new Error("All AI models failed");
}

function parseJsonLoose(text) {
  const cleaned = String(text).replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const a = cleaned.indexOf("[");
    const o = cleaned.indexOf("{");
    const start = a !== -1 && (o === -1 || a < o) ? a : o;
    const end = Math.max(cleaned.lastIndexOf("]"), cleaned.lastIndexOf("}"));
    if (start !== -1 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("AI response wasn't valid JSON");
  }
}

// Protects the free quota: max N AI calls per user per hour.
const aiUsage = new Map();
function aiRateLimit(limit = 30) {
  return (req, res, next) => {
    const key = req.user?.userId || req.ip;
    const now = Date.now();
    const hourAgo = now - 3600000;
    const hits = (aiUsage.get(key) || []).filter((t) => t > hourAgo);
    if (hits.length >= limit) {
      return res.status(429).json({
        error: "You've used a lot of AI requests this hour. Please try again a little later.",
      });
    }
    hits.push(now);
    aiUsage.set(key, hits);
    next();
  };
}

// =========================
// HEALTH SAFETY + CLINICAL KNOWLEDGE
// =========================

const SLP_SYSTEM_PROMPT = `You are "Swar Saathi Coach", a warm, evidence-informed speech and voice health assistant inside a speech-therapy app used in India.

Rules you always follow:
- You support, you do not replace, the patient's speech-language pathologist (SLP). You never diagnose, never prescribe or adjust medication, and never claim a condition is cured or certain.
- Base advice on established speech-language pathology and voice-care practice: breath support and diaphragmatic breathing, easy onset, slow/paced speech, light articulatory contacts, stuttering-friendly techniques such as pull-outs and cancellations, semi-occluded vocal tract exercises (straw phonation, lip trills, humming), resonant voice, vocal hygiene (hydration, avoiding throat-clearing and shouting, limiting caffeine, vocal rest when hoarse, steam inhalation), and sleep/stress management.
- Use simple, kind, encouraging language. Keep answers short (under 150 words unless asked for more). Prefer 2-4 concrete steps over long lectures.
- Reply in the same language the user writes in (English, Hindi, Marathi, etc.).
- The acoustic scores in this app are simple demo heuristics, not clinical measurements — never present them as a diagnosis.
- RED FLAGS: if the person mentions sudden loss of speech, sudden face drooping or weakness, trouble swallowing or breathing, choking, coughing blood, hoarseness lasting more than 3 weeks, severe pain, or thoughts of self-harm, tell them clearly to seek urgent medical care (in India call 112 or 108) and contact their therapist. Do not continue with normal tips in that case.
- If you are unsure or the question is outside speech, voice, swallowing-adjacent habits or general wellbeing, say so and suggest asking their therapist or doctor.
- Never invent patient data. Only use the context provided.`;

const EMERGENCY_PATTERNS = [
  /sudden(ly)?\s+(lost|loss|can'?t|cannot|unable).{0,25}(speak|speech|talk|voice)/i,
  /(face|mouth).{0,15}(droop|numb|crooked)/i,
  /(can'?t|cannot|unable to|trouble|difficulty).{0,15}(breathe|breathing|swallow)/i,
  /\b(choking|chok(ed|ing)|stroke|chest pain|seizure|unconscious|coughing (up )?blood)\b/i,
  /(suicid|kill myself|end my life|want to die|hurt myself|self[- ]harm)/i,
];

const EMERGENCY_REPLY =
  "What you describe could be serious. Please don't wait for the app — call emergency services now (India: 112 or 108) or go to the nearest hospital, and let your therapist know. " +
  "If you are feeling like harming yourself, please reach out right now to Tele-MANAS (14416) or someone you trust. I'm here to support you, but this needs urgent human care.";

function looksLikeEmergency(text) {
  return EMERGENCY_PATTERNS.some((re) => re.test(String(text || "")));
}

// Offline exercise bank — used when the AI is unavailable or rate-limited,
// so the app keeps working 100% free with no AI at all.
const FALLBACK_EXERCISES = [
  { title: "Diaphragmatic breathing", description: "Build steady breath support for speech.", category: "VOICE", difficultyLevel: 1, targetPhonemes: [], instructions: "Sit tall, place one hand on your belly. Breathe in through the nose for 4 counts so your belly rises, then breathe out slowly on 'sss' for 6 counts. Repeat 5 times.", gamePointsValue: 10 },
  { title: "Straw phonation hum", description: "Gently warm up and relax the voice.", category: "VOICE", difficultyLevel: 1, targetPhonemes: [], instructions: "Hum softly through a drinking straw (or lips together) with a glide up and down. Keep your throat relaxed. Do 5 glides, rest, repeat twice.", gamePointsValue: 10 },
  { title: "Slow easy-onset words", description: "Start words gently to reduce tension.", category: "FLUENCY", difficultyLevel: 1, targetPhonemes: ["h", "m"], instructions: "Say 'home, my, hello, many' starting each word softly with a slight breath, stretching the first sound for about one second. Repeat 5 times.", gamePointsValue: 10 },
  { title: "Lip trills and sirens", description: "Loosen lips and improve pitch control.", category: "VOICE", difficultyLevel: 2, targetPhonemes: [], instructions: "Blow a relaxed lip trill while sliding your pitch from low to high and back. Do 5 slides without pushing the voice.", gamePointsValue: 12 },
  { title: "P-B-M minimal pairs", description: "Practice clear lip sounds.", category: "ARTICULATION", difficultyLevel: 2, targetPhonemes: ["p", "b", "m"], instructions: "Say each pair slowly and clearly: pat–bat, pan–ban, map–mat, pin–bin. Watch your lips close fully. Repeat the list 3 times.", gamePointsValue: 12 },
  { title: "Paced reading aloud", description: "Practice slow, smooth sentence rhythm.", category: "FLUENCY", difficultyLevel: 2, targetPhonemes: [], instructions: "Read 3 short sentences aloud, pausing at every comma and full stop and taking a calm breath between phrases. Aim for a slow, even pace.", gamePointsValue: 15 },
  { title: "S and SH contrast", description: "Tell apart and produce sibilant sounds.", category: "ARTICULATION", difficultyLevel: 3, targetPhonemes: ["s", "sh"], instructions: "Say: sip–ship, sea–she, sock–shock, sort–short. Keep 's' sharp with teeth close, 'sh' with rounded lips. Repeat each pair 3 times.", gamePointsValue: 15 },
  { title: "Resonant voice phrases", description: "Place the voice forward with easy resonance.", category: "VOICE", difficultyLevel: 3, targetPhonemes: ["m", "n"], instructions: "Hum 'mmm' feeling buzzing at the lips, then say 'mmm-my name is...' and 'many more minutes' keeping the same gentle buzz.", gamePointsValue: 15 },
  { title: "Pull-out practice", description: "Ease out of a stuck sound smoothly.", category: "FLUENCY", difficultyLevel: 4, targetPhonemes: [], instructions: "Read 5 short sentences. If you get stuck on a word, pause, relax, and slowly slide out of the sound into the rest of the word. Stay calm — no rush.", gamePointsValue: 20 },
  { title: "R-blend word ladder", description: "Practice harder consonant blends.", category: "ARTICULATION", difficultyLevel: 4, targetPhonemes: ["r", "tr", "br"], instructions: "Say slowly: ray, tray, bray; row, trow, brow; rim, trim, brim. Keep your tongue tip lifted and relaxed. Repeat 3 times.", gamePointsValue: 20 },
  { title: "Two-minute storytelling", description: "Combine breath, pacing and clarity.", category: "FLUENCY", difficultyLevel: 5, targetPhonemes: [], instructions: "Tell a two-minute story about your day using easy onsets, slow pace and calm pauses. Record yourself and listen back kindly.", gamePointsValue: 25 },
  { title: "Tongue-twister with control", description: "Challenge clarity at a relaxed pace.", category: "ARTICULATION", difficultyLevel: 5, targetPhonemes: ["s", "sh", "th"], instructions: "Say 'She sells sea shells' slowly 3 times, then slightly faster 3 times, keeping every sound clear. Slow down if sounds blur.", gamePointsValue: 25 },
];

// =========================
// STATS (deterministic "smart" layer — works without AI)
// =========================

function avg(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function computeStats(logsNewestFirst) {
  const logs = logsNewestFirst || [];
  const pron = logs.map((l) => Number(l.pronunciationScore || 0));
  const clar = logs.map((l) => Number(l.clarityScore || 0));
  const recent = pron.slice(0, 3);
  const previous = pron.slice(3, 6);
  const trendDelta = recent.length && previous.length ? Math.round(avg(recent) - avg(previous)) : null;
  let trend = "not enough data";
  if (trendDelta !== null) trend = trendDelta >= 5 ? "improving" : trendDelta <= -5 ? "declining" : "stable";

  const weekAgo = Date.now() - 7 * 86400000;
  const sessionsLast7d = logs.filter((l) => new Date(l.recordedAt).getTime() >= weekAgo).length;

  const mean = avg(pron);
  const variance = pron.length ? avg(pron.map((p) => (p - mean) ** 2)) : 0;

  return {
    sessions: logs.length,
    sessionsLast7d,
    avgPronunciation: Math.round(mean),
    avgClarity: Math.round(avg(clar)),
    latestPronunciation: pron[0] ?? null,
    latestClarity: clar[0] ?? null,
    best: pron.length ? Math.round(Math.max(...pron)) : null,
    worst: pron.length ? Math.round(Math.min(...pron)) : null,
    variability: Math.round(Math.sqrt(variance)),
    trend,
    trendDelta,
  };
}

function summarizeWellness(checkIns) {
  if (!checkIns.length) return null;
  const last7 = checkIns.slice(0, 7);
  return {
    count: last7.length,
    avgMood: +avg(last7.map((c) => c.mood)).toFixed(1),
    avgFatigue: +avg(last7.map((c) => c.fatigue)).toFixed(1),
    avgThroatComfort: +avg(last7.map((c) => c.throatComfort)).toFixed(1),
    avgHydration: +avg(last7.map((c) => c.hydration)).toFixed(1),
    avgSleep: +avg(last7.map((c) => c.sleepHours)).toFixed(1),
    latest: last7[0],
  };
}

function vocalHygieneFlags(w) {
  const flags = [];
  if (!w) return flags;
  if (w.avgHydration < 5) flags.push("low water intake");
  if (w.avgSleep < 6) flags.push("short sleep");
  if (w.avgThroatComfort <= 2.5) flags.push("throat discomfort");
  if (w.avgFatigue >= 4) flags.push("high fatigue");
  if (w.avgMood <= 2) flags.push("low mood");
  return flags;
}

async function loadPatientContext(patientProfile) {
  const [recentLogs, assignments, wellnessRows, feedback, user] = await Promise.all([
    prisma.audioLog.findMany({
      where: { patientProfileId: patientProfile.id },
      orderBy: { recordedAt: "desc" },
      take: 12,
    }),
    prisma.exerciseAssignment.findMany({
      where: { patientProfileId: patientProfile.id },
      include: { exercise: true },
      orderBy: { dueDate: "desc" },
      take: 30,
    }),
    prisma.wellnessCheckIn.findMany({
      where: { patientProfileId: patientProfile.id },
      orderBy: { createdAt: "desc" },
      take: 14,
    }),
    prisma.caregiverFeedback.findMany({
      where: { patientProfileId: patientProfile.id },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.user.findUnique({
      where: { id: patientProfile.userId },
      select: { fullName: true },
    }),
  ]);

  const stats = computeStats(recentLogs);
  const wellness = summarizeWellness(wellnessRows);
  const completed = assignments.filter((a) => a.isCompleted).length;
  const pending = assignments.filter((a) => !a.isCompleted);

  return {
    user,
    recentLogs,
    assignments,
    wellnessRows,
    feedback,
    stats,
    wellness,
    flags: vocalHygieneFlags(wellness),
    completed,
    pending,
  };
}

function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / (365.25 * 86400000));
}

function contextToText(profile, ctx) {
  const { stats, wellness, flags } = ctx;
  const age = ageFromDob(profile.dateOfBirth);
  const lines = [
    `Age: ${age ?? "unknown"}`,
    `Diagnosis: ${profile.primaryDiagnosis}`,
    `Clinical notes: ${profile.clinicalNotes}`,
    `Current difficulty level: ${profile.currentDifficultyLevel}/5`,
    `Practice streak: ${profile.currentStreak} days (best ${profile.longestStreak}); points: ${profile.totalPoints}`,
    `Sessions recorded: ${stats.sessions} (${stats.sessionsLast7d} in last 7 days)`,
    stats.sessions
      ? `Pronunciation: latest ${Math.round(stats.latestPronunciation)}%, average ${stats.avgPronunciation}%, best ${stats.best}%, lowest ${stats.worst}%, trend ${stats.trend}${stats.trendDelta !== null ? ` (${stats.trendDelta >= 0 ? "+" : ""}${stats.trendDelta} pts)` : ""}`
      : "Pronunciation: no sessions yet",
    stats.sessions ? `Clarity: latest ${Math.round(stats.latestClarity)}%, average ${stats.avgClarity}%` : "",
    `Exercises completed: ${ctx.completed}; pending: ${ctx.pending.length}`,
    wellness
      ? `Wellness (last ${wellness.count} check-ins): mood ${wellness.avgMood}/5, fatigue ${wellness.avgFatigue}/5, throat comfort ${wellness.avgThroatComfort}/5, water ${wellness.avgHydration} glasses/day, sleep ${wellness.avgSleep}h`
      : "Wellness: no check-ins yet",
    flags.length ? `Vocal-health flags: ${flags.join(", ")}` : "",
    ctx.feedback.length
      ? `Recent caregiver notes: ${ctx.feedback.map((f) => `"${String(f.feedbackText).slice(0, 120)}" (mood ${f.moodRating}/5)`).join("; ")}`
      : "",
  ];
  return lines.filter(Boolean).join("\n");
}

// =========================
// AUTHENTICATION + ACCESS CONTROL
// =========================

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Access token required" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    return res.status(403).json({ error: "Invalid or expired token" });
  }
};

// Who may see this patient's data?
//  - PATIENT   -> only themselves
//  - THERAPIST -> only patients who linked with their therapist code
//  - CAREGIVER -> only patients whose invite code they entered
async function canAccessPatient(req, patientUserId) {
  const { userId, role } = req.user;
  if (role === "PATIENT") return userId === patientUserId;

  const profile = await prisma.patientProfile.findUnique({
    where: { userId: patientUserId },
    select: { id: true },
  });
  if (!profile) return false;

  if (role === "THERAPIST") {
    return Boolean(
      await prisma.patientTherapist.findFirst({
        where: { patientProfileId: profile.id, therapistId: userId },
      })
    );
  }
  if (role === "CAREGIVER") {
    return Boolean(
      await prisma.patientCaregiver.findFirst({
        where: { patientProfileId: profile.id, caregiverId: userId },
      })
    );
  }
  return false;
}

async function guardPatient(req, res, next) {
  try {
    if (!(await canAccessPatient(req, req.params.patientId))) {
      return res.status(403).json({ error: "You don't have access to this patient's data" });
    }
    next();
  } catch (error) {
    console.error("❌ Access check error:", error);
    res.status(500).json({ error: "Access check failed" });
  }
}

// ---- Codes (therapist codes + patient invite codes) ----
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I confusion

function randomCode(prefix, len = 6) {
  const bytes = crypto.randomBytes(len);
  let s = "";
  for (const b of bytes) s += CODE_CHARS[b % CODE_CHARS.length];
  return `${prefix}-${s}`;
}

async function generateUniqueCode(prefix) {
  for (let i = 0; i < 10; i++) {
    const code = randomCode(prefix);
    const taken =
      prefix === "THR"
        ? await prisma.user.findUnique({ where: { therapistCode: code }, select: { id: true } })
        : await prisma.patientProfile.findUnique({ where: { inviteCode: code }, select: { id: true } });
    if (!taken) return code;
  }
  throw new Error("Could not generate a unique code");
}

// Limits code guessing (separate from the AI limiter).
const linkAttempts = new Map();
function linkRateLimit(limit = 15) {
  return (req, res, next) => {
    const key = req.user?.userId || req.ip;
    const hourAgo = Date.now() - 3600000;
    const hits = (linkAttempts.get(key) || []).filter((t) => t > hourAgo);
    if (hits.length >= limit) {
      return res.status(429).json({ error: "Too many code attempts. Please try again in a while." });
    }
    hits.push(Date.now());
    linkAttempts.set(key, hits);
    next();
  };
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    organizationId: user.organizationId,
    ...(user.role === "THERAPIST" ? { therapistCode: user.therapistCode } : {}),
  };
}

async function listTherapists(patientProfileId) {
  const rows = await prisma.patientTherapist.findMany({
    where: { patientProfileId },
    include: { therapist: { select: { id: true, fullName: true } } },
  });
  return rows.map((r) => ({ id: r.therapist.id, fullName: r.therapist.fullName }));
}

// =========================
// MIDDLEWARE
// =========================

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "1mb" }));

const upload = multer({ dest: "uploads/" });

// =========================
// HOME + HEALTH
// =========================

app.get("/", (req, res) => {
  res.json({
    message: "Speech-DB backend is working! 🚀",
    frontend: "https://swar-saathi.netlify.app",
    status: "online",
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Swar Saathi backend is healthy",
    aiExercisesEnabled: Boolean(GEMINI_API_KEY),
    aiEnabled: Boolean(GEMINI_API_KEY),
    models: GEMINI_MODELS,
  });
});

// =========================
// ME
// =========================
// (The old GET /api/users route that listed every user has been removed on purpose.)

app.get("/api/auth/me", authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const out = publicUser(user);
    if (user.role === "PATIENT") {
      const profile = await prisma.patientProfile.findUnique({ where: { userId: user.id } });
      if (profile) {
        out.inviteCode = profile.inviteCode;
        out.therapists = await listTherapists(profile.id);
      }
    }
    res.json({ user: out });
  } catch (error) {
    console.error("❌ Me error:", error);
    res.status(500).json({ error: "Failed to load user" });
  }
});

// =========================
// REGISTER
// =========================

app.post("/api/auth/register", linkRateLimit(20), async (req, res) => {
  try {
    const { fullName, email, password, role, dateOfBirth, therapistCode } = req.body;

    if (!fullName || !email || !password) {
      return res.status(400).json({ error: "Full name, email and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const normalizedRole = VALID_ROLES.includes(role) ? role : "PATIENT";
    const normalizedEmail = String(email).trim().toLowerCase();

    if (normalizedRole === "PATIENT" && !dateOfBirth) {
      return res.status(400).json({ error: "Date of birth is required for patient accounts" });
    }

    let parsedDateOfBirth = null;
    if (normalizedRole === "PATIENT") {
      parsedDateOfBirth = new Date(dateOfBirth);
      if (Number.isNaN(parsedDateOfBirth.getTime())) {
        return res.status(400).json({ error: "That date of birth doesn't look valid" });
      }
    }

    // Optional therapist code (patients only). Validate BEFORE creating anything.
    let therapist = null;
    const codeInput = String(therapistCode || "").trim().toUpperCase();
    if (normalizedRole === "PATIENT" && codeInput) {
      therapist = await prisma.user.findUnique({ where: { therapistCode: codeInput } });
      if (!therapist) {
        return res.status(400).json({ error: "That therapist code isn't valid. Check it, or leave it empty to continue without a therapist." });
      }
    }

    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    let organization = await prisma.organization.findFirst();
    if (!organization) {
      organization = await prisma.organization.create({
        data: { name: "Swar Saathi", slug: `swar-saathi-${Date.now()}`, country: "India" },
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        organizationId: organization.id,
        email: normalizedEmail,
        fullName: String(fullName).trim(),
        role: normalizedRole,
        passwordHash,
        therapistCode: normalizedRole === "THERAPIST" ? await generateUniqueCode("THR") : null,
      },
    });

    if (normalizedRole === "PATIENT") {
      const profile = await prisma.patientProfile.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          currentDifficultyLevel: 1,
          dateOfBirth: parsedDateOfBirth,
          primaryDiagnosis: "Pending assessment",
          clinicalNotes: "No clinical notes yet — pending first session.",
          inviteCode: await generateUniqueCode("PAT"),
        },
      });
      if (therapist) {
        await prisma.patientTherapist.create({
          data: { patientProfileId: profile.id, therapistId: therapist.id, isPrimary: true },
        });
      }
    }

    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: "12h" });

    res.status(201).json({
      message: "Account created successfully",
      token,
      user: publicUser(user),
    });
  } catch (error) {
    console.error("❌ Register error:", error);
    if (error.code === "P2002") {
      return res.status(409).json({ error: "An account with this email already exists" });
    }
    res.status(500).json({ error: "Failed to create account" });
  }
});

// =========================
// LOGIN
// =========================

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    // Registration stores lowercase emails, so login must normalise too.
    const user = await prisma.user.findUnique({
      where: { email: String(email).trim().toLowerCase() },
    });
    if (!user) return res.status(401).json({ error: "Invalid email or password" });

    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatch) return res.status(401).json({ error: "Invalid email or password" });

    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: "12h" });

    res.json({ message: "Login successful", token, user: publicUser(user) });
  } catch (error) {
    console.error("❌ Login error:", error);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// =========================
// LINKING (therapist code / caregiver invite code)
// =========================

// Patient enters a therapist's code (any time after signup).
app.post("/api/patient/link-therapist", authenticateToken, linkRateLimit(15), async (req, res) => {
  try {
    if (req.user.role !== "PATIENT") {
      return res.status(403).json({ error: "Only patients can enter a therapist code" });
    }
    const code = String(req.body?.therapistCode || "").trim().toUpperCase();
    if (!code) return res.status(400).json({ error: "Please enter a therapist code" });

    const therapist = await prisma.user.findUnique({
      where: { therapistCode: code },
      select: { id: true, fullName: true },
    });
    if (!therapist) {
      return res.status(404).json({ error: "That therapist code isn't valid. Please check it with your therapist." });
    }

    const profile = await prisma.patientProfile.findUnique({ where: { userId: req.user.userId } });
    if (!profile) return res.status(404).json({ error: "Patient profile not found" });

    const existing = await prisma.patientTherapist.findFirst({
      where: { patientProfileId: profile.id, therapistId: therapist.id },
    });
    if (!existing) {
      const count = await prisma.patientTherapist.count({ where: { patientProfileId: profile.id } });
      await prisma.patientTherapist.create({
        data: { patientProfileId: profile.id, therapistId: therapist.id, isPrimary: count === 0 },
      });
    }
    res.json({ message: `Connected to ${therapist.fullName}`, therapists: await listTherapists(profile.id) });
  } catch (error) {
    console.error("❌ Link therapist error:", error);
    res.status(500).json({ error: "Failed to link therapist" });
  }
});

// Patient disconnects from a therapist.
app.delete("/api/patient/therapists/:therapistId", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== "PATIENT") return res.status(403).json({ error: "Only patients can do this" });
    const profile = await prisma.patientProfile.findUnique({ where: { userId: req.user.userId } });
    if (!profile) return res.status(404).json({ error: "Patient profile not found" });
    await prisma.patientTherapist.deleteMany({
      where: { patientProfileId: profile.id, therapistId: req.params.therapistId },
    });
    res.json({ message: "Disconnected", therapists: await listTherapists(profile.id) });
  } catch (error) {
    console.error("❌ Unlink therapist error:", error);
    res.status(500).json({ error: "Failed to disconnect" });
  }
});

// Caregiver enters a patient's invite code.
app.post("/api/caregiver/link-patient", authenticateToken, linkRateLimit(15), async (req, res) => {
  try {
    if (req.user.role !== "CAREGIVER") {
      return res.status(403).json({ error: "Only caregivers can link to a patient" });
    }
    const code = String(req.body?.inviteCode || "").trim().toUpperCase();
    if (!code) return res.status(400).json({ error: "Please enter the patient's invite code" });

    const relationship = ["PARENT", "GUARDIAN", "SPOUSE", "OTHER"].includes(req.body?.relationship)
      ? req.body.relationship
      : "OTHER";

    const profile = await prisma.patientProfile.findUnique({
      where: { inviteCode: code },
      include: { user: { select: { id: true, fullName: true } } },
    });
    if (!profile) return res.status(404).json({ error: "That invite code isn't valid. Ask the patient to check their code." });

    const existing = await prisma.patientCaregiver.findFirst({
      where: { patientProfileId: profile.id, caregiverId: req.user.userId },
    });
    if (!existing) {
      await prisma.patientCaregiver.create({
        data: { patientProfileId: profile.id, caregiverId: req.user.userId, relationship },
      });
    }
    res.json({ message: `Connected to ${profile.user.fullName}` });
  } catch (error) {
    console.error("❌ Link patient error:", error);
    res.status(500).json({ error: "Failed to link patient" });
  }
});

// =========================
// PATIENTS (only the ones linked to you)
// =========================

app.get("/api/patients", authenticateToken, async (req, res) => {
  try {
    let where;
    if (req.user.role === "THERAPIST") {
      where = { role: "PATIENT", patientProfile: { therapists: { some: { therapistId: req.user.userId } } } };
    } else if (req.user.role === "CAREGIVER") {
      where = { role: "PATIENT", patientProfile: { caregivers: { some: { caregiverId: req.user.userId } } } };
    } else {
      return res.status(403).json({ error: "Patients cannot list other patients" });
    }
    const patients = await prisma.user.findMany({
      where,
      select: { id: true, email: true, fullName: true, role: true, organizationId: true, createdAt: true },
    });
    res.json(patients);
  } catch (error) {
    console.error("❌ Patients error:", error);
    res.status(500).json({ error: "Failed to fetch patients" });
  }
});

// =========================
// PATIENT EXERCISES
// =========================

app.get("/api/patients/:patientId/exercises", authenticateToken, guardPatient, async (req, res) => {
  try {
    const patientProfile = await prisma.patientProfile.findUnique({
      where: { userId: req.params.patientId },
    });
    if (!patientProfile) return res.status(404).json({ error: "Patient profile not found" });

    const assignments = await prisma.exerciseAssignment.findMany({
      where: { patientProfileId: patientProfile.id },
      include: { exercise: true },
      orderBy: { dueDate: "asc" },
    });
    res.json(assignments);
  } catch (error) {
    console.error("❌ Exercises error:", error);
    res.status(500).json({ error: "Failed to fetch patient exercises" });
  }
});

// =========================
// MARK EXERCISE COMPLETE (Gamification)
// =========================

app.post("/api/exercise-assignments/:assignmentId/complete", authenticateToken, async (req, res) => {
  try {
    const { assignmentId } = req.params;

    const assignment = await prisma.exerciseAssignment.findUnique({
      where: { id: assignmentId },
      include: { exercise: true, patientProfile: true },
    });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    // Only the patient themselves can complete their own exercise.
    if (req.user.role !== "PATIENT" || req.user.userId !== assignment.patientProfile.userId) {
      return res.status(403).json({ error: "You can't complete someone else's exercise" });
    }

    if (assignment.isCompleted) {
      return res.json({
        message: "This exercise was already marked complete",
        alreadyCompleted: true,
        assignment,
      });
    }

    const profile = assignment.patientProfile;
    const points = assignment.exercise.gamePointsValue || 10;
    const now = new Date();

    // Streak: same calendar day keeps it, next day extends it, otherwise resets to 1.
    let newStreak = 1;
    if (profile.lastPracticeAt) {
      const dayMs = 86400000;
      const lastDay = Math.floor(new Date(profile.lastPracticeAt).setHours(0, 0, 0, 0) / dayMs);
      const today = Math.floor(new Date(now).setHours(0, 0, 0, 0) / dayMs);
      const diff = today - lastDay;
      if (diff === 0) newStreak = profile.currentStreak || 1;
      else if (diff === 1) newStreak = (profile.currentStreak || 0) + 1;
      else newStreak = 1;
    }
    const newLongest = Math.max(profile.longestStreak || 0, newStreak);

    const updatedAssignment = await prisma.exerciseAssignment.update({
      where: { id: assignmentId },
      data: { isCompleted: true, completedAt: now, pointsAwarded: points },
      include: { exercise: true },
    });

    const updatedProfile = await prisma.patientProfile.update({
      where: { id: profile.id },
      data: {
        totalPoints: (profile.totalPoints || 0) + points,
        currentStreak: newStreak,
        longestStreak: newLongest,
        lastPracticeAt: now,
      },
    });

    res.json({
      message: "Exercise marked complete!",
      pointsAwarded: points,
      assignment: updatedAssignment,
      totalPoints: updatedProfile.totalPoints,
      currentStreak: updatedProfile.currentStreak,
      longestStreak: updatedProfile.longestStreak,
    });
  } catch (error) {
    console.error("❌ Complete exercise error:", error);
    res.status(500).json({ error: "Failed to mark exercise complete" });
  }
});

// =========================
// PATIENT PROFILE / SUMMARY
// =========================

app.get("/api/patients/:patientId/profile", authenticateToken, guardPatient, async (req, res) => {
  try {
    const { patientId } = req.params;

    const patient = await prisma.user.findUnique({
      where: { id: patientId },
      select: { id: true, email: true, fullName: true, role: true, organizationId: true },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    const profile = await prisma.patientProfile.findUnique({ where: { userId: patientId } });
    if (!profile) return res.status(404).json({ error: "Patient profile not found" });

    res.json({ patient, profile });
  } catch (error) {
    console.error("❌ Patient profile error:", error);
    res.status(500).json({ error: "Failed to fetch patient profile" });
  }
});

// =========================
// SMARTER AI EXERCISE GENERATION
// =========================
// Uses diagnosis, level, recent scores, the patient's weakest area, wellness
// (e.g. don't assign strenuous voice work when the throat is sore), and the
// titles already assigned (to avoid repeats). Falls back to an offline bank.

async function generateExercisesForPatient({ patientProfile, ctx, count = 3 }) {
  const existingTitles = ctx.assignments.map((a) => a.exercise?.title).filter(Boolean).slice(0, 25);

  const throatSore = ctx.flags.includes("throat discomfort") || ctx.flags.includes("high fatigue");

  if (GEMINI_API_KEY) {
    try {
      const prompt = `Patient context:
${contextToText(patientProfile, ctx)}

Exercises already assigned (do NOT repeat or closely copy these): ${existingTitles.join("; ") || "none"}

Task: create ${count} NEW home speech/voice exercises for this patient.
Requirements:
- Match difficulty to level ${patientProfile.currentDifficultyLevel} (you may use level ±1).
- Target the patient's actual need from the diagnosis and notes; vary categories ARTICULATION / FLUENCY / VOICE only where clinically sensible.
- ${throatSore ? "The patient reports throat discomfort or fatigue: avoid loud, high-effort or long voice-loading tasks; prefer gentle breathing, humming, straw phonation and relaxation." : "Use evidence-based techniques (breath support, easy onset, pacing, minimal pairs, straw phonation, resonant voice, pull-outs) as appropriate."}
- Each instruction must be concrete, safe to do alone at home, include a number of repetitions or duration, and take under 5 minutes.
- If the diagnosis is "Pending assessment", choose general foundation exercises (breathing, gentle voice warm-up, easy onset).
- Plain, encouraging language a patient or parent can follow.

Respond with ONLY a JSON array in exactly this shape:
[{"title":"under 8 words","description":"one sentence","category":"ARTICULATION|FLUENCY|VOICE","difficultyLevel":1-5,"targetPhonemes":["..."],"instructions":"1-3 sentences","gamePointsValue":5-30}]`;

      const text = await callGemini(prompt, {
        json: true,
        system: SLP_SYSTEM_PROMPT,
        temperature: 0.7,
        maxOutputTokens: 1500,
      });
      const generated = parseJsonLoose(text);
      if (Array.isArray(generated) && generated.length) return { generated: generated.slice(0, count), source: "ai" };
    } catch (err) {
      console.warn("⚠️ AI exercise generation failed, using offline bank:", err.message);
    }
  }

  // Offline fallback: closest-level exercises not already assigned.
  const lvl = patientProfile.currentDifficultyLevel;
  const owned = new Set(existingTitles.map((t) => t.toLowerCase()));
  let pool = FALLBACK_EXERCISES.filter((e) => !owned.has(e.title.toLowerCase()));
  if (!pool.length) pool = FALLBACK_EXERCISES;
  if (throatSore) pool = pool.filter((e) => e.category !== "VOICE" || e.difficultyLevel <= 2);
  pool = [...pool].sort((a, b) => Math.abs(a.difficultyLevel - lvl) - Math.abs(b.difficultyLevel - lvl));
  return { generated: pool.slice(0, count), source: "offline" };
}

async function createAndAssignExercises({ generated, patientProfile, userId }) {
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 7);

  const created = [];
  for (const item of generated) {
    const category = ["ARTICULATION", "FLUENCY", "VOICE"].includes(item.category) ? item.category : "ARTICULATION";
    const difficultyLevel = Number.isInteger(item.difficultyLevel)
      ? Math.max(1, Math.min(5, item.difficultyLevel))
      : patientProfile.currentDifficultyLevel;

    const exercise = await prisma.exercise.create({
      data: {
        organizationId: patientProfile.organizationId,
        createdById: userId,
        title: String(item.title || "Practice exercise").slice(0, 200),
        description: String(item.description || ""),
        category,
        difficultyLevel,
        targetPhonemes: Array.isArray(item.targetPhonemes) ? item.targetPhonemes.map(String) : [],
        instructions: String(item.instructions || ""),
        gamePointsValue: Number.isInteger(item.gamePointsValue)
          ? Math.max(5, Math.min(30, item.gamePointsValue))
          : 10,
      },
    });

    const assignment = await prisma.exerciseAssignment.create({
      data: {
        organizationId: patientProfile.organizationId,
        patientProfileId: patientProfile.id,
        exerciseId: exercise.id,
        assignedById: userId,
        dueDate,
      },
      include: { exercise: true },
    });
    created.push(assignment);
  }
  return created;
}

app.post(
  "/api/patients/:patientId/generate-exercises",
  authenticateToken,
  guardPatient,
  aiRateLimit(15),
  async (req, res) => {
    try {
      const patientProfile = await prisma.patientProfile.findUnique({
        where: { userId: req.params.patientId },
      });
      if (!patientProfile) return res.status(404).json({ error: "Patient profile not found" });

      const ctx = await loadPatientContext(patientProfile);
      const { generated, source } = await generateExercisesForPatient({ patientProfile, ctx });
      const created = await createAndAssignExercises({ generated, patientProfile, userId: req.user.userId });

      res.json({ message: "New exercises generated", source, assignments: created });
    } catch (error) {
      console.error("❌ Exercise generation error:", error);
      res.status(500).json({ error: error.message || "Failed to generate exercises" });
    }
  }
);

// =========================
// AI PROGRESS REPORT (structured, with offline fallback)
// =========================

function ruleBasedReport(profile, ctx) {
  const { stats, wellness, flags } = ctx;
  const level = profile.currentDifficultyLevel;
  let difficultyAdvice = "keep";
  let headline = "Maintain current difficulty";

  if (stats.sessions >= 2) {
    if (stats.avgPronunciation >= 85 && stats.trend !== "declining") {
      difficultyAdvice = "increase";
      headline = "Ready to increase difficulty";
    } else if (stats.avgPronunciation < 60 || stats.trend === "declining") {
      difficultyAdvice = "decrease";
      headline = "Reinforce the fundamentals";
    }
  } else {
    headline = "Collect more practice sessions";
  }
  if (flags.includes("throat discomfort") || flags.includes("high fatigue")) {
    if (difficultyAdvice === "increase") difficultyAdvice = "keep";
  }

  const strengths = [];
  const concerns = [];
  if (stats.trend === "improving") strengths.push("Pronunciation scores are trending upward.");
  if (profile.currentStreak >= 3) strengths.push(`${profile.currentStreak}-day practice streak shows good consistency.`);
  if (stats.avgClarity >= 70) strengths.push("Speech clarity is generally good.");
  if (stats.trend === "declining") concerns.push("Recent scores are lower than earlier ones.");
  if (stats.sessionsLast7d < 2 && stats.sessions > 0) concerns.push("Few practice sessions in the last 7 days.");
  if (stats.variability > 15) concerns.push("Scores vary a lot between sessions; check recording environment and fatigue.");
  flags.forEach((f) => concerns.push(`Wellness flag: ${f}.`));
  if (!strengths.length) strengths.push("Keep going — every session builds the habit.");

  const careTips = [];
  if (flags.includes("low water intake")) careTips.push("Encourage regular sips of water through the day.");
  if (flags.includes("short sleep")) careTips.push("Aim for 7–8 hours of sleep; tired voices tire faster.");
  if (flags.includes("throat discomfort")) careTips.push("Avoid throat clearing and shouting; try gentle humming and steam inhalation, and see a doctor if it lasts over 2–3 weeks.");
  careTips.push("Practice in short 5–10 minute sessions in a quiet room, ideally at the same time daily.");
  careTips.push("Praise effort, not just scores.");

  return {
    headline,
    summary: stats.sessions
      ? `Across ${stats.sessions} session(s), average pronunciation is ${stats.avgPronunciation}% (${stats.trend}). Current level is ${level}/5.`
      : "No sessions recorded yet. Start with a short breathing and humming routine and record a first sample.",
    trend: stats.trend,
    difficultyAdvice,
    strengths,
    concerns,
    focusAreas: [profile.primaryDiagnosis && profile.primaryDiagnosis !== "Pending assessment" ? `Targets related to: ${profile.primaryDiagnosis}` : "Complete a clinical assessment to set targeted goals"],
    caregiverTips: careTips,
    redFlags: [],
    encouragement: "Small, steady practice makes a big difference. You're doing well.",
    source: "rules",
  };
}

async function buildReport(profile, ctx) {
  const base = ruleBasedReport(profile, ctx);
  if (!GEMINI_API_KEY) return base;

  try {
    const prompt = `Write a clinical-style progress review for a clinician or caregiver based ONLY on this data.

${contextToText(profile, ctx)}

Pre-computed rule-based view (you may agree or refine it, but stay consistent with the numbers): difficulty advice = ${base.difficultyAdvice}, trend = ${base.trend}.

Rules:
- Interpret the numbers carefully; scores are demo heuristics, not clinical measurements, so mention uncertainty briefly when sessions are few (<4).
- Link wellness data (sleep, water, throat comfort, fatigue, mood) to practice quality where the data supports it.
- "difficultyAdvice" must be exactly one of: "increase", "keep", "decrease".
- "redFlags": only genuine concerns that warrant clinical follow-up (e.g. persistent throat discomfort, big sustained decline, very low mood); otherwise an empty array.
- Keep each list item to one short sentence. 2-4 items per list.

Respond with ONLY this JSON:
{"headline":"max 8 words","summary":"2-3 sentences","trend":"improving|stable|declining|not enough data","difficultyAdvice":"increase|keep|decrease","strengths":["..."],"concerns":["..."],"focusAreas":["..."],"caregiverTips":["..."],"redFlags":["..."],"encouragement":"one warm sentence"}`;

    const text = await callGemini(prompt, {
      json: true,
      system: SLP_SYSTEM_PROMPT,
      temperature: 0.3,
      maxOutputTokens: 1400,
    });
    const r = parseJsonLoose(text);
    const arr = (v) => (Array.isArray(v) ? v.map(String).slice(0, 5) : []);
    return {
      headline: String(r.headline || base.headline),
      summary: String(r.summary || base.summary),
      trend: String(r.trend || base.trend),
      difficultyAdvice: ["increase", "keep", "decrease"].includes(r.difficultyAdvice) ? r.difficultyAdvice : base.difficultyAdvice,
      strengths: arr(r.strengths).length ? arr(r.strengths) : base.strengths,
      concerns: arr(r.concerns),
      focusAreas: arr(r.focusAreas).length ? arr(r.focusAreas) : base.focusAreas,
      caregiverTips: arr(r.caregiverTips).length ? arr(r.caregiverTips) : base.caregiverTips,
      redFlags: arr(r.redFlags),
      encouragement: String(r.encouragement || base.encouragement),
      source: "ai",
    };
  } catch (err) {
    console.warn("⚠️ AI report failed, using rule-based report:", err.message);
    return base;
  }
}

app.post(
  "/api/patients/:patientId/ai-report",
  authenticateToken,
  guardPatient,
  aiRateLimit(20),
  async (req, res) => {
    try {
      if (!["THERAPIST", "CAREGIVER"].includes(req.user.role)) {
        return res.status(403).json({ error: "Only therapists or caregivers can request an AI report" });
      }
      const patientProfile = await prisma.patientProfile.findUnique({
        where: { userId: req.params.patientId },
      });
      if (!patientProfile) return res.status(404).json({ error: "Patient profile not found" });

      const ctx = await loadPatientContext(patientProfile);
      const report = await buildReport(patientProfile, ctx);
      res.json({ report, stats: ctx.stats, wellness: ctx.wellness, generatedAt: new Date().toISOString() });
    } catch (error) {
      console.error("❌ AI report error:", error);
      res.status(500).json({ error: error.message || "Failed to generate report" });
    }
  }
);

// Backwards-compatible short recommendation (the existing "Get AI recommendation" button).
app.post(
  "/api/patients/:patientId/ai-recommendation",
  authenticateToken,
  guardPatient,
  aiRateLimit(20),
  async (req, res) => {
    try {
      if (!["THERAPIST", "CAREGIVER"].includes(req.user.role)) {
        return res.status(403).json({ error: "Only therapists or caregivers can request an AI recommendation" });
      }
      const patientProfile = await prisma.patientProfile.findUnique({
        where: { userId: req.params.patientId },
      });
      if (!patientProfile) return res.status(404).json({ error: "Patient profile not found" });

      const ctx = await loadPatientContext(patientProfile);
      const r = await buildReport(patientProfile, ctx);

      const adviceText = { increase: "increase the difficulty level", keep: "keep the current difficulty level", decrease: "lower the difficulty level for a while" }[r.difficultyAdvice];
      const recommendation =
        `${r.summary} Recommendation: ${adviceText}. ` +
        `${r.focusAreas[0] ? `Focus: ${r.focusAreas[0]} ` : ""}` +
        `${r.concerns[0] ? `Watch for: ${r.concerns[0]} ` : ""}` +
        `${r.redFlags.length ? `Follow-up needed: ${r.redFlags[0]} ` : ""}` +
        `${r.encouragement}`;

      res.json({ recommendation: recommendation.trim(), report: r });
    } catch (error) {
      console.error("❌ AI recommendation error:", error);
      res.status(500).json({ error: error.message || "Failed to generate recommendation" });
    }
  }
);

// =========================
// AI SPEECH COACH CHAT (patient / caregiver)
// =========================

app.post(
  "/api/patients/:patientId/coach-chat",
  authenticateToken,
  guardPatient,
  aiRateLimit(40),
  async (req, res) => {
    try {
      const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
      const messages = incoming
        .filter((m) => m && typeof m.text === "string" && m.text.trim())
        .slice(-10)
        .map((m) => ({ role: m.role === "assistant" ? "model" : "user", text: m.text.trim().slice(0, 800) }));

      if (!messages.length || messages[messages.length - 1].role !== "user") {
        return res.status(400).json({ error: "Send at least one user message" });
      }

      const lastUserText = messages[messages.length - 1].text;

      // Safety first, rule-based (no AI needed, instant, free).
      if (looksLikeEmergency(lastUserText)) {
        return res.json({ reply: EMERGENCY_REPLY, emergency: true, source: "safety" });
      }

      const patientProfile = await prisma.patientProfile.findUnique({
        where: { userId: req.params.patientId },
      });
      if (!patientProfile) return res.status(404).json({ error: "Patient profile not found" });

      if (!GEMINI_API_KEY) {
        return res.json({
          reply:
            "The AI coach isn't switched on yet. In the meantime: sip water, breathe slowly from your belly, and do your exercises in short, relaxed sessions. Ask your therapist if anything feels painful or confusing.",
          source: "offline",
        });
      }

      const ctx = await loadPatientContext(patientProfile);
      const firstName = String(ctx.user?.fullName || "").split(" ")[0] || "the patient";
      const system = `${SLP_SYSTEM_PROMPT}

You are chatting with ${firstName} (role: ${req.user.role.toLowerCase()}). Use this context only when it helps answer; do not recite it:
${contextToText(patientProfile, ctx)}`;

      // Gemini requires the first turn to be from the user.
      while (messages.length && messages[0].role !== "user") messages.shift();
      const contents = messages.map((m) => ({ role: m.role, parts: [{ text: m.text }] }));

      const reply = await callGemini("", { system, contents, temperature: 0.6, maxOutputTokens: 600 });
      res.json({ reply, source: "ai" });
    } catch (error) {
      console.error("❌ Coach chat error:", error);
      res.status(500).json({ error: "The coach is resting for a moment. Please try again shortly." });
    }
  }
);

// =========================
// WELLNESS CHECK-INS
// =========================

app.post("/api/patients/:patientId/wellness", authenticateToken, guardPatient, async (req, res) => {
  try {
    const clamp = (v, lo, hi, d) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
    };
    const mood = Math.round(clamp(req.body.mood, 1, 5, 3));
    const fatigue = Math.round(clamp(req.body.fatigue, 1, 5, 3));
    const throatComfort = Math.round(clamp(req.body.throatComfort, 1, 5, 3));
    const hydration = Math.round(clamp(req.body.hydration, 0, 20, 0));
    const sleepHours = +clamp(req.body.sleepHours, 0, 24, 7).toFixed(1);
    const notes = String(req.body.notes || "").trim().slice(0, 500);

    const profile = await prisma.patientProfile.findUnique({ where: { userId: req.params.patientId } });
    if (!profile) return res.status(404).json({ error: "Patient profile not found" });

    const checkIn = await prisma.wellnessCheckIn.create({
      data: { patientProfileId: profile.id, mood, fatigue, throatComfort, hydration, sleepHours, notes },
    });

    // Instant, rule-based tips so the patient gets value even with AI off.
    const tips = [];
    if (hydration < 5) tips.push("Try to drink water regularly today — hydrated vocal folds work more easily.");
    if (sleepHours < 6) tips.push("Short sleep tires the voice. Keep practice gentle and short today.");
    if (throatComfort <= 2) tips.push("Your throat feels uncomfortable: skip loud or long voice work, avoid throat clearing, and try gentle humming or steam. See a doctor if this lasts more than 2–3 weeks.");
    if (fatigue >= 4) tips.push("You're tired — a 5-minute breathing exercise is plenty today.");
    if (mood <= 2) tips.push("Low days happen. A tiny win counts — and talking to someone you trust can help.");
    if (!tips.length) tips.push("Great check-in! Your body looks ready for a normal practice session.");

    const needsAttention = looksLikeEmergency(notes);
    res.status(201).json({
      checkIn,
      tips,
      ...(needsAttention ? { emergency: true, emergencyMessage: EMERGENCY_REPLY } : {}),
    });
  } catch (error) {
    console.error("❌ Wellness save error:", error);
    res.status(500).json({ error: "Failed to save check-in" });
  }
});

app.get("/api/patients/:patientId/wellness", authenticateToken, guardPatient, async (req, res) => {
  try {
    const profile = await prisma.patientProfile.findUnique({ where: { userId: req.params.patientId } });
    if (!profile) return res.status(404).json({ error: "Patient profile not found" });

    const rows = await prisma.wellnessCheckIn.findMany({
      where: { patientProfileId: profile.id },
      orderBy: { createdAt: "desc" },
      take: 14,
    });
    res.json({ checkIns: rows, summary: summarizeWellness(rows), flags: vocalHygieneFlags(summarizeWellness(rows)) });
  } catch (error) {
    console.error("❌ Wellness fetch error:", error);
    res.status(500).json({ error: "Failed to fetch check-ins" });
  }
});

// =========================
// AUDIO UPLOAD + ANALYSIS
// =========================

app.post("/api/audio/upload", authenticateToken, upload.single("audio"), async (req, res) => {
  try {
    if (req.user.role !== "PATIENT") {
      return res.status(403).json({ error: "Only patients can upload recordings" });
    }
    if (!req.file) return res.status(400).json({ error: "No audio file uploaded" });

    const patientProfile = await prisma.patientProfile.findUnique({
      where: { userId: req.user.userId },
    });
    if (!patientProfile) return res.status(404).json({ error: "Patient profile not found" });

    // Attach the recording to the first INCOMPLETE assignment (falls back to any).
    let assignment = await prisma.exerciseAssignment.findFirst({
      where: { patientProfileId: patientProfile.id, isCompleted: false },
      orderBy: { dueDate: "asc" },
    });
    if (!assignment) {
      assignment = await prisma.exerciseAssignment.findFirst({
        where: { patientProfileId: patientProfile.id },
        orderBy: { dueDate: "desc" },
      });
    }
    if (!assignment) return res.status(404).json({ error: "No exercise assigned to this patient" });

    const clampScore = (v) => Math.max(0, Math.min(100, Number(v) || 0));
    const durationSeconds = Math.max(0, Number(req.body.durationSeconds || 0));
    const pitchMeanHz = Math.max(0, Number(req.body.pitchMeanHz || 0));
    const clarityScore = clampScore(req.body.clarityScore);
    const pronunciationScore = clampScore(req.body.pronunciationScore);

    const audioLog = await prisma.audioLog.create({
      data: {
        organizationId: patientProfile.organizationId,
        patientProfileId: patientProfile.id,
        exerciseId: assignment.exerciseId,
        s3Url: req.file.path,
        durationSeconds,
        pitchMeanHz,
        clarityScore,
        pronunciationScore,
        difficultyAtAttempt: patientProfile.currentDifficultyLevel,
      },
    });

    // Smarter adaptive difficulty: decide using the average of the last 3
    // sessions (not one noisy recording) and don't level up when the latest
    // wellness check-in shows fatigue or a sore throat.
    const lastThree = await prisma.audioLog.findMany({
      where: { patientProfileId: patientProfile.id },
      orderBy: { recordedAt: "desc" },
      take: 3,
    });
    const smoothed = avg(lastThree.map((l) => l.pronunciationScore));
    const latestWellness = await prisma.wellnessCheckIn.findFirst({
      where: { patientProfileId: patientProfile.id },
      orderBy: { createdAt: "desc" },
    });
    const wellnessToday =
      latestWellness && Date.now() - new Date(latestWellness.createdAt).getTime() < 36 * 3600000;
    const tiredOrSore = wellnessToday && (latestWellness.fatigue >= 4 || latestWellness.throatComfort <= 2);

    const current = patientProfile.currentDifficultyLevel;
    let newDifficulty = current;
    if (lastThree.length >= 2 && smoothed >= 85 && !tiredOrSore) newDifficulty = Math.min(5, current + 1);
    else if (smoothed < 60 && lastThree.length >= 2) newDifficulty = Math.max(1, current - 1);
    else if (lastThree.length < 2 && pronunciationScore < 45) newDifficulty = Math.max(1, current - 1);

    if (newDifficulty !== current) {
      await prisma.patientProfile.update({
        where: { id: patientProfile.id },
        data: { currentDifficultyLevel: newDifficulty },
      });
    }

    // Auto-generate exercises when running low or the level changed (never blocks upload).
    let autoGenerated = false;
    try {
      const incompleteCount = await prisma.exerciseAssignment.count({
        where: { patientProfileId: patientProfile.id, isCompleted: false },
      });
      if (incompleteCount < 2 || newDifficulty !== current) {
        const updatedProfile = { ...patientProfile, currentDifficultyLevel: newDifficulty };
        const ctx = await loadPatientContext(updatedProfile);
        const { generated } = await generateExercisesForPatient({ patientProfile: updatedProfile, ctx });
        await createAndAssignExercises({ generated, patientProfile, userId: req.user.userId });
        autoGenerated = true;
      }
    } catch (genErr) {
      console.error("⚠️ Auto exercise generation skipped:", genErr.message);
    }

    res.json({
      message: "Speech analyzed and uploaded successfully!",
      filename: req.file.filename,
      path: req.file.path,
      audioLogId: audioLog.id,
      analysis: { durationSeconds, pitchMeanHz, clarityScore, pronunciationScore },
      difficulty: { previous: current, current: newDifficulty },
      newExercisesGenerated: autoGenerated,
    });
  } catch (error) {
    console.error("❌ Audio upload error:", error);
    res.status(500).json({ error: "Failed to upload and save audio" });
  }
});

// =========================
// PATIENT AUDIO LOGS
// =========================

app.get("/api/patients/:patientId/audio-logs", authenticateToken, guardPatient, async (req, res) => {
  try {
    const patientProfile = await prisma.patientProfile.findUnique({
      where: { userId: req.params.patientId },
    });
    if (!patientProfile) return res.status(404).json({ error: "Patient profile not found" });

    const audioLogs = await prisma.audioLog.findMany({
      where: { patientProfileId: patientProfile.id },
      include: { exercise: true },
      orderBy: { recordedAt: "desc" },
    });
    res.json(audioLogs);
  } catch (error) {
    console.error("❌ Audio logs error:", error);
    res.status(500).json({ error: "Failed to fetch audio logs" });
  }
});

// =========================
// PATIENT DASHBOARD DATA
// =========================

app.get("/api/patients/:patientId/dashboard", authenticateToken, guardPatient, async (req, res) => {
  try {
    const { patientId } = req.params;

    const patientProfile = await prisma.patientProfile.findUnique({ where: { userId: patientId } });
    if (!patientProfile) return res.status(404).json({ error: "Patient profile not found" });

    const user = await prisma.user.findUnique({
      where: { id: patientId },
      select: { id: true, fullName: true, email: true, role: true },
    });

    const assignments = await prisma.exerciseAssignment.findMany({
      where: { patientProfileId: patientProfile.id },
      include: { exercise: true },
      orderBy: { dueDate: "asc" },
    });

    const audioLogs = await prisma.audioLog.findMany({
      where: { patientProfileId: patientProfile.id },
      include: { exercise: true },
      orderBy: { recordedAt: "desc" },
    });

    const latestAudio = audioLogs.length > 0 ? audioLogs[0] : null;

    res.json({
      patient: user,
      profile: {
        id: patientProfile.id,
        currentDifficultyLevel: patientProfile.currentDifficultyLevel,
        diagnosis: patientProfile.primaryDiagnosis,
        clinicalNotes: patientProfile.clinicalNotes,
        dateOfBirth: patientProfile.dateOfBirth,
        totalPoints: patientProfile.totalPoints,
        currentStreak: patientProfile.currentStreak,
        longestStreak: patientProfile.longestStreak,
      },
      exercises: assignments,
      audioLogs,
      latestAnalysis: latestAudio
        ? {
            durationSeconds: latestAudio.durationSeconds,
            pitchMeanHz: latestAudio.pitchMeanHz,
            clarityScore: latestAudio.clarityScore,
            pronunciationScore: latestAudio.pronunciationScore,
            difficultyAtAttempt: latestAudio.difficultyAtAttempt,
            recordedAt: latestAudio.recordedAt,
          }
        : null,
    });
  } catch (error) {
    console.error("❌ Dashboard error:", error);
    res.status(500).json({ error: "Failed to fetch patient dashboard" });
  }
});

// =========================
// THERAPIST DASHBOARD (only patients linked via this therapist's code)
// =========================

app.get("/api/therapist/dashboard", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== "THERAPIST") {
      return res.status(403).json({ error: "Only therapists can access this dashboard" });
    }

    const patients = await prisma.user.findMany({
      where: {
        role: "PATIENT",
        patientProfile: { therapists: { some: { therapistId: req.user.userId } } },
      },
      select: { id: true, fullName: true, email: true, organizationId: true, createdAt: true },
      orderBy: { fullName: "asc" },
    });

    const patientsWithStats = await Promise.all(
      patients.map(async (patient) => {
        const profile = await prisma.patientProfile.findUnique({ where: { userId: patient.id } });

        if (!profile) {
          return {
            ...patient,
            currentDifficultyLevel: 0,
            exerciseCount: 0,
            audioLogCount: 0,
            latestPronunciationScore: 0,
            latestClarityScore: 0,
            latestPitchMeanHz: 0,
            totalPoints: 0,
            currentStreak: 0,
          };
        }

        const [exerciseCount, audioLogCount, latestAudio] = await Promise.all([
          prisma.exerciseAssignment.count({ where: { patientProfileId: profile.id } }),
          prisma.audioLog.count({ where: { patientProfileId: profile.id } }),
          prisma.audioLog.findFirst({
            where: { patientProfileId: profile.id },
            orderBy: { recordedAt: "desc" },
          }),
        ]);

        return {
          ...patient,
          currentDifficultyLevel: profile.currentDifficultyLevel,
          diagnosis: profile.primaryDiagnosis,
          exerciseCount,
          audioLogCount,
          latestPronunciationScore: latestAudio ? latestAudio.pronunciationScore : 0,
          latestClarityScore: latestAudio ? latestAudio.clarityScore : 0,
          latestPitchMeanHz: latestAudio ? latestAudio.pitchMeanHz : 0,
          latestRecordedAt: latestAudio ? latestAudio.recordedAt : null,
          totalPoints: profile.totalPoints,
          currentStreak: profile.currentStreak,
        };
      })
    );

    res.json({
      therapist: { id: req.user.userId, role: req.user.role },
      totalPatients: patientsWithStats.length,
      patients: patientsWithStats,
    });
  } catch (error) {
    console.error("❌ Therapist dashboard error:", error);
    res.status(500).json({ error: "Failed to load therapist dashboard" });
  }
});

// =========================
// THERAPIST PATIENT DETAILS
// =========================

app.get("/api/therapist/patients/:patientId", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== "THERAPIST") {
      return res.status(403).json({ error: "Only therapists can access patient details" });
    }

    const { patientId } = req.params;

    if (!(await canAccessPatient(req, patientId))) {
      return res.status(403).json({ error: "This patient isn't linked to you" });
    }

    const patient = await prisma.user.findUnique({
      where: { id: patientId },
      select: { id: true, fullName: true, email: true, role: true, organizationId: true, createdAt: true },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    const profile = await prisma.patientProfile.findUnique({ where: { userId: patientId } });
    if (!profile) return res.status(404).json({ error: "Patient profile not found" });

    const exercises = await prisma.exerciseAssignment.findMany({
      where: { patientProfileId: profile.id },
      include: { exercise: true },
      orderBy: { dueDate: "asc" },
    });

    const audioLogs = await prisma.audioLog.findMany({
      where: { patientProfileId: profile.id },
      include: { exercise: true },
      orderBy: { recordedAt: "desc" },
    });

    res.json({
      patient,
      profile: {
        id: profile.id,
        currentDifficultyLevel: profile.currentDifficultyLevel,
        diagnosis: profile.primaryDiagnosis,
        clinicalNotes: profile.clinicalNotes,
        dateOfBirth: profile.dateOfBirth,
        totalPoints: profile.totalPoints,
        currentStreak: profile.currentStreak,
        longestStreak: profile.longestStreak,
      },
      exercises,
      audioLogs,
    });
  } catch (error) {
    console.error("❌ Therapist patient error:", error);
    res.status(500).json({ error: "Failed to fetch patient details" });
  }
});

// =========================
// CAREGIVER FEEDBACK
// =========================

app.get("/api/patients/:patientId/feedback", authenticateToken, guardPatient, async (req, res) => {
  try {
    const profile = await prisma.patientProfile.findUnique({ where: { userId: req.params.patientId } });
    if (!profile) return res.status(404).json({ error: "Patient profile not found" });

    const feedback = await prisma.caregiverFeedback.findMany({
      where: { patientProfileId: profile.id },
      orderBy: { createdAt: "desc" },
    });
    res.json(feedback);
  } catch (error) {
    console.error("❌ Feedback error:", error);
    res.status(500).json({ error: "Failed to fetch caregiver feedback" });
  }
});

app.post("/api/patients/:patientId/feedback", authenticateToken, guardPatient, async (req, res) => {
  try {
    if (!["CAREGIVER", "THERAPIST"].includes(req.user.role)) {
      return res.status(403).json({ error: "Only caregivers or therapists can submit feedback" });
    }

    const { patientId } = req.params;
    const { feedbackText, moodRating } = req.body;

    if (!feedbackText || !String(feedbackText).trim()) {
      return res.status(400).json({ error: "Feedback text is required" });
    }

    const rating = Number(moodRating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: "Mood rating must be a whole number between 1 and 5" });
    }

    const profile = await prisma.patientProfile.findUnique({ where: { userId: patientId } });
    if (!profile) return res.status(404).json({ error: "Patient profile not found" });

    const feedback = await prisma.caregiverFeedback.create({
      data: {
        organizationId: profile.organizationId,
        patientProfileId: profile.id,
        caregiverId: req.user.userId,
        feedbackText: String(feedbackText).trim().slice(0, 1000),
        moodRating: rating,
      },
    });

    res.status(201).json(feedback);
  } catch (error) {
    console.error("❌ Feedback submit error:", error);
    res.status(500).json({ error: "Failed to submit feedback" });
  }
});

// =========================
// START SERVER
// =========================

// Gives existing therapists / patients a code the first time the new version boots.
async function backfillCodes() {
  try {
    const therapists = await prisma.user.findMany({ where: { role: "THERAPIST", therapistCode: null }, select: { id: true } });
    for (const t of therapists) {
      await prisma.user.update({ where: { id: t.id }, data: { therapistCode: await generateUniqueCode("THR") } });
    }
    const patients = await prisma.patientProfile.findMany({ where: { inviteCode: null }, select: { id: true } });
    for (const p of patients) {
      await prisma.patientProfile.update({ where: { id: p.id }, data: { inviteCode: await generateUniqueCode("PAT") } });
    }
  } catch (err) {
    console.warn("⚠️ Code backfill skipped:", err.message);
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Swar Saathi backend running on port ${PORT}`);
  backfillCodes();
});