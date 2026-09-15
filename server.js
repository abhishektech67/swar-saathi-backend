const express = require("express");
const cors = require("cors");
const { PrismaClient } = require("@prisma/client");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

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

// =========================
// CORS
// =========================

const allowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://swar-saathi.netlify.app",
];

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin
      // (Postman, server-to-server requests, etc.)
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.log("⚠️ Blocked CORS origin:", origin);
      return callback(new Error("Not allowed by CORS"));
    },
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
// AUDIO UPLOAD + ANALYSIS
// =========================

app.post(
  "/api/audio/upload",
  authenticateToken,
  upload.single("audio"),
  async (req, res) => {
    try {
      console.log("🎙️ Audio upload started");

      // -------------------------
      // CHECK FILE
      // -------------------------

      if (!req.file) {
        return res.status(400).json({
          error: "No audio file uploaded",
        });
      }

      console.log("🎙️ Audio received:", req.file);
      console.log("🎵 Audio MIME type:", req.file.mimetype);

      console.log(
        "👤 Logged in user ID:",
        req.user.userId
      );

      console.log(
        "👤 Logged in role:",
        req.user.role
      );

      // -------------------------
      // GET PATIENT PROFILE
      // -------------------------

      const patientProfile =
        await prisma.patientProfile.findUnique({
          where: {
            userId: req.user.userId,
          },
        });

      if (!patientProfile) {
        console.log(
          "❌ Patient profile not found for user:",
          req.user.userId
        );

        return res.status(404).json({
          error: "Patient profile not found",
        });
      }

      console.log(
        "✅ Patient profile found:",
        patientProfile.id
      );

      // -------------------------
      // GET ASSIGNED EXERCISE
      // -------------------------

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

      console.log(
        "✅ Exercise assignment found:",
        assignment.id
      );

      // -------------------------
      // GET ANALYSIS VALUES
      // -------------------------

      const durationSeconds = Number(
        req.body.durationSeconds || 0
      );

      const pitchMeanHz = Number(
        req.body.pitchMeanHz || 0
      );

      const clarityScore = Number(
        req.body.clarityScore || 0
      );

      const pronunciationScore = Number(
        req.body.pronunciationScore || 0
      );

      console.log("📊 Analysis received:");

      console.log(
        "Duration:",
        durationSeconds,
        "seconds"
      );

      console.log(
        "Pitch:",
        pitchMeanHz,
        "Hz"
      );

      console.log(
        "Clarity:",
        clarityScore,
        "%"
      );

      console.log(
        "Pronunciation:",
        pronunciationScore,
        "%"
      );

      // -------------------------
      // SAVE AUDIO LOG
      // -------------------------

      const audioLog =
        await prisma.audioLog.create({
          data: {
            organizationId:
              patientProfile.organizationId,

            patientProfileId:
              patientProfile.id,

            exerciseId:
              assignment.exerciseId,

            s3Url:
              req.file.path,

            durationSeconds:
              durationSeconds,

            pitchMeanHz:
              pitchMeanHz,

            clarityScore:
              clarityScore,

            pronunciationScore:
              pronunciationScore,

            difficultyAtAttempt:
              patientProfile.currentDifficultyLevel,
          },
        });

      console.log(
        "💾 AudioLog saved successfully:",
        audioLog.id
      );

      // -------------------------
      // DYNAMIC DIFFICULTY
      // -------------------------

      let newDifficulty =
        patientProfile.currentDifficultyLevel;

      if (pronunciationScore >= 85) {
        newDifficulty = Math.min(
          5,
          patientProfile.currentDifficultyLevel + 1
        );
      } else if (pronunciationScore < 60) {
        newDifficulty = Math.max(
          1,
          patientProfile.currentDifficultyLevel - 1
        );
      }

      if (
        newDifficulty !==
        patientProfile.currentDifficultyLevel
      ) {
        await prisma.patientProfile.update({
          where: {
            id: patientProfile.id,
          },
          data: {
            currentDifficultyLevel:
              newDifficulty,
          },
        });

        console.log(
          "🎯 Difficulty adjusted:",
          patientProfile.currentDifficultyLevel,
          "→",
          newDifficulty
        );
      }

      // -------------------------
      // RESPONSE
      // -------------------------

      res.json({
        message:
          "Speech analyzed and uploaded successfully!",

        filename:
          req.file.filename,

        path:
          req.file.path,

        audioLogId:
          audioLog.id,

        analysis: {
          durationSeconds:
            durationSeconds,

          pitchMeanHz:
            pitchMeanHz,

          clarityScore:
            clarityScore,

          pronunciationScore:
            pronunciationScore,
        },

        difficulty: {
          previous:
            patientProfile.currentDifficultyLevel,

          current:
            newDifficulty,
        },
      });
    } catch (error) {
      console.error(
        "❌ Audio upload error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to upload and save audio",
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
            patientProfileId:
              patientProfile.id,
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
      console.error(
        "❌ Audio logs error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to fetch audio logs",
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
            patientProfileId:
              patientProfile.id,
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
            patientProfileId:
              patientProfile.id,
          },
          include: {
            exercise: true,
          },
          orderBy: {
            recordedAt: "desc",
          },
        });

      const latestAudio =
        audioLogs.length > 0
          ? audioLogs[0]
          : null;

      res.json({
        patient: user,

        profile: {
          id: patientProfile.id,

          currentDifficultyLevel:
            patientProfile.currentDifficultyLevel,

          diagnosis:
            patientProfile.diagnosis,

          dateOfBirth:
            patientProfile.dateOfBirth,
        },

        exercises:
          assignments,

        audioLogs:
          audioLogs,

        latestAnalysis:
          latestAudio
            ? {
                durationSeconds:
                  latestAudio.durationSeconds,

                pitchMeanHz:
                  latestAudio.pitchMeanHz,

                clarityScore:
                  latestAudio.clarityScore,

                pronunciationScore:
                  latestAudio.pronunciationScore,

                difficultyAtAttempt:
                  latestAudio.difficultyAtAttempt,

                recordedAt:
                  latestAudio.recordedAt,
              }
            : null,
      });
    } catch (error) {
      console.error(
        "❌ Dashboard error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to fetch patient dashboard",
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
          error:
            "Only therapists can access this dashboard",
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

                currentDifficultyLevel:
                  0,

                exerciseCount:
                  0,

                audioLogCount:
                  0,

                latestPronunciationScore:
                  0,

                latestClarityScore:
                  0,

                latestPitchMeanHz:
                  0,
              };
            }

            const exerciseCount =
              await prisma.exerciseAssignment.count({
                where: {
                  patientProfileId:
                    profile.id,
                },
              });

            const audioLogCount =
              await prisma.audioLog.count({
                where: {
                  patientProfileId:
                    profile.id,
                },
              });

            const latestAudio =
              await prisma.audioLog.findFirst({
                where: {
                  patientProfileId:
                    profile.id,
                },
                orderBy: {
                  recordedAt: "desc",
                },
              });

            return {
              ...patient,

              currentDifficultyLevel:
                profile.currentDifficultyLevel,

              diagnosis:
                profile.diagnosis,

              exerciseCount:
                exerciseCount,

              audioLogCount:
                audioLogCount,

              latestPronunciationScore:
                latestAudio
                  ? latestAudio.pronunciationScore
                  : 0,

              latestClarityScore:
                latestAudio
                  ? latestAudio.clarityScore
                  : 0,

              latestPitchMeanHz:
                latestAudio
                  ? latestAudio.pitchMeanHz
                  : 0,

              latestRecordedAt:
                latestAudio
                  ? latestAudio.recordedAt
                  : null,
            };
          })
        );

      res.json({
        therapist: {
          id: req.user.userId,
          role: req.user.role,
        },

        totalPatients:
          patientsWithStats.length,

        patients:
          patientsWithStats,
      });
    } catch (error) {
      console.error(
        "❌ Therapist dashboard error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to load therapist dashboard",
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
          error:
            "Only therapists can access patient details",
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
            patientProfileId:
              profile.id,
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
            patientProfileId:
              profile.id,
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

        profile,

        exercises,

        audioLogs,
      });
    } catch (error) {
      console.error(
        "❌ Therapist patient error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to fetch patient details",
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
            patientProfileId:
              profile.id,
          },
          orderBy: {
            createdAt: "desc",
          },
        });

      res.json(feedback);
    } catch (error) {
      console.error(
        "❌ Feedback error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to fetch caregiver feedback",
      });
    }
  }
);

// =========================
// START SERVER
// =========================

app.listen(PORT, () => {
  console.log(
    `🚀 Swar Saathi backend running on port ${PORT}`
  );
});