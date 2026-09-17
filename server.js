require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { PrismaClient } = require("@prisma/client");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const prisma = new PrismaClient();

// =========================
// CONFIGURATION
// =========================

const PORT = process.env.PORT || 3000;

// For production, set JWT_SECRET in Render Environment Variables.
// The fallback keeps your current local setup working.
const JWT_SECRET =
  process.env.JWT_SECRET || "speech-db-secret-key";

const VALID_ROLES = ["PATIENT", "THERAPIST", "CAREGIVER"];

// Set ANTHROPIC_API_KEY in Render's Environment tab to enable AI-generated
// exercises and AI-generated clinical recommendations. If it's missing, the
// app still runs — those features are just skipped instead of crashing.
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// =========================
// CORS
// =========================

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());

// =========================
// FILE UPLOAD
// =========================

const upload = multer({
  dest: "uploads/",
});

// =========================
// AUTHENTICATION
// =========================

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      error: "Access token required",
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    req.user = decoded;

    next();
  } catch (error) {
    return res.status(403).json({
      error: "Invalid or expired token",
    });
  }
};

// =========================
// HOME
// =========================

app.get("/", (req, res) => {
  res.json({
    message: "Speech-DB backend is working! 🚀",
    frontend: "https://swar-saathi.netlify.app",
    status: "online",
  });
});

// =========================
// HEALTH CHECK
// =========================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Swar Saathi backend is healthy",
    aiExercisesEnabled: Boolean(anthropic),
  });
});

// =========================
// USERS
// =========================

app.get("/api/users", authenticateToken, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        organizationId: true,
        email: true,
        fullName: true,
        role: true,
        createdAt: true,
      },
    });

    res.json(users);
  } catch (error) {
    console.error("❌ Users error:", error);

    res.status(500).json({
      error: "Failed to fetch users",
    });
  }
});

// =========================
// REGISTER
// =========================

app.post("/api/auth/register", async (req, res) => {
  try {
    const { fullName, email, password, role, dateOfBirth } = req.body;

    if (!fullName || !email || !password) {
      return res.status(400).json({
        error: "Full name, email and password are required",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: "Password must be at least 8 characters",
      });
    }

    const normalizedRole = VALID_ROLES.includes(role) ? role : "PATIENT";
    const normalizedEmail = String(email).trim().toLowerCase();

    if (normalizedRole === "PATIENT" && !dateOfBirth) {
      return res.status(400).json({
        error: "Date of birth is required for patient accounts",
      });
    }

    let parsedDateOfBirth = null;
    if (normalizedRole === "PATIENT") {
      parsedDateOfBirth = new Date(dateOfBirth);
      if (Number.isNaN(parsedDateOfBirth.getTime())) {
        return res.status(400).json({
          error: "That date of birth doesn't look valid",
        });
      }
    }

    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existing) {
      return res.status(409).json({
        error: "An account with this email already exists",
      });
    }

    let organization = await prisma.organization.findFirst();
    if (!organization) {
      organization = await prisma.organization.create({
        data: {
          name: "Swar Saathi",
          slug: `swar-saathi-${Date.now()}`,
          country: "India",
        },
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
      },
    });

    if (normalizedRole === "PATIENT") {
      await prisma.patientProfile.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          currentDifficultyLevel: 1,
          dateOfBirth: parsedDateOfBirth,
          primaryDiagnosis: "Pending assessment",
          clinicalNotes: "No clinical notes yet — pending first session.",
        },
      });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.status(201).json({
      message: "Account created successfully",
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        organizationId: user.organizationId,
      },
    });
  } catch (error) {
    console.error("❌ Register error:", error);

    if (error.code === "P2002") {
      return res.status(409).json({
        error: "An account with this email already exists",
      });
    }

    res.status(500).json({
      error: "Failed to create account",
    });
  }
});

// =========================
// LOGIN
// =========================

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password are required",
      });
    }

    const user = await prisma.user.findUnique({
      where: {
        email: email,
      },
    });

    if (!user) {
      return res.status(401).json({
        error: "Invalid email or password",
      });
    }

    const passwordMatch = await bcrypt.compare(
      password,
      user.passwordHash
    );

    if (!passwordMatch) {
      return res.status(401).json({
        error: "Invalid email or password",
      });
    }

    const token = jwt.sign(
      {
        userId: user.id,
        role: user.role,
      },
      JWT_SECRET,
      {
        expiresIn: "1h",
      }
    );

    res.json({
      message: "Login successful",
      token: token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        organizationId: user.organizationId,
      },
    });
  } catch (error) {
    console.error("❌ Login error:", error);

    res.status(500).json({
      error: "Something went wrong",
    });
  }
});

// =========================
// PATIENTS
// =========================

app.get("/api/patients", authenticateToken, async (req, res) => {
  try {
    const patients = await prisma.user.findMany({
      where: {
        role: "PATIENT",
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        organizationId: true,
        createdAt: true,
      },
    });

    res.json(patients);
  } catch (error) {
    console.error("❌ Patients error:", error);

    res.status(500).json({
      error: "Failed to fetch patients",
    });
  }
});

// =========================
// PATIENT EXERCISES
// =========================

app.get(
  "/api/patients/:patientId/exercises",
  authenticateToken,
  async (req, res) => {
    try {
      const { patientId } = req.params;

      const patientProfile =
        await prisma.patientProfile.findUnique({
          where: {
            userId: patientId,
          },
        });

      if (!patientProfile) {
        return res.status(404).json({
          error: "Patient profile not found",
        });
      }

      const assignments =
        await prisma.exerciseAssignment.findMany({
          where: {
            patientProfileId: patientProfile.id,
          },
          include: {
            exercise: true,
          },
          orderBy: {
            dueDate: "asc",
          },
        });

      res.json(assignments);
    } catch (error) {
      console.error("❌ Exercises error:", error);

      res.status(500).json({
        error: "Failed to fetch patient exercises",
      });
    }
  }
);

// =========================
// MARK EXERCISE COMPLETE (Gamification)
// =========================
//
// Awards the exercise's gamePointsValue to the patient's running total,
// and updates a daily practice streak (consecutive calendar days on which
// at least one exercise was completed). This is what actually makes the
// "gamePointsValue" field on Exercise meaningful — previously it was
// stored but never used anywhere.

app.post(
  "/api/exercise-assignments/:assignmentId/complete",
  authenticateToken,
  async (req, res) => {
    try {
      const { assignmentId } = req.params;

      const assignment = await prisma.exerciseAssignment.findUnique({
        where: { id: assignmentId },
        include: { exercise: true, patientProfile: true },
      });

      if (!assignment) {
        return res.status(404).json({ error: "Assignment not found" });
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

      // Streak logic: same calendar day keeps the streak, the very next
      // day extends it by one, anything else resets it to 1.
      let newStreak = 1;
      if (profile.lastPracticeAt) {
        const last = new Date(profile.lastPracticeAt);
        const dayMs = 86400000;
        const lastDay = Math.floor(last.setHours(0, 0, 0, 0) / dayMs);
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
  }
);

// =========================
// PATIENT PROFILE / SUMMARY
// =========================

app.get(
  "/api/patients/:patientId/profile",
  authenticateToken,
  async (req, res) => {
    try {
      const { patientId } = req.params;

      const patient = await prisma.user.findUnique({
        where: {
          id: patientId,
        },
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          organizationId: true,
        },
      });

      if (!patient) {
        return res.status(404).json({
          error: "Patient not found",
        });
      }

      const profile =
        await prisma.patientProfile.findUnique({
          where: {
            userId: patientId,
          },
        });

      if (!profile) {
        return res.status(404).json({
          error: "Patient profile not found",
        });
      }

      res.json({
        patient,
        profile,
      });
    } catch (error) {
      console.error("❌ Patient profile error:", error);

      res.status(500).json({
        error: "Failed to fetch patient profile",
      });
    }
  }
);

// =========================
// AI EXERCISE GENERATION
// =========================
//
// Uses the patient's current difficulty level, diagnosis/clinical notes,
// and their most recent practice scores to ask Claude for a fresh batch
// of exercises, then saves them as real Exercise rows and assigns them —
// so they show up exactly like therapist-assigned exercises on both the
// patient and therapist dashboards.

async function generateExercisesForPatient({ patientProfile, recentLogs, count = 3 }) {
  if (!anthropic) {
    throw new Error("AI exercise generation isn't configured (ANTHROPIC_API_KEY is missing)");
  }

  const recentScoresText = recentLogs.length
    ? recentLogs
        .slice(0, 5)
        .map(
          (l) =>
            `${Math.round(l.pronunciationScore)}% pronunciation, ${Math.round(l.clarityScore)}% clarity`
        )
        .join("; ")
    : "no practice sessions yet";

  const prompt = `You are a speech-language pathologist assistant generating home practice exercises for a speech therapy app.

Patient context:
- Current difficulty level: ${patientProfile.currentDifficultyLevel} (scale 1-5, 1 easiest, 5 hardest)
- Primary diagnosis: ${patientProfile.primaryDiagnosis}
- Clinical notes: ${patientProfile.clinicalNotes}
- Recent practice results (most recent first): ${recentScoresText}

Generate ${count} new home speech exercises suited to this patient's current level. Vary the category across ARTICULATION, FLUENCY, and VOICE where it makes sense for the diagnosis. Keep instructions short, concrete, and safe to follow alone at home with no supervision.

Respond with ONLY a JSON array (no markdown fences, no other text) in exactly this shape:
[
  {
    "title": "string, under 8 words",
    "description": "one sentence",
    "category": "ARTICULATION" | "FLUENCY" | "VOICE",
    "difficultyLevel": integer 1-5,
    "targetPhonemes": ["string", ...],
    "instructions": "one or two sentences the patient reads and follows",
    "gamePointsValue": integer 5-30
  }
]`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  const cleaned = text.replace(/```json|```/g, "").trim();

  let generated;
  try {
    generated = JSON.parse(cleaned);
  } catch {
    throw new Error("AI response wasn't valid JSON — try again");
  }
  if (!Array.isArray(generated) || !generated.length) {
    throw new Error("AI response didn't contain any exercises");
  }
  return generated;
}

async function createAndAssignExercises({ generated, patientProfile, userId }) {
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 7);

  const created = [];
  for (const item of generated) {
    const category = ["ARTICULATION", "FLUENCY", "VOICE"].includes(item.category)
      ? item.category
      : "ARTICULATION";
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
        targetPhonemes: Array.isArray(item.targetPhonemes)
          ? item.targetPhonemes.map(String)
          : [],
        instructions: String(item.instructions || ""),
        gamePointsValue: Number.isInteger(item.gamePointsValue) ? item.gamePointsValue : 10,
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

// Manual trigger — the patient, their therapist, or a caregiver can request
// a fresh batch of exercises on demand.
app.post(
  "/api/patients/:patientId/generate-exercises",
  authenticateToken,
  async (req, res) => {
    try {
      const { patientId } = req.params;

      const patientProfile = await prisma.patientProfile.findUnique({
        where: { userId: patientId },
      });
      if (!patientProfile) {
        return res.status(404).json({ error: "Patient profile not found" });
      }

      const recentLogs = await prisma.audioLog.findMany({
        where: { patientProfileId: patientProfile.id },
        orderBy: { recordedAt: "desc" },
        take: 5,
      });

      const generated = await generateExercisesForPatient({ patientProfile, recentLogs });
      const created = await createAndAssignExercises({
        generated,
        patientProfile,
        userId: req.user.userId,
      });

      res.json({ message: "New exercises generated", assignments: created });
    } catch (error) {
      console.error("❌ Exercise generation error:", error);
      res.status(500).json({ error: error.message || "Failed to generate exercises" });
    }
  }
);

// =========================
// AI CLINICAL RECOMMENDATION
// =========================
//
// Asks Claude for a short, explainable clinical recommendation (whether to
// change difficulty, what to focus on, and an encouragement note) based on
// this patient's diagnosis and recent scores. This is on-demand (not
// auto-run) so it never blocks other requests and never runs without the
// therapist/caregiver explicitly asking for it.

async function generateRecommendationForPatient({ patientProfile, recentLogs }) {
  if (!anthropic) {
    throw new Error("AI recommendations aren't configured (ANTHROPIC_API_KEY is missing)");
  }

  const scoresText = recentLogs.length
    ? recentLogs
        .slice(0, 5)
        .map(
          (l) =>
            `${Math.round(l.pronunciationScore)}% pronunciation, ${Math.round(l.clarityScore)}% clarity, ~${Math.round(l.pitchMeanHz)}Hz pitch (level ${l.difficultyAtAttempt})`
        )
        .join("; ")
    : "no practice sessions recorded yet";

  const prompt = `You are a speech-language pathologist assistant. Write a short (3-4 sentence) therapy recommendation for a clinician reviewing this patient's dashboard.

Diagnosis: ${patientProfile.primaryDiagnosis}
Clinical notes: ${patientProfile.clinicalNotes}
Current difficulty level: ${patientProfile.currentDifficultyLevel} (1-5, 1 easiest)
Recent session results (most recent first): ${scoresText}

Cover, in flowing plain text (no markdown, no headers, no bullet points):
1. Whether to keep, increase, or decrease the difficulty level, and why.
2. One specific focus area for the next few sessions.
3. One short encouragement note suitable to relay to the patient or caregiver.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 400,
    messages: [{ role: "user", content: prompt }],
  });

  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

app.post(
  "/api/patients/:patientId/ai-recommendation",
  authenticateToken,
  async (req, res) => {
    try {
      if (!["THERAPIST", "CAREGIVER"].includes(req.user.role)) {
        return res.status(403).json({
          error: "Only therapists or caregivers can request an AI recommendation",
        });
      }

      const { patientId } = req.params;
      const patientProfile = await prisma.patientProfile.findUnique({
        where: { userId: patientId },
      });
      if (!patientProfile) {
        return res.status(404).json({ error: "Patient profile not found" });
      }

      const recentLogs = await prisma.audioLog.findMany({
        where: { patientProfileId: patientProfile.id },
        orderBy: { recordedAt: "desc" },
        take: 5,
      });

      const recommendation = await generateRecommendationForPatient({
        patientProfile,
        recentLogs,
      });

      res.json({ recommendation });
    } catch (error) {
      console.error("❌ AI recommendation error:", error);
      res.status(500).json({ error: error.message || "Failed to generate recommendation" });
    }
  }
);

// =========================
// AUDIO UPLOAD + ANALYSIS
// =========================

app.post(
  "/api/audio/upload",
  authenticateToken,
  upload.single("audio"),
  async (req, res) => {
    try {
      console.log("🎙️ Audio upload started");

      if (!req.file) {
        return res.status(400).json({
          error: "No audio file uploaded",
        });
      }

      const patientProfile =
        await prisma.patientProfile.findUnique({
          where: {
            userId: req.user.userId,
          },
        });

      if (!patientProfile) {
        return res.status(404).json({
          error: "Patient profile not found",
        });
      }

      const assignment =
        await prisma.exerciseAssignment.findFirst({
          where: {
            patientProfileId: patientProfile.id,
          },
          orderBy: {
            dueDate: "asc",
          },
        });

      if (!assignment) {
        return res.status(404).json({
          error: "No exercise assigned to this patient",
        });
      }

      const durationSeconds = Number(req.body.durationSeconds || 0);
      const pitchMeanHz = Number(req.body.pitchMeanHz || 0);
      const clarityScore = Number(req.body.clarityScore || 0);
      const pronunciationScore = Number(req.body.pronunciationScore || 0);

      const audioLog =
        await prisma.audioLog.create({
          data: {
            organizationId: patientProfile.organizationId,
            patientProfileId: patientProfile.id,
            exerciseId: assignment.exerciseId,
            s3Url: req.file.path,
            durationSeconds: durationSeconds,
            pitchMeanHz: pitchMeanHz,
            clarityScore: clarityScore,
            pronunciationScore: pronunciationScore,
            difficultyAtAttempt: patientProfile.currentDifficultyLevel,
          },
        });

      console.log("💾 AudioLog saved successfully:", audioLog.id);

      let newDifficulty = patientProfile.currentDifficultyLevel;

      if (pronunciationScore >= 85) {
        newDifficulty = Math.min(5, patientProfile.currentDifficultyLevel + 1);
      } else if (pronunciationScore < 60) {
        newDifficulty = Math.max(1, patientProfile.currentDifficultyLevel - 1);
      }

      if (newDifficulty !== patientProfile.currentDifficultyLevel) {
        await prisma.patientProfile.update({
          where: {
            id: patientProfile.id,
          },
          data: {
            currentDifficultyLevel: newDifficulty,
          },
        });

        console.log(
          "🎯 Difficulty adjusted:",
          patientProfile.currentDifficultyLevel,
          "→",
          newDifficulty
        );
      }

      // Auto-generate more exercises when the patient is running low on
      // incomplete ones, or right after their difficulty level changes.
      // This never blocks or fails the upload response — if AI generation
      // isn't configured or errors out, we just skip it.
      let autoGenerated = false;
      try {
        const incompleteCount = await prisma.exerciseAssignment.count({
          where: { patientProfileId: patientProfile.id, isCompleted: false },
        });
        const difficultyChanged = newDifficulty !== patientProfile.currentDifficultyLevel;

        if (anthropic && (incompleteCount < 2 || difficultyChanged)) {
          const recentLogs = await prisma.audioLog.findMany({
            where: { patientProfileId: patientProfile.id },
            orderBy: { recordedAt: "desc" },
            take: 5,
          });
          const generated = await generateExercisesForPatient({
            patientProfile: { ...patientProfile, currentDifficultyLevel: newDifficulty },
            recentLogs,
          });
          await createAndAssignExercises({
            generated,
            patientProfile,
            userId: req.user.userId,
          });
          autoGenerated = true;
          console.log("🤖 Auto-generated new exercises for patient", patientProfile.id);
        }
      } catch (genErr) {
        console.error("⚠️ Auto exercise generation skipped:", genErr.message);
      }

      res.json({
        message: "Speech analyzed and uploaded successfully!",
        filename: req.file.filename,
        path: req.file.path,
        audioLogId: audioLog.id,
        analysis: {
          durationSeconds: durationSeconds,
          pitchMeanHz: pitchMeanHz,
          clarityScore: clarityScore,
          pronunciationScore: pronunciationScore,
        },
        difficulty: {
          previous: patientProfile.currentDifficultyLevel,
          current: newDifficulty,
        },
        newExercisesGenerated: autoGenerated,
      });
    } catch (error) {
      console.error("❌ Audio upload error:", error);

      res.status(500).json({
        error: "Failed to upload and save audio",
      });
    }
  }
);

// =========================
// PATIENT AUDIO LOGS
// =========================

app.get(
  "/api/patients/:patientId/audio-logs",
  authenticateToken,
  async (req, res) => {
    try {
      const { patientId } = req.params;

      const patientProfile =
        await prisma.patientProfile.findUnique({
          where: {
            userId: patientId,
          },
        });

      if (!patientProfile) {
        return res.status(404).json({
          error: "Patient profile not found",
        });
      }

      const audioLogs =
        await prisma.audioLog.findMany({
          where: {
            patientProfileId: patientProfile.id,
          },
          include: {
            exercise: true,
          },
          orderBy: {
            recordedAt: "desc",
          },
        });

      res.json(audioLogs);
    } catch (error) {
      console.error("❌ Audio logs error:", error);

      res.status(500).json({
        error: "Failed to fetch audio logs",
      });
    }
  }
);

// =========================
// PATIENT DASHBOARD DATA
// =========================

app.get(
  "/api/patients/:patientId/dashboard",
  authenticateToken,
  async (req, res) => {
    try {
      const { patientId } = req.params;

      const patientProfile =
        await prisma.patientProfile.findUnique({
          where: {
            userId: patientId,
          },
        });

      if (!patientProfile) {
        return res.status(404).json({
          error: "Patient profile not found",
        });
      }

      const user =
        await prisma.user.findUnique({
          where: {
            id: patientId,
          },
          select: {
            id: true,
            fullName: true,
            email: true,
            role: true,
          },
        });

      const assignments =
        await prisma.exerciseAssignment.findMany({
          where: {
            patientProfileId: patientProfile.id,
          },
          include: {
            exercise: true,
          },
          orderBy: {
            dueDate: "asc",
          },
        });

      const audioLogs =
        await prisma.audioLog.findMany({
          where: {
            patientProfileId: patientProfile.id,
          },
          include: {
            exercise: true,
          },
          orderBy: {
            recordedAt: "desc",
          },
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
        audioLogs: audioLogs,
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

      res.status(500).json({
        error: "Failed to fetch patient dashboard",
      });
    }
  }
);

// =========================
// THERAPIST DASHBOARD
// =========================

app.get(
  "/api/therapist/dashboard",
  authenticateToken,
  async (req, res) => {
    try {
      if (req.user.role !== "THERAPIST") {
        return res.status(403).json({
          error: "Only therapists can access this dashboard",
        });
      }

      const patients =
        await prisma.user.findMany({
          where: {
            role: "PATIENT",
          },
          select: {
            id: true,
            fullName: true,
            email: true,
            organizationId: true,
            createdAt: true,
          },
          orderBy: {
            fullName: "asc",
          },
        });

      const patientsWithStats =
        await Promise.all(
          patients.map(async (patient) => {
            const profile =
              await prisma.patientProfile.findUnique({
                where: {
                  userId: patient.id,
                },
              });

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

            const exerciseCount =
              await prisma.exerciseAssignment.count({
                where: {
                  patientProfileId: profile.id,
                },
              });

            const audioLogCount =
              await prisma.audioLog.count({
                where: {
                  patientProfileId: profile.id,
                },
              });

            const latestAudio =
              await prisma.audioLog.findFirst({
                where: {
                  patientProfileId: profile.id,
                },
                orderBy: {
                  recordedAt: "desc",
                },
              });

            return {
              ...patient,
              currentDifficultyLevel: profile.currentDifficultyLevel,
              diagnosis: profile.primaryDiagnosis,
              exerciseCount: exerciseCount,
              audioLogCount: audioLogCount,
              latestPronunciationScore: latestAudio
                ? latestAudio.pronunciationScore
                : 0,
              latestClarityScore: latestAudio
                ? latestAudio.clarityScore
                : 0,
              latestPitchMeanHz: latestAudio
                ? latestAudio.pitchMeanHz
                : 0,
              latestRecordedAt: latestAudio
                ? latestAudio.recordedAt
                : null,
              totalPoints: profile.totalPoints,
              currentStreak: profile.currentStreak,
            };
          })
        );

      res.json({
        therapist: {
          id: req.user.userId,
          role: req.user.role,
        },
        totalPatients: patientsWithStats.length,
        patients: patientsWithStats,
      });
    } catch (error) {
      console.error("❌ Therapist dashboard error:", error);

      res.status(500).json({
        error: "Failed to load therapist dashboard",
      });
    }
  }
);

// =========================
// THERAPIST PATIENT DETAILS
// =========================

app.get(
  "/api/therapist/patients/:patientId",
  authenticateToken,
  async (req, res) => {
    try {
      if (req.user.role !== "THERAPIST") {
        return res.status(403).json({
          error: "Only therapists can access patient details",
        });
      }

      const { patientId } = req.params;

      const patient =
        await prisma.user.findUnique({
          where: {
            id: patientId,
          },
          select: {
            id: true,
            fullName: true,
            email: true,
            role: true,
            organizationId: true,
            createdAt: true,
          },
        });

      if (!patient) {
        return res.status(404).json({
          error: "Patient not found",
        });
      }

      const profile =
        await prisma.patientProfile.findUnique({
          where: {
            userId: patientId,
          },
        });

      if (!profile) {
        return res.status(404).json({
          error: "Patient profile not found",
        });
      }

      const exercises =
        await prisma.exerciseAssignment.findMany({
          where: {
            patientProfileId: profile.id,
          },
          include: {
            exercise: true,
          },
          orderBy: {
            dueDate: "asc",
          },
        });

      const audioLogs =
        await prisma.audioLog.findMany({
          where: {
            patientProfileId: profile.id,
          },
          include: {
            exercise: true,
          },
          orderBy: {
            recordedAt: "desc",
          },
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

      res.status(500).json({
        error: "Failed to fetch patient details",
      });
    }
  }
);

// =========================
// CAREGIVER FEEDBACK
// =========================

app.get(
  "/api/patients/:patientId/feedback",
  authenticateToken,
  async (req, res) => {
    try {
      const { patientId } = req.params;

      const profile =
        await prisma.patientProfile.findUnique({
          where: {
            userId: patientId,
          },
        });

      if (!profile) {
        return res.status(404).json({
          error: "Patient profile not found",
        });
      }

      const feedback =
        await prisma.caregiverFeedback.findMany({
          where: {
            patientProfileId: profile.id,
          },
          orderBy: {
            createdAt: "desc",
          },
        });

      res.json(feedback);
    } catch (error) {
      console.error("❌ Feedback error:", error);

      res.status(500).json({
        error: "Failed to fetch caregiver feedback",
      });
    }
  }
);

// Submit remote feedback — previously there was no way for a caregiver (or
// therapist) to actually WRITE feedback, only read it back. This is the
// missing half of "Caregiver Collaboration" from the problem statement.
app.post(
  "/api/patients/:patientId/feedback",
  authenticateToken,
  async (req, res) => {
    try {
      if (!["CAREGIVER", "THERAPIST"].includes(req.user.role)) {
        return res.status(403).json({
          error: "Only caregivers or therapists can submit feedback",
        });
      }

      const { patientId } = req.params;
      const { feedbackText, moodRating } = req.body;

      if (!feedbackText || !String(feedbackText).trim()) {
        return res.status(400).json({ error: "Feedback text is required" });
      }

      const rating = Number(moodRating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return res
          .status(400)
          .json({ error: "Mood rating must be a whole number between 1 and 5" });
      }

      const profile = await prisma.patientProfile.findUnique({
        where: { userId: patientId },
      });
      if (!profile) {
        return res.status(404).json({ error: "Patient profile not found" });
      }

      const feedback = await prisma.caregiverFeedback.create({
        data: {
          organizationId: profile.organizationId,
          patientProfileId: profile.id,
          caregiverId: req.user.userId,
          feedbackText: String(feedbackText).trim(),
          moodRating: rating,
        },
      });

      res.status(201).json(feedback);
    } catch (error) {
      console.error("❌ Feedback submit error:", error);
      res.status(500).json({ error: "Failed to submit feedback" });
    }
  }
);

// =========================
// START SERVER
// =========================

app.listen(PORT, () => {
  console.log(`🚀 Swar Saathi backend running on port ${PORT}`);
});