import {
  PrismaClient,
  Role,
  ExerciseCategory,
  CaregiverRelationship,
} from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Starting database seed...");

  // 1. Clean existing data
  // Delete in dependency order so foreign-key constraints are respected.
  await prisma.caregiverFeedback.deleteMany();
  await prisma.audioLog.deleteMany();
  await prisma.exerciseAssignment.deleteMany();
  await prisma.patientCaregiver.deleteMany();
  await prisma.patientTherapist.deleteMany();
  await prisma.patientProfile.deleteMany();
  await prisma.exercise.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();

  console.log("🧹 Existing data cleaned.");

  // 2. Create Demo Organization
  const organization = await prisma.organization.create({
    data: {
      name: "Hope Speech Therapy NGO",
      slug: "hope-speech-ngo",
      country: "India",
    },
  });

  console.log("🏢 Organization created.");

  // 3. Create password hash
  const passwordHash = await bcrypt.hash("Password123!", 12);

  // 4. Create Therapist
  const therapist = await prisma.user.create({
    data: {
      organizationId: organization.id,
      email: "therapist@hopespeech.org",
      fullName: "Dr. Ananya Sharma",
      passwordHash,
      role: Role.THERAPIST,
    },
  });

  // 5. Create Caregiver
  const caregiver = await prisma.user.create({
    data: {
      organizationId: organization.id,
      email: "parent@hopespeech.org",
      fullName: "Rajesh Kumar",
      passwordHash,
      role: Role.CAREGIVER,
    },
  });

  // 6. Create Patient
  const patient = await prisma.user.create({
    data: {
      organizationId: organization.id,
      email: "patient.aarav@hopespeech.org",
      fullName: "Aarav Kumar",
      passwordHash,
      role: Role.PATIENT,
    },
  });

  console.log("👥 Users created.");

  // 7. Create Patient Profile
  const patientProfile = await prisma.patientProfile.create({
    data: {
      organizationId: organization.id,
      userId: patient.id,
      dateOfBirth: new Date("2017-05-14"),
      primaryDiagnosis:
        "Articulation Disorder (Phoneme /s/ and /r/ delay)",
      clinicalNotes:
        "Patient responds well to visual gamified cues.",
      currentDifficultyLevel: 2,
    },
  });

  console.log("🧑‍🦽 Patient profile created.");

  // 8. Connect Patient with Therapist
  await prisma.patientTherapist.create({
    data: {
      patientProfileId: patientProfile.id,
      therapistId: therapist.id,
      isPrimary: true,
    },
  });

  // 9. Connect Patient with Caregiver
  await prisma.patientCaregiver.create({
    data: {
      patientProfileId: patientProfile.id,
      caregiverId: caregiver.id,
      relationship: CaregiverRelationship.PARENT,
    },
  });

  console.log("🔗 Patient relationships created.");

  // 10. Create Exercise
  const exercise = await prisma.exercise.create({
    data: {
      organizationId: organization.id,
      createdById: therapist.id,
      title: "Snake Sounds (S Phoneme)",
      description: "Practice holding the 'S' sound continuously.",
      category: ExerciseCategory.ARTICULATION,
      difficultyLevel: 1,
      targetPhonemes: ["s", "z"],
      instructions:
        "Hiss like a snake for 5 seconds into the microphone!",
      gamePointsValue: 20,
    },
  });

  console.log("🎯 Exercise created.");

  // 11. Assign Exercise to Patient
  await prisma.exerciseAssignment.create({
    data: {
      organizationId: organization.id,
      patientProfileId: patientProfile.id,
      exerciseId: exercise.id,
      assignedById: therapist.id,
      isCompleted: false,
      dueDate: new Date(Date.now() + 86400000 * 3),
    },
  });

  console.log("📋 Exercise assigned.");

  // 12. Create Sample Audio Logs
  const pastDays = [7, 5, 3, 1];

  const sampleScores = [
    {
      pitch: 180,
      clarity: 65,
      pronunciation: 60,
    },
    {
      pitch: 185,
      clarity: 72,
      pronunciation: 70,
    },
    {
      pitch: 190,
      clarity: 78,
      pronunciation: 76,
    },
    {
      pitch: 192,
      clarity: 85,
      pronunciation: 82,
    },
  ];

  for (let i = 0; i < pastDays.length; i++) {
    const recordedAt = new Date(
      Date.now() - 86400000 * pastDays[i]
    );

    await prisma.audioLog.create({
      data: {
        organizationId: organization.id,
        patientProfileId: patientProfile.id,
        exerciseId: exercise.id,
        s3Url:
          "https://example-bucket.s3.amazonaws.com/demo-audio.wav",
        durationSeconds: 4.5,
        pitchMeanHz: sampleScores[i].pitch,
        clarityScore: sampleScores[i].clarity,
        pronunciationScore: sampleScores[i].pronunciation,
        difficultyAtAttempt: 2,
        recordedAt,
      },
    });
  }

  console.log("🎙️ Sample audio logs created.");

  // 13. Create Caregiver Feedback
  await prisma.caregiverFeedback.create({
    data: {
      organizationId: organization.id,
      patientProfileId: patientProfile.id,
      caregiverId: caregiver.id,
      feedbackText:
        "Aarav enjoyed the snake sound exercise today!",
      moodRating: 5,
    },
  });

  console.log("💬 Caregiver feedback created.");

  console.log("====================================");
  console.log("✅ Database successfully seeded!");
  console.log("====================================");
}

main()
  .catch((error) => {
    console.error("❌ Seeding failed:");
    console.error(error);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });